import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import type AdmZip from 'adm-zip';
import type { DepartureRow, FeederRow, ParentChildMap, RouteInfo, StopFeature, TripConnection, TripStop, TripWindow, TripWindowsFile } from './lib/contract.ts';
import { DEPARTURE_BUCKETS_DIR, departuresBucketId, departuresChunkId, parentIndex, shapeChunkId, TRIP_BUCKETS_DIR, tripBucketId, tripChunkId } from './lib/contract.ts';
import { fetchZip, readTable } from './lib/feed.ts';
import { getServiceDays, timeToMinutes, timeToOffsetMs, type ServiceDay } from './lib/time.ts';
import { distanceToLinesM, fanOutColocated } from './lib/geo.ts';
import { readServiceDates } from './lib/calendar.ts';
import { readHeldConnections, tripStopKey } from './lib/connections.ts';
import { chunkBy, linesOf, outputDir, safetyCheck, sortDepartures, writeChunks, writeCityFiles } from './lib/emit.ts';

/**
 * Brno (IDS JMK / KORDIS) static GTFS build.
 *
 * Emits the file set the departs-app GtfsAdapter reads, plus two Brno-only extras: trip aliases,
 * which carry trip ids forward across GTFS exports because the KORDIS realtime feed lags behind,
 * and shape geometry fetched from the Lissy API since the feed ships none.
 */
const CONFIG = {
    CITY: 'brno',
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
    DEFAULT_ROUTE_COLOR: '#007DA8',
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
    trips: { required: ['trip_id', 'route_id', 'service_id', 'trip_headsign'], optional: ['direction_id', 'wheelchair_accessible'] },
    stopTimes: { required: ['trip_id', 'stop_id', 'stop_sequence', 'arrival_time', 'departure_time'], optional: ['pickup_type', 'drop_off_type'] },
    stops: { required: ['stop_id', 'stop_name'], optional: ['stop_lat', 'stop_lon', 'location_type', 'parent_station', 'platform_code', 'zone_id'] },
} as const;

interface Trip { route_id: string; headsign: string; service_id: string; wheelchair_accessible: number; direction_id: string }
interface ActiveTrip { route_id: string; headsign: string; wheelchair_accessible: number; dates: ServiceDay[] }
interface StopTime { stop_id: string; arrival_time: string; departure_time: string; stop_sequence: number; is_request_stop: boolean }

function checkLastModified(url: string, lastModifiedPath: string): Promise<{ changed: boolean; etag: string }> {
    return new Promise((resolve, reject) => {
        const req = https.request(url, { method: 'HEAD' }, (res) => {
            if (res.statusCode === 301 || res.statusCode === 302) {
                res.resume();
                return checkLastModified(res.headers.location!, lastModifiedPath).then(resolve).catch(reject);
            }
            const etag = res.headers.etag || res.headers['last-modified'] || '';
            let lastEtag = '';
            try {
                if (fs.existsSync(lastModifiedPath)) lastEtag = fs.readFileSync(lastModifiedPath, 'utf8').trim();
            } catch { /* first run */ }
            res.resume();
            resolve({ changed: !etag || lastEtag !== etag, etag });
        });
        req.on('error', reject);
        req.end();
    });
}

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

    fs.writeFileSync(path.join(dataDir, 'trip_aliases.json'), JSON.stringify(tripAliases));
    fs.writeFileSync(coursePath, JSON.stringify(generations));
    console.log(`Mapped ${Object.keys(tripAliases).length} legacy trip ids onto current trips via ${currentByCourse.size} runs (${generations.length} export generations retained).`);

    // The signature-based state this replaces is no longer read by anything.
    fs.rmSync(path.join(dataDir, 'previous_trips.json'), { force: true });
    return tripAliases;
}

async function main(): Promise<void> {
    console.log(`[${CONFIG.CITY}] Starting GTFS preprocess...`);
    fs.mkdirSync(DATA_DIR, { recursive: true });

    const lastModifiedPath = path.join(DATA_DIR, '.last_modified');
    // The rolling window is rebuilt either way; the check only reports whether the feed itself moved.
    const { changed, etag } = process.env.GTFS_ZIP
        ? { changed: true, etag: '' }
        : await checkLastModified(CONFIG.GTFS_URL, lastModifiedPath);
    console.log(!changed && !process.env.FORCE_REBUILD
        ? `No changes detected in GTFS file (ETag/Last-Modified: ${etag}). Continuing to generate the next 48h rolling window of departures...`
        : `Changes detected or rebuild forced. Processing new GTFS data...`);

    const zip: AdmZip = await fetchZip(CONFIG.GTFS_URL, 'GTFS_ZIP');

    // --- ROUTES ---
    const routes = new Map<string, RouteInfo>();
    for (const r of readTable(zip, 'routes.txt', TABLES.routes)) {
        routes.set(r.route_id, {
            name: r.route_short_name,
            type: r.route_type,
            route_color: r.route_color ? `#${r.route_color}` : CONFIG.DEFAULT_ROUTE_COLOR,
        });
    }

    // --- TRIPS ---
    const trips = new Map<string, Trip>();
    for (const t of readTable(zip, 'trips.txt', TABLES.trips)) {
        trips.set(t.trip_id, {
            route_id: t.route_id,
            headsign: t.trip_headsign,
            service_id: t.service_id,
            wheelchair_accessible: Number(t.wheelchair_accessible || 0),
            direction_id: t.direction_id || '0',
        });
    }

    // --- CALENDAR ---
    const days = getServiceDays(CONFIG.TIMEZONE, CONFIG.DAY_OFFSETS);
    const serviceDates = readServiceDates(zip, days);

    const activeTrips = new Map<string, ActiveTrip>();
    for (const [tripId, t] of trips) {
        const dates = serviceDates.get(t.service_id);
        if (dates && dates.size > 0) {
            activeTrips.set(tripId, {
                route_id: t.route_id,
                headsign: t.headsign,
                wheelchair_accessible: t.wheelchair_accessible,
                dates: [...dates].sort((a, b) => a.midnight - b.midnight),
            });
        }
    }
    console.log(`Found ${activeTrips.size} active trips for next 48h`);

    const courseOf = readCourses(zip);
    const { outgoing, incoming } = readHeldConnections(zip, tripId => activeTrips.has(tripId), CONFIG.MIN_CONNECTION_WAIT_S);
    /** Scheduled times at the stops that take part in a connection. */
    const connectionTimes = new Map<string, { arrival: string; departure: string }>();
    /** Departure rows that wait for feeders, filled once every feeder arrival is known. */
    const pendingFeeders: Array<{ deps: DepartureRow[]; index: number; day: ServiceDay; key: string }> = [];

    // --- STOP TIMES ---
    const stopTimesCsv = readTable(zip, 'stop_times.txt', TABLES.stopTimes);

    // Pass 1: max stop_sequence per trip across the entire timetable, so the last stop of a trip is
    // known even for trips outside the active window.
    const tripMaxStopSeq = new Map<string, number>();
    for (const st of stopTimesCsv) {
        const seq = Number(st.stop_sequence);
        if (!(tripMaxStopSeq.get(st.trip_id)! >= seq)) tripMaxStopSeq.set(st.trip_id, seq);
    }

    const stopRoutes = new Map<string, Set<string>>();
    const departuresByStop = new Map<string, DepartureRow[]>();
    const tripsData = new Map<string, StopTime[]>();

    for (const st of stopTimesCsv) {
        const trip = trips.get(st.trip_id);
        const isLastStop = tripMaxStopSeq.get(st.trip_id) === Number(st.stop_sequence);
        const isNoPickup = st.pickup_type === '1';
        const isRequestStop = st.pickup_type === '3' || st.drop_off_type === '3' || st.pickup_type === '2' || st.drop_off_type === '2';

        // Every scheduled trip contributes its lines, so a stop keeps its daytime, weekday and
        // holiday lines regardless of when the build runs.
        if (trip && !isLastStop && !isNoPickup) {
            let set = stopRoutes.get(st.stop_id);
            if (!set) { set = new Set(); stopRoutes.set(st.stop_id, set); }
            set.add(trip.route_id);
        }

        const activeTrip = activeTrips.get(st.trip_id);
        const stKey = tripStopKey(st.trip_id, st.stop_id);
        if (outgoing.has(stKey) || incoming.has(stKey)) {
            connectionTimes.set(stKey, { arrival: st.arrival_time || st.departure_time, departure: st.departure_time || st.arrival_time });
        }
        if (!activeTrip || !st.departure_time) continue;

        let stops = tripsData.get(st.trip_id);
        if (!stops) { stops = []; tripsData.set(st.trip_id, stops); }
        stops.push({
            stop_id: st.stop_id,
            arrival_time: st.arrival_time,
            departure_time: st.departure_time,
            stop_sequence: Number(st.stop_sequence),
            is_request_stop: isRequestStop,
        });

        if (isNoPickup || isLastStop) continue;

        const offsetMs = timeToOffsetMs(st.departure_time);
        let deps = departuresByStop.get(st.stop_id);
        if (!deps) { deps = []; departuresByStop.set(st.stop_id, deps); }
        const waitsForFeeders = incoming.has(stKey);
        for (const day of activeTrip.dates) {
            if (waitsForFeeders) pendingFeeders.push({ deps, index: deps.length, day, key: stKey });
            deps.push([st.trip_id, activeTrip.route_id, activeTrip.headsign, day.midnight + offsetMs, activeTrip.wheelchair_accessible, isRequestStop ? 1 : 0]);
        }
    }

    // --- STOPS ---
    const stopsCsv = readTable(zip, 'stops.txt', TABLES.stops);

    // Physical stops where passengers can actually board; the rest are drop-off only.
    const validPhysicalStopIds = new Set<string>();
    for (const s of stopsCsv) {
        if (Number(s.location_type || 0) !== 0) continue;
        if ((stopRoutes.get(s.stop_id)?.size ?? 0) > 0) validPhysicalStopIds.add(s.stop_id);
    }

    const features: StopFeature[] = [];
    const validStopIds = new Set<string>();

    for (const s of stopsCsv) {
        if (!s.stop_lat || !s.stop_lon) continue;

        // Physical stops (0), stations (1) and entrances (2).
        const type = Number(s.location_type || 0);
        if (type !== 0 && type !== 1 && type !== 2) continue;

        const isDropOffOnly = type === 0 && !validPhysicalStopIds.has(s.stop_id);
        features.push({
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [Number(s.stop_lon), Number(s.stop_lat)] },
            properties: {
                stop_id: s.stop_id,
                stop_name: s.stop_name,
                platform_code: s.platform_code || null,
                location_type: type as 0 | 1 | 2,
                parent_station: s.parent_station || null,
                zone_id: s.zone_id || null,
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
    for (const s of stopsCsv) {
        if (s.parent_station && validStopIds.has(s.stop_id) && validStopIds.has(s.parent_station)) {
            (parentChildMap[s.parent_station] ??= []).push(s.stop_id);
        }
    }

    const tripRoutes: Record<string, string> = {};
    for (const [tripId, t] of activeTrips) tripRoutes[tripId] = t.route_id;

    // --- TRIP WINDOWS, SIGNATURES ---
    // dayFlags is a bitmask over `days`.
    const dayPos = new Map(days.map((d, i) => [d.str, i]));
    const tripWindows: Record<string, TripWindow> = {};

    for (const [tripId, stops] of tripsData) {
        stops.sort((a, b) => a.stop_sequence - b.stop_sequence);
        const first = stops[0]!;
        const last = stops[stops.length - 1]!;
        const startTime = first.departure_time || first.arrival_time || '';
        const endTime = last.departure_time || last.arrival_time || startTime;

        let flags = 0;
        for (const d of activeTrips.get(tripId)!.dates) flags |= 1 << dayPos.get(d.str)!;
        tripWindows[tripId] = [timeToMinutes(startTime), timeToMinutes(endTime), flags];

    }

    // --- SAFETY CHECK ---
    safetyCheck(departuresByStop.size, tripsData.size, CONFIG.MIN_DEPARTURE_STOPS, CONFIG.MIN_ACTIVE_TRIPS);

    const windowsFile: TripWindowsFile = { days: days.map(d => d.str), trips: tripWindows };
    // trip_shapes.json is written by the shapes step below, so a skipped fetch keeps the existing file.
    writeCityFiles(DATA_DIR, { features, parentChildMap, routes, tripRoutes, tripWindows: windowsFile });
    console.log(`Wrote ${features.length} stops`);

    const tripAliases = generateAliases(DATA_DIR, courseOf, activeTrips, days[0]!.str);

    // --- DEPARTURES ---
    // A connection lists every calendar variant of the feeder run; keep the one running that day.
    let feederRows = 0;
    for (const { deps, index, day, key } of pendingFeeders) {
        const feeders: FeederRow[] = [];
        const seenRuns = new Set<string>();
        for (const c of incoming.get(key)!) {
            const feeder = activeTrips.get(c.fromTrip)!;
            const arrival = connectionTimes.get(tripStopKey(c.fromTrip, c.fromStop))?.arrival;
            if (!arrival || !feeder.dates.includes(day)) continue;
            const run = courseOf.get(c.fromTrip) ?? c.fromTrip;
            if (seenRuns.has(run)) continue;
            seenRuns.add(run);
            feeders.push([c.fromTrip, feeder.route_id, day.midnight + timeToOffsetMs(arrival), c.minTransferS, c.maxWaitS]);
        }
        if (feeders.length === 0) continue;
        feeders.sort((a, b) => a[2] - b[2]);
        const [tripId, routeId, headsign, ts, wheelchair, isRequest] = deps[index]!;
        deps[index] = [tripId, routeId, headsign, ts, wheelchair, isRequest, { feeders }];
        feederRows++;
    }
    console.log(`Attached feeders to ${feederRows} departures`);

    sortDepartures(departuresByStop);
    const parentOf = parentIndex(parentChildMap);
    const departuresChunks = chunkBy(departuresByStop, departuresChunkId);
    writeChunks(path.join(DATA_DIR, 'departures'), departuresChunks);
    writeChunks(path.join(DATA_DIR, DEPARTURE_BUCKETS_DIR), chunkBy(departuresByStop, (id) => departuresBucketId(id, parentOf)));
    console.log(`Wrote ${departuresChunks.size} departure chunks for ${departuresByStop.size} stops`);

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
            if (departure) out.push([c.toTrip, onward.route_id, onward.headsign, departure, c.minTransferS, c.maxWaitS]);
        }
        out.sort((a, b) => timeToOffsetMs(a[3]) - timeToOffsetMs(b[3]));
        return out.length > 0 ? out : undefined;
    };

    let tripConnections = 0;
    const tripStops = new Map<string, TripStop[]>();
    for (const [tripId, stops] of tripsData) {
        tripStops.set(tripId, stops.map((s): TripStop => {
            const node = stopNodes.get(s.stop_id);
            const connections = connectionsAt(tripId, s.stop_id);
            if (connections) tripConnections += connections.length;
            return {
                stop_id: s.stop_id,
                name: node?.name || s.stop_id,
                arrival_time: s.arrival_time,
                departure_time: s.departure_time,
                lat: node?.lat,
                lon: node?.lon,
                is_passed: false,
                zone_id: node?.zone_id || null,
                is_request_stop: s.is_request_stop,
                ...(connections ? { connections } : {}),
            };
        }));
    }
    console.log(`Attached ${tripConnections} onward connections to trip stops`);
    const tripChunks = chunkBy(tripStops, tripChunkId);
    writeChunks(path.join(DATA_DIR, 'trips'), tripChunks);
    writeChunks(path.join(DATA_DIR, TRIP_BUCKETS_DIR), chunkBy(tripStops, tripBucketId));
    console.log(`Wrote ${tripChunks.size} trip chunks for ${tripsData.size} trips`);

    // --- SHAPES: the feed ships none, so geometry comes from the Lissy API ---
    const shapeToken = process.env.LISSY_API_TOKEN;
    if (!shapeToken) {
        console.warn('LISSY_API_TOKEN not set, skipping shape generation.');
    } else {
        try {
            const tripShapes: Record<string, string> = {};
            const tripShapeFit = new Map<string, number>();
            const allShapes = new Map<string, unknown>();
            let rejected = 0;

            const shapeFit = (lines: [number, number][][], tripId: string): number => {
                const stops = tripsData.get(tripId);
                if (!stops || stops.length === 0) return 0;
                let on = 0;
                for (const s of stops) {
                    const node = stopNodes.get(s.stop_id);
                    if (node && distanceToLinesM(node, lines) <= CONFIG.SHAPE_STOP_RADIUS_M) on++;
                }
                return on / stops.length;
            };

            let maxTripId = 0;
            for (const tripId of activeTrips.keys()) {
                const numId = parseInt(tripId, 10);
                if (!isNaN(numId) && numId > maxTripId) maxTripId = numId;
            }

            for (let i = 0; i <= maxTripId; i += CONFIG.SHAPE_BATCH_SIZE) {
                console.log(`Fetching shapes from offset ${i} to ${i + CONFIG.SHAPE_BATCH_SIZE}...`);
                const res = await fetchShapes(shapeToken, i, i + CONFIG.SHAPE_BATCH_SIZE);
                if (!Array.isArray(res) || res.length === 0) break;

                for (const item of res) {
                    const shapeIdStr = String(item.shape_id);
                    allShapes.set(shapeIdStr, item.shape);
                    const lines = item.shape as [number, number][][];
                    // Lissy's trip ids come from its own GTFS copy, which may or may not lag this export,
                    // and ids are recycled - so the raw and aliased readings are both tried against the geometry.
                    for (const rawTripId of item.gtfs_trips) {
                        const raw = String(rawTripId);
                        const alias = tripAliases[raw];
                        let bestTrip: string | null = null;
                        let bestFit = 0;
                        for (const candidate of alias && alias !== raw ? [raw, alias] : [raw]) {
                            if (!activeTrips.has(candidate)) continue;
                            const fit = shapeFit(lines, candidate);
                            if (fit > bestFit) { bestFit = fit; bestTrip = candidate; }
                        }
                        if (!bestTrip || bestFit < CONFIG.MIN_SHAPE_FIT) { rejected++; continue; }
                        if (bestFit > (tripShapeFit.get(bestTrip) ?? 0)) {
                            tripShapeFit.set(bestTrip, bestFit);
                            tripShapes[bestTrip] = shapeIdStr;
                        }
                    }
                }
            }

            // Buckets are derivable from the shape_id on both sides, so no index file is needed and
            // adding a shape only rewrites its own bucket. 'stale' pruning keeps the rest untouched.
            const shapeChunks = chunkBy(allShapes, shapeChunkId);
            console.log(`Writing ${shapeChunks.size} shape chunks for ${allShapes.size} shapes...`);
            const largest = writeChunks(path.join(DATA_DIR, 'shape_chunks'), shapeChunks, 'stale');
            console.log(`Largest shape chunk: ${(largest / 1024).toFixed(0)}KB`);

            fs.writeFileSync(path.join(DATA_DIR, 'trip_shapes.json'), JSON.stringify(tripShapes));
            console.log(`Wrote trip_shapes.json mapping for ${Object.keys(tripShapes).length} trips (${rejected} Lissy trip ids matched no trip's stops)`);
        } catch (e) {
            console.error('Failed to fetch or process shapes, skipping shape generation.', e);
        }
    }

    if (etag) fs.writeFileSync(lastModifiedPath, etag);
    console.log('Done!');
}

main().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
});
