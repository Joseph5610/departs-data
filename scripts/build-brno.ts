import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import type AdmZip from 'adm-zip';
import type { DepartureExtras, FeederRow, ParentChildMap, RouteInfo, ShapeGeometry, StopFeature, TripConnection, TripStop } from './lib/contract.ts';
import { nightFlag, STOP_TIMES_DIR, toTripRuns, TRIP_ALIAS_RUNS_FILE } from './lib/contract.ts';
import { fetchZip, readTable } from './lib/feed.ts';
import { getServiceDays, timeToOffsetMs, type ServiceDay } from './lib/time.ts';
import { distanceToLinesM, fanOutColocated } from './lib/geo.ts';
import { buildDepartures, gtfsBoardings, gtfsTripStop, gtfsWindow, readGtfsTimetable, tripWindows, writeDepartures, writeTrips, type ActiveTrip, type Boarding } from './lib/timetable.ts';
import { readHeldConnections, tripStopKey } from './lib/connections.ts';
import { buildStopTimeSlices } from './lib/stop-times.ts';
import { linesOf, outputDir, safetyCheck, writeChunks, writeCityFiles, writeFeedIndex } from './lib/emit.ts';
import { readStops } from './lib/stops.ts';
import { writeShapeBuckets } from './lib/shapes.ts';
import { buildNetwork, writeNetwork, type NetworkMode } from './lib/network.ts';
import { stableStationIds, withStationIds } from './lib/station-ids.ts';

/**
 * Brno (IDS JMK / KORDIS) static GTFS build.
 *
 * Emits the file set the departs-app GtfsAdapter reads, plus two Brno-only extras: trip aliases,
 * which carry trip ids forward across GTFS exports because the KORDIS realtime feed lags behind,
 * and shape geometry fetched from the Lissy API since the feed ships none.
 */
const CONFIG = {
    CITY: 'brno',
    /** Published station id: the KORDIS node (`U1271`), as the `N…` part of `U1271N2879` is renumbered by re-exports. */
    STATION_ID: (feedId: string): string => /^(U\d+)N\d+$/.exec(feedId)?.[1] ?? feedId,
    TIMEZONE: 'Europe/Prague',
    GTFS_URL: 'https://kordis-jmk.cz/gtfs/gtfs.zip',
    SHAPES_URL: 'https://dexter.fit.vutbr.cz/lissy/api/shapes/getTodayShapes',

    /** Today and tomorrow: the rolling 48h window of departures the app serves. */
    DAY_OFFSETS: [0, 1],

    /** Radial separation for platforms sharing exact coordinates (~12 m). */
    COLOCATED_OFFSET_DEG: 0.00012,
    /** Trip-id range fetched per Lissy request. */
    SHAPE_BATCH_SIZE: 5000,
    /** A stop counts as on a shape within this distance. */
    SHAPE_STOP_RADIUS_M: 150,
    /** Share of a trip's stops that must lie on a shape before the shape is attached to it. */
    MIN_SHAPE_FIT: 0.9,
    /** Drawn on the map at all times: the tram tracks as one network, about 70 km. */
    NETWORK_MODES: [{ routeTypes: ['0'], style: 'merged', minKm: 40 }] satisfies NetworkMode[],
    DEFAULT_ROUTE_COLOR: '#007DA8',
    /** Night lines are numbered N<digit> (N89, N99). */
    NIGHT_LINE: /^N\d/,
    /** KORDIS run identifier per trip, the only id stable across exports. */
    COURSE_FILE: 'trip_courses.json',
    /**
     * Exports kept in that file, so the feed can lag without losing the mapping. Build state only -
     * the Worker never fetches it, it is read by the next build from the published data.
     */
    COURSE_GENERATIONS: 2,

    /** Connections held for less than this are planned only and not emitted. */
    MIN_CONNECTION_WAIT_S: 1,

    /** Abort thresholds guarding against an empty or truncated upstream feed. */
    MIN_DEPARTURE_STOPS: 1000,
    MIN_ACTIVE_TRIPS: 5000,
} as const;

const DATA_DIR = outputDir(CONFIG.CITY);

/** Columns this build depends on; anything absent aborts at the header rather than downstream. */
const TABLES = {
    routes: { required: ['route_id', 'route_type', 'route_short_name'], optional: ['route_color'] },
} as const;


interface LissyShape { shape_id: string | number; shape: unknown; gtfs_trips: (string | number)[] }

function fetchShapes(token: string, from: number, to: number): Promise<LissyShape[]> {
    return new Promise((resolve, reject) => {
        const url = `${CONFIG.SHAPES_URL}?gtfs_trips_from=${from}&gtfs_trips_to=${to}&switchCoords=true&reduceCoords=true`;
        https.get(url, { headers: { Authorization: token } }, (res) => {
            let data = '';
            res.on('data', chunk => { data += chunk; });
            res.on('end', () => {
                try { resolve(JSON.parse(data) as LissyShape[]); }
                catch (e) { reject(e as Error); }
            });
        }).on('error', reject);
    });
}

/** `api.txt` maps each trip to its KORDIS run: `Linka/CVlaku = trip_id: 78/1052 = 35274`. */
function readCourses(zip: AdmZip): Map<string, string> {
    const entry = zip.getEntry('api.txt');
    const out = new Map<string, string>();
    if (!entry) {
        console.warn('api.txt not found in GTFS zip; realtime trip matching will degrade.');
        return out;
    }
    const buf = entry.getData();
    const isUtf16Le = (buf[0] === 0xFF && buf[1] === 0xFE) || (buf.length > 2 && buf[1] === 0 && buf[3] === 0);
    for (const line of (isUtf16Le ? buf.toString('utf16le') : buf.toString('utf8')).split('\n')) {
        const m = line.match(/:\s*([^/]+)\/([^=\s]+)\s*=\s*(\d+)/);
        if (m) out.set(m[3]!.trim(), `${m[1]!.trim()}/${m[2]!.trim()}`);
    }
    return out;
}

/**
 * Maps the trip ids the realtime feed still broadcasts onto the current export's ids.
 *
 * KORDIS renumbers effectively every trip on each export (measured: 0 of 29,544 carried-over runs
 * kept their id) while the feed keeps sending the previous numbering, so the run id from `api.txt`
 * is the only usable key. The previous export's map has to be carried forward because the old zip
 * is no longer downloadable once KORDIS replaces it.
 *
 * Only real mappings are emitted: a null would make the app discard that vehicle entirely.
 * Returns the map so other steps can translate ids from the same stale export.
 */
function generateAliases(
    dataDir: string,
    courseOf: Map<string, string>,
    activeTrips: ReadonlyMap<string, ActiveTrip>,
    todayStr: string,
): Record<string, string> {
    const coursePath = path.join(dataDir, CONFIG.COURSE_FILE);
    const stored: unknown = fs.existsSync(coursePath) ? JSON.parse(fs.readFileSync(coursePath, 'utf8')) : null;
    // Older builds wrote a bare map; treat it as a single generation.
    const previousGenerations: Record<string, string>[] = Array.isArray(stored)
        ? stored as Record<string, string>[]
        : (stored ? [stored as Record<string, string>] : []);

    // The file also holds the generation this build is reproducing; decoding with it would map every
    // id onto itself and leave a lagging feed pointing at the wrong trip.
    const current = Object.fromEntries(courseOf);
    const currentKey = JSON.stringify(current);
    const olderGenerations = previousGenerations.filter(g => JSON.stringify(g) !== currentKey);

    // An id may carry a different run in each generation; the newest reading that still redirects wins.
    const knownCourses = new Map<string, string[]>();
    for (const generation of olderGenerations) {
        for (const [tripId, course] of Object.entries(generation)) {
            let list = knownCourses.get(tripId);
            if (!list) { list = []; knownCourses.set(tripId, list); }
            if (!list.includes(course)) list.push(course);
        }
    }

    // Prefer the trip running today where a run has variants across service days.
    const currentByCourse = new Map<string, string>();
    for (const tripId of activeTrips.keys()) {
        const course = courseOf.get(tripId);
        if (!course) continue;
        const runsToday = activeTrips.get(tripId)!.dates.some(d => d.str === todayStr);
        if (runsToday || !currentByCourse.has(course)) currentByCourse.set(course, tripId);
    }

    // Prefer the reading that actually redirects: one resolving to the id itself is the current
    // export's own meaning and would leave a lagging feed pointing at the wrong trip.
    const tripAliases: Record<string, string> = {};
    for (const [legacyTripId, courses] of knownCourses) {
        for (const course of courses) {
            const current = currentByCourse.get(course);
            if (current && current !== legacyTripId) { tripAliases[legacyTripId] = current; break; }
        }
    }

    const generations = [current, ...olderGenerations].slice(0, CONFIG.COURSE_GENERATIONS);

    writeFeedIndex(dataDir, TRIP_ALIAS_RUNS_FILE, toTripRuns(tripAliases));
    fs.writeFileSync(coursePath, JSON.stringify(generations));
    console.log(`Mapped ${Object.keys(tripAliases).length} legacy trip ids onto current trips via ${currentByCourse.size} runs (${generations.length} export generations retained).`);

    // The signature-based state this replaces is no longer read by anything.
    fs.rmSync(path.join(dataDir, 'previous_trips.json'), { force: true });
    return tripAliases;
}

async function main(): Promise<void> {
    console.log(`[${CONFIG.CITY}] Starting GTFS preprocess...`);
    fs.mkdirSync(DATA_DIR, { recursive: true });

    const zip: AdmZip = await fetchZip(CONFIG.GTFS_URL, 'GTFS_ZIP');

    // --- ROUTES ---
    const routes = new Map<string, RouteInfo>();
    for (const r of readTable(zip, 'routes.txt', TABLES.routes)) {
        routes.set(r.route_id, {
            name: r.route_short_name,
            type: r.route_type,
            route_color: r.route_color ? `#${r.route_color}` : CONFIG.DEFAULT_ROUTE_COLOR,
            ...nightFlag(CONFIG.NIGHT_LINE.test(r.route_short_name)),
        });
    }

    // --- TIMETABLE ---
    const days = getServiceDays(CONFIG.TIMEZONE, CONFIG.DAY_OFFSETS);
    /** Scheduled times at the stops that take part in a connection, active trip or not. */
    const connectionTimes = new Map<string, { arrival: string; departure: string }>();
    let connections: ReturnType<typeof readHeldConnections> | null = null;
    const timetable = readGtfsTimetable(zip, days, {
        onStopTime: (tripId, st) => {
            const key = tripStopKey(tripId, st.stop_id);
            if (connections && (connections.outgoing.has(key) || connections.incoming.has(key))) {
                connectionTimes.set(key, { arrival: st.arrival_time || st.departure_time, departure: st.departure_time || st.arrival_time });
            }
        },
        beforeStopTimes: (active) => { connections = readHeldConnections(zip, tripId => active.has(tripId), CONFIG.MIN_CONNECTION_WAIT_S); },
    });
    const { activeTrips, calls: tripsData, stopRoutes } = timetable;
    const { outgoing, incoming } = connections!;
    console.log(`Found ${activeTrips.size} active trips for next 48h`);

    const courseOf = readCourses(zip);

    // --- STOPS ---
    const stops = readStops(zip);

    // Physical stops where passengers can actually board; the rest are drop-off only.
    const validPhysicalStopIds = new Set<string>();
    for (const s of stops) {
        if (s.location_type !== 0) continue;
        if ((stopRoutes.get(s.stop_id)?.size ?? 0) > 0) validPhysicalStopIds.add(s.stop_id);
    }

    const features: StopFeature[] = [];
    const validStopIds = new Set<string>();

    for (const s of stops) {
        if (s.lat === null || s.lon === null) continue;

        // Physical stops (0), stations (1) and entrances (2).
        const type = s.location_type;
        if (type !== 0 && type !== 1 && type !== 2) continue;

        const isDropOffOnly = type === 0 && !validPhysicalStopIds.has(s.stop_id);
        features.push({
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [s.lon, s.lat] },
            properties: {
                stop_id: s.stop_id,
                stop_name: s.stop_name,
                platform_code: s.platform_code,
                location_type: type as 0 | 1 | 2,
                parent_station: s.parent_station,
                zone_id: s.zone_id,
                is_drop_off_only: isDropOffOnly || undefined,
                lines: linesOf(stopRoutes.get(s.stop_id), routes),
            },
        });
        validStopIds.add(s.stop_id);
    }

    const platformFeatures = features.filter(f => f.properties.location_type === 0);
    const fanned = fanOutColocated(platformFeatures.map(f => ({ lon: f.geometry.coordinates[0], lat: f.geometry.coordinates[1] })), CONFIG.COLOCATED_OFFSET_DEG);
    let offsetCount = 0;
    platformFeatures.forEach((f, i) => {
        if (f.geometry.coordinates[0] !== fanned[i]![0] || f.geometry.coordinates[1] !== fanned[i]![1]) offsetCount++;
        f.geometry.coordinates = fanned[i]!;
    });
    console.log(`Applied radial micro-offsets to ${offsetCount} co-located platform stops.`);

    const parentChildMap: ParentChildMap = {};
    for (const s of stops) {
        if (s.parent_station && validStopIds.has(s.stop_id) && validStopIds.has(s.parent_station)) {
            (parentChildMap[s.parent_station] ??= []).push(s.stop_id);
        }
    }

    const tripRoutes: Record<string, string> = {};
    for (const [tripId, t] of activeTrips) tripRoutes[tripId] = t.routeId;

    const windowsFile = tripWindows([...tripsData].map(([tripId, calls]) => [tripId, gtfsWindow(activeTrips.get(tripId)!, calls)]), days);

    // --- SAFETY CHECK ---
    // A connection lists every calendar variant of the feeder run; keep the one running that day.
    const feedersOf = (b: Boarding, day: ServiceDay): DepartureExtras | undefined => {
        const held = incoming.get(tripStopKey(b.tripId, b.stopId));
        if (!held) return undefined;
        const feeders: FeederRow[] = [];
        const seenRuns = new Set<string>();
        for (const c of held) {
            const feeder = activeTrips.get(c.fromTrip)!;
            const arrival = connectionTimes.get(tripStopKey(c.fromTrip, c.fromStop))?.arrival;
            if (!arrival || !feeder.dates.includes(day)) continue;
            const run = courseOf.get(c.fromTrip) ?? c.fromTrip;
            if (seenRuns.has(run)) continue;
            seenRuns.add(run);
            feeders.push([c.fromTrip, feeder.routeId, day.midnight + timeToOffsetMs(arrival), c.minTransferS, c.maxWaitS]);
        }
        if (feeders.length === 0) return undefined;
        feeders.sort((x, y) => x[2] - y[2]);
        return { feeders };
    };
    const departuresByStop = buildDepartures(gtfsBoardings(timetable), tripId => activeTrips.get(tripId)!, feedersOf);

    safetyCheck(departuresByStop.size, tripsData.size, CONFIG.MIN_DEPARTURE_STOPS, CONFIG.MIN_ACTIVE_TRIPS);

    const stationIds = stableStationIds(parentChildMap, CONFIG.STATION_ID);
    const servedParentChildMap = withStationIds(parentChildMap, stationIds);
    writeCityFiles(DATA_DIR, { features, stationIds, routes, tripRoutes, tripWindows: windowsFile, stopRoutes, tripCalls: [...tripsData.values()].map(calls => calls.map(call => call.stopId)) });
    console.log(`Wrote ${features.length} stops`);

    const tripAliases = generateAliases(DATA_DIR, courseOf, activeTrips, days[0]!.str);

    writeDepartures(DATA_DIR, departuresByStop, servedParentChildMap);

    // --- TRIPS ---
    const stopNodes = new Map(features.map(f => [f.properties.stop_id, {
        name: f.properties.stop_name,
        lon: f.geometry.coordinates[0],
        lat: f.geometry.coordinates[1],
        zone_id: f.properties.zone_id,
    }]));

    const connectionsAt = (tripId: string, stopId: string): TripConnection[] | undefined => {
        const list = outgoing.get(tripStopKey(tripId, stopId));
        if (!list) return undefined;
        const out: TripConnection[] = [];
        for (const c of list) {
            const departure = connectionTimes.get(tripStopKey(c.toTrip, c.toStop))?.departure;
            const onward = activeTrips.get(c.toTrip)!;
            if (departure) out.push([c.toTrip, onward.routeId, onward.headsign, departure, c.minTransferS, c.maxWaitS]);
        }
        out.sort((a, b) => timeToOffsetMs(a[3]) - timeToOffsetMs(b[3]));
        return out.length > 0 ? out : undefined;
    };

    let tripConnections = 0;
    const tripStops = new Map<string, TripStop[]>();
    for (const [tripId, calls] of tripsData) {
        tripStops.set(tripId, calls.map((call): TripStop => {
            const connections = connectionsAt(tripId, call.stopId);
            if (connections) tripConnections += connections.length;
            return gtfsTripStop(call, stopNodes.get(call.stopId), connections ? { connections } : {});
        }));
    }
    console.log(`Attached ${tripConnections} onward connections to trip stops`);
    writeTrips(DATA_DIR, tripStops, windowsFile, tripRoutes);

    // The realtime feed reports no delay; the app estimates it from these and the vehicle positions.
    const stopTimeSlices = buildStopTimeSlices(tripStops, windowsFile);
    const largestSlice = writeChunks(path.join(DATA_DIR, STOP_TIMES_DIR), stopTimeSlices);
    console.log(`Wrote ${stopTimeSlices.size} stop time slices, largest ${(largestSlice / 1024).toFixed(0)}KB`);

    // --- SHAPES: the feed ships none, so geometry comes from the Lissy API ---
    const shapeToken = process.env.LISSY_API_TOKEN;
    if (!shapeToken) {
        console.warn('LISSY_API_TOKEN not set, skipping shape generation.');
    } else {
        try {
            const tripShapes: Record<string, string> = {};
            const tripShapeFit = new Map<string, number>();
            const allShapes = new Map<string, ShapeGeometry>();
            let rejected = 0;

            const shapeFit = (lines: [number, number][][], tripId: string): number => {
                const calls = tripsData.get(tripId);
                if (!calls || calls.length === 0) return 0;
                let on = 0;
                for (const call of calls) {
                    const node = stopNodes.get(call.stopId);
                    if (node && distanceToLinesM(node, lines) <= CONFIG.SHAPE_STOP_RADIUS_M) on++;
                }
                return on / calls.length;
            };

            // Lissy may number trips by any retained export, so the range spans the legacy ids too.
            let maxTripId = 0;
            for (const tripId of [...activeTrips.keys(), ...Object.keys(tripAliases)]) {
                const numId = parseInt(tripId, 10);
                if (!isNaN(numId) && numId > maxTripId) maxTripId = numId;
            }

            for (let i = 0; i <= maxTripId; i += CONFIG.SHAPE_BATCH_SIZE) {
                console.log(`Fetching shapes from offset ${i} to ${i + CONFIG.SHAPE_BATCH_SIZE}...`);
                const res = await fetchShapes(shapeToken, i, i + CONFIG.SHAPE_BATCH_SIZE);
                if (!Array.isArray(res)) continue;

                for (const item of res) {
                    const shapeIdStr = String(item.shape_id);
                    allShapes.set(shapeIdStr, item.shape as ShapeGeometry);
                    const lines = item.shape as [number, number][][];
                    // Lissy's trip ids come from its own GTFS copy, which may or may not lag this export,
                    // and ids are recycled - so every reading that fits the geometry takes it; same-route
                    // trips fit equally, so picking one reading would starve the other.
                    for (const rawTripId of item.gtfs_trips) {
                        const raw = String(rawTripId);
                        const alias = tripAliases[raw];
                        let matched = false;
                        for (const candidate of alias && alias !== raw ? [raw, alias] : [raw]) {
                            if (!activeTrips.has(candidate)) continue;
                            const fit = shapeFit(lines, candidate);
                            if (fit < CONFIG.MIN_SHAPE_FIT) continue;
                            matched = true;
                            if (fit > (tripShapeFit.get(candidate) ?? 0)) {
                                tripShapeFit.set(candidate, fit);
                                tripShapes[candidate] = shapeIdStr;
                            }
                        }
                        if (!matched) rejected++;
                    }
                }
            }

            // Buckets are derivable from the shape_id on both sides, so no index file is needed and
            // adding a shape only rewrites its own bucket. 'stale' pruning keeps the rest untouched.
            const largestBucket = writeShapeBuckets(DATA_DIR, tripShapes, allShapes, 'stale');
            console.log(`Largest shape bucket: ${(largestBucket / 1024).toFixed(0)}KB`);
            console.log(`Wrote shapes for ${Object.keys(tripShapes).length} trips (${rejected} Lissy trip ids matched no trip's stops)`);
            const shapedTrips = Object.entries(tripShapes).map(([tripId, shapeId]) => ({ routeId: activeTrips.get(tripId)!.routeId, shapeId }));
            writeNetwork(DATA_DIR, buildNetwork(shapedTrips, routes, allShapes, CONFIG.NETWORK_MODES));
        } catch (e) {
            console.error('Failed to fetch or process shapes, skipping shape generation.', e);
        }
    }

    console.log('Done!');
}

main().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
});
