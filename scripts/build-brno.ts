import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import type AdmZip from 'adm-zip';
import type { DepartureRow, ParentChildMap, RouteInfo, StopFeature, TripStop, TripWindow, TripWindowsFile } from './lib/contract.ts';
import { departuresChunkId, shapeChunkId, tripChunkId } from './lib/contract.ts';
import { fetchZip, readTable } from './lib/feed.ts';
import { getServiceDays, timeToMinutes, timeToOffsetMs, type ServiceDay } from './lib/time.ts';
import { fanOutColocated } from './lib/geo.ts';
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
    DEFAULT_ROUTE_COLOR: '#007DA8',

    /** Abort thresholds guarding against an empty or truncated upstream feed. */
    MIN_DEPARTURE_STOPS: 1000,
    MIN_ACTIVE_TRIPS: 5000,
} as const;

const DATA_DIR = outputDir(CONFIG.CITY);

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'] as const;

/** Columns this build depends on; anything absent aborts at the header rather than downstream. */
const TABLES = {
    routes: { required: ['route_id', 'route_type', 'route_short_name'], optional: ['route_color'] },
    trips: { required: ['trip_id', 'route_id', 'service_id', 'trip_headsign'], optional: ['direction_id', 'wheelchair_accessible'] },
    calendar: { required: ['service_id', 'start_date', 'end_date', ...WEEKDAYS], fileOptional: true },
    calendarDates: { required: ['service_id', 'date', 'exception_type'], fileOptional: true },
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

/**
 * Carries trip ids forward across GTFS exports, so a realtime feed still reporting the previous
 * export's ids resolves. Trips are matched by signature; an id that no longer exists maps to null.
 *
 * The signature format is stored state in previous_trips.json — changing it invalidates every
 * alias for one cycle, so the constant direction field stays even though the feed has real values.
 */
function generateAliases(dataDir: string, currentTripSignatures: Record<string, string>, signatureToNewTripId: Map<string, string>, currentTripRouteShort: Record<string, string>): void {
    const previousTripsPath = path.join(dataDir, 'previous_trips.json');
    const existingAliasesPath = path.join(dataDir, 'trip_aliases.json');

    if (fs.existsSync(previousTripsPath)) {
        try {
            const previousTrips = JSON.parse(fs.readFileSync(previousTripsPath, 'utf8')) as Record<string, string>;
            const tripAliases: Record<string, string | null> = {};
            const newAliasesFromPrev: Record<string, string | null> = {};
            let collisionCount = 0;
            let droppedCount = 0;

            // 1. Generate aliases from previous_trips to current GTFS
            for (const [oldTripId, oldSig] of Object.entries(previousTrips)) {
                const newTripId = signatureToNewTripId.get(oldSig);

                if (newTripId) {
                    // DO NOT alias reused trip IDs
                    if (oldTripId in currentTripSignatures && oldTripId !== newTripId) continue;

                    const currentRouteShort = currentTripRouteShort[newTripId];
                    const oldRouteShort = oldSig.split('|')[0];
                    if (currentRouteShort !== oldRouteShort) {
                        newAliasesFromPrev[oldTripId] = newTripId; // collision fix
                        collisionCount++;
                    } else if (oldTripId !== newTripId) {
                        newAliasesFromPrev[oldTripId] = newTripId; // rename
                    }
                } else {
                    newAliasesFromPrev[oldTripId] = null; // dropped
                    droppedCount++;
                }
            }

            // 2. Chain existing aliases to preserve history (important for RT feeds lagging behind)
            if (fs.existsSync(existingAliasesPath)) {
                const existingAliases = JSON.parse(fs.readFileSync(existingAliasesPath, 'utf8')) as Record<string, string | null>;
                for (const [veryOldId, prevId] of Object.entries(existingAliases)) {
                    if (prevId === null) {
                        tripAliases[veryOldId] = null;
                        continue;
                    }
                    if (veryOldId in currentTripSignatures) continue;
                    if (prevId in newAliasesFromPrev) tripAliases[veryOldId] = newAliasesFromPrev[prevId]!;
                    else if (prevId in currentTripSignatures) tripAliases[veryOldId] = prevId; // Still valid in current GTFS
                    else tripAliases[veryOldId] = null; // Target no longer exists
                }
            }

            // 3. Add any new aliases that weren't covered by history chaining
            for (const [prevId, newId] of Object.entries(newAliasesFromPrev)) {
                if (!(prevId in tripAliases)) tripAliases[prevId] = newId;
            }

            for (const key of Object.keys(tripAliases)) {
                if (tripAliases[key] === key) delete tripAliases[key];
            }

            console.log(`Generated/Chained ${Object.keys(tripAliases).length} total trip aliases (${collisionCount} collisions fixed, ${droppedCount} dropped).`);
            fs.writeFileSync(existingAliasesPath, JSON.stringify(tripAliases));
        } catch (err) {
            console.error('Failed to parse previous_trips.json for alias generation:', err);
        }
    }

    fs.writeFileSync(previousTripsPath, JSON.stringify(currentTripSignatures));
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
    const dayByStr = new Map(days.map(d => [d.str, d]));
    const serviceDates = new Map<string, Set<ServiceDay>>();
    const addServiceDate = (serviceId: string, day: ServiceDay) => {
        let set = serviceDates.get(serviceId);
        if (!set) { set = new Set(); serviceDates.set(serviceId, set); }
        set.add(day);
    };

    for (const cal of readTable(zip, 'calendar.txt', TABLES.calendar)) {
        for (const day of days) {
            if (day.str < cal.start_date || day.str > cal.end_date) continue;
            if (cal[WEEKDAYS[day.weekday]!] === '1') addServiceDate(cal.service_id, day);
        }
    }
    for (const ex of readTable(zip, 'calendar_dates.txt', TABLES.calendarDates)) {
        const day = dayByStr.get(ex.date);
        if (!day) continue;
        if (ex.exception_type === '1') addServiceDate(ex.service_id, day);
        else if (ex.exception_type === '2') serviceDates.get(ex.service_id)?.delete(day);
    }

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
        for (const day of activeTrip.dates) {
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
    const currentTripSignatures: Record<string, string> = {};
    const signatureToNewTripId = new Map<string, string>();
    const currentTripRouteShort: Record<string, string> = {};

    for (const [tripId, stops] of tripsData) {
        stops.sort((a, b) => a.stop_sequence - b.stop_sequence);
        const first = stops[0]!;
        const last = stops[stops.length - 1]!;
        const startTime = first.departure_time || first.arrival_time || '';
        const endTime = last.departure_time || last.arrival_time || startTime;

        let flags = 0;
        for (const d of activeTrips.get(tripId)!.dates) flags |= 1 << dayPos.get(d.str)!;
        tripWindows[tripId] = [timeToMinutes(startTime), timeToMinutes(endTime), flags];

        const routeShort = routes.get(activeTrips.get(tripId)!.route_id)?.name || activeTrips.get(tripId)!.route_id;
        currentTripRouteShort[tripId] = routeShort;
        // The '0' is a frozen field of the stored signature format; see generateAliases.
        const sig = `${routeShort}|0|${startTime}|${endTime}|${first.stop_id}|${last.stop_id}`;
        currentTripSignatures[tripId] = sig;
        if (!signatureToNewTripId.has(sig)) signatureToNewTripId.set(sig, tripId);
    }

    // --- SAFETY CHECK ---
    safetyCheck(departuresByStop.size, tripsData.size, CONFIG.MIN_DEPARTURE_STOPS, CONFIG.MIN_ACTIVE_TRIPS);

    const windowsFile: TripWindowsFile = { days: days.map(d => d.str), trips: tripWindows };
    // trip_shapes.json is written by the shapes step below, so a skipped fetch keeps the existing file.
    writeCityFiles(DATA_DIR, { features, parentChildMap, routes, tripRoutes, tripWindows: windowsFile });
    console.log(`Wrote ${features.length} stops`);

    console.log('Generating trip signatures and checking for legacy trip_aliases...');
    generateAliases(DATA_DIR, currentTripSignatures, signatureToNewTripId, currentTripRouteShort);

    // --- DEPARTURES ---
    sortDepartures(departuresByStop);
    const departuresChunks = chunkBy(departuresByStop, departuresChunkId);
    writeChunks(path.join(DATA_DIR, 'departures'), departuresChunks);
    console.log(`Wrote ${departuresChunks.size} departure chunks for ${departuresByStop.size} stops`);

    // --- TRIPS ---
    const stopNodes = new Map(features.map(f => [f.properties.stop_id, {
        name: f.properties.stop_name,
        lon: f.geometry.coordinates[0],
        lat: f.geometry.coordinates[1],
        zone_id: f.properties.zone_id,
    }]));

    const tripStops = new Map<string, TripStop[]>();
    for (const [tripId, stops] of tripsData) {
        tripStops.set(tripId, stops.map((s): TripStop => {
            const node = stopNodes.get(s.stop_id);
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
            };
        }));
    }
    const tripChunks = chunkBy(tripStops, tripChunkId);
    writeChunks(path.join(DATA_DIR, 'trips'), tripChunks);
    console.log(`Wrote ${tripChunks.size} trip chunks for ${tripsData.size} trips`);

    // --- SHAPES: the feed ships none, so geometry comes from the Lissy API ---
    const shapeToken = process.env.LISSY_API_TOKEN;
    if (!shapeToken) {
        console.warn('LISSY_API_TOKEN not set, skipping shape generation.');
    } else {
        try {
            const tripShapes: Record<string, string> = {};
            const allShapes = new Map<string, unknown>();

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
                    for (const tripId of item.gtfs_trips) {
                        if (activeTrips.has(String(tripId))) tripShapes[String(tripId)] = shapeIdStr;
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
            console.log(`Wrote trip_shapes.json mapping for ${Object.keys(tripShapes).length} trips`);
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
