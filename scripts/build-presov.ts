import fs from 'node:fs';
import path from 'node:path';
import type AdmZip from 'adm-zip';
import type { ContinuationRow, DepartureRow, ParentChildMap, RouteInfo, StopFeature, TripStop, TripWindow, TripWindowsFile } from './lib/contract.ts';
import { DEPARTURE_BUCKETS_DIR, departuresBucketId, parentIndex, TRIP_BUCKETS_DIR, tripBucketId } from './lib/contract.ts';
import { fetchJson, fetchZip, readTable } from './lib/feed.ts';
import { getServiceDays, timeToMinutes, timeToOffsetMs, type ServiceDay } from './lib/time.ts';
import { clusterByDistance } from './lib/cluster.ts';
import { readServiceDates } from './lib/calendar.ts';
import { fanOutColocated, round6 } from './lib/geo.ts';
import { chunkBy, linesOf, outputDir, safetyCheck, sortDepartures, writeChunks, writeCityFiles } from './lib/emit.ts';
import { readStops } from './lib/stops.ts';
import { readGtfsShapes, writeShapeBuckets } from './lib/shapes.ts';

/**
 * Prešov (DPMP) static GTFS build.
 *
 * Emits the same file set and formats as build-brno.ts so the departs-app GtfsAdapter reads it
 * unchanged. Differences are confined to what the DPMP feed lacks or encodes differently: no
 * parent stations, no route colors, request stops marked by a `*` name suffix, and every id
 * prefixed with the monthly feed_version.
 */
const CONFIG = {
    CITY: 'presov',
    TIMEZONE: 'Europe/Bratislava',
    ARCGIS_ITEM_URL: 'https://www.arcgis.com/sharing/rest/content/items/f1033ca6c2f4461d9aba285e1c7cb079',

    /** Yesterday, today and tomorrow. */
    DAY_OFFSETS: [-1, 0, 1],

    /** Same-named platforms further apart than this become separate stations. */
    STATION_CLUSTER_RADIUS_M: 300,
    /** Radial separation for platforms sharing exact coordinates (~12 m). */
    COLOCATED_OFFSET_DEG: 0.00012,
    SHAPE_COORD_DECIMALS: 5,

    /** Official DPMP network map scheme (dpmp.sk line network map, valid from 8. 1. 2025). */
    ROUTE_COLORS: {
        '1': '#55D400',
        '2': '#FF6600',
        '4': '#2A7FFF',
        '5': '#FFCC00',
        '5D': '#FFCC00',
        '7': '#338000',
        '8': '#0000AA',
        '28': '#FF0000',
        '32': '#008066',
        '32A': '#008066',
        '38': '#00CCFF',
        '39': '#800080',
        '45': '#FF0066',
    } as Record<string, string>,
    /** Line groups without a map color, in DPMP/imhd.sk colors: school lines (A, C, … and H) and night lines. */
    ROUTE_COLOR_RULES: [
        { pattern: /^[A-Z]$/, color: '#EF7F1A' },
        { pattern: /^N\d+$/, color: '#00378A' },
    ],
    DEFAULT_ROUTE_COLOR: '#999999',

    /** How long after arriving a vehicle may leave again as the trip its stop headsign names. */
    CONTINUATION_WINDOW_MINS: 20,

    /** Abort thresholds guarding against an empty or truncated upstream feed. */
    MIN_DEPARTURE_STOPS: 200,
    MIN_ACTIVE_TRIPS: 500,
} as const;

const DATA_DIR = outputDir(CONFIG.CITY);

/** Columns this build depends on; anything absent aborts at the header rather than downstream. */
const TABLES = {
    feedInfo: { required: [], optional: ['feed_version', 'feed_start_date', 'feed_end_date'], fileOptional: true },
    routes: { required: ['route_id', 'route_type'], optional: ['route_short_name', 'route_long_name', 'route_color'] },
    trips: { required: ['trip_id', 'route_id', 'service_id', 'trip_headsign'], optional: ['direction_id', 'wheelchair_accessible', 'shape_id'] },
    stopTimes: { required: ['trip_id', 'stop_id', 'stop_sequence', 'arrival_time', 'departure_time'], optional: ['pickup_type', 'drop_off_type', 'stop_headsign'] },
} as const;

function routeColorFor(name: string): string {
    const key = name.toUpperCase();
    return CONFIG.ROUTE_COLORS[key]
        ?? CONFIG.ROUTE_COLOR_RULES.find(rule => rule.pattern.test(key))?.color
        ?? CONFIG.DEFAULT_ROUTE_COLOR;
}

const REQUEST_STOP_SUFFIX = /\s*\*\s*$/;

function cleanStopName(raw: string): string {
    return raw.replace(REQUEST_STOP_SUFFIX, '').replace(/\s{2,}/g, ' ').trim();
}

/** Grouping key tolerant of the feed's inconsistent spacing ("Rázc. Cemjata" vs "Rázc.Cemjata"). */
function stationKey(name: string): string {
    return name.toLowerCase().replace(/\.\s*/g, '.').replace(/\s+/g, ' ').trim();
}

interface StopHeadsign { headsign: string | null; continues: { line: string; headsign: string } | null }

/**
 * Splits a DPMP stop headsign. Plain text replaces the trip headsign from that stop on
 * ("PODHRADÍK SEVERNÁ-ČIERNY MOST"); `->5 Sabinovská` means the vehicle continues as line 5, and
 * the text before the arrow, when present, is the destination of the current trip.
 */
function parseStopHeadsign(raw: string): StopHeadsign {
    const text = raw.trim();
    if (!text) return { headsign: null, continues: null };
    const m = text.match(/^(.*?)\s*->\s*(\S+)\s+(.+)$/);
    if (!m) return { headsign: text, continues: null };
    return { headsign: m[1]!.trim() || null, continues: { line: m[2]!, headsign: m[3]!.trim() } };
}

function slugify(name: string): string {
    return name.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

interface Platform { stop_id: string; name: string; lat: number; lon: number; zone_id: string | null }
interface Trip { route_id: string; headsign: string; service_id: string; wheelchair_accessible: number; direction_id: number; shape_id: string | null }
interface ActiveTrip extends Trip { dates: ServiceDay[] }
interface StopTime { stop_id: string; arrival_time: string; departure_time: string; stop_sequence: number; is_request_stop: boolean }

async function fetchItemModified(): Promise<string> {
    const item = await fetchJson<{ modified?: unknown }>(`${CONFIG.ARCGIS_ITEM_URL}?f=json`, 'ARCGIS_ITEM_JSON');
    return String(item.modified ?? '');
}

async function main(): Promise<void> {
    console.log(`[${CONFIG.CITY}] Starting GTFS preprocess...`);
    fs.mkdirSync(DATA_DIR, { recursive: true });

    const lastModifiedPath = path.join(DATA_DIR, '.last_modified');
    const modified = await fetchItemModified();
    const previous = fs.existsSync(lastModifiedPath) ? fs.readFileSync(lastModifiedPath, 'utf8').trim() : '';
    console.log(modified && modified === previous
        ? `No feed change (modified ${modified}). Regenerating the rolling window...`
        : `Feed changed or first run (modified ${modified}). Processing...`);

    const zip: AdmZip = await fetchZip(`${CONFIG.ARCGIS_ITEM_URL}/data`, 'GTFS_ZIP');

    const feedInfo = readTable(zip, 'feed_info.txt', TABLES.feedInfo)[0];
    const idPrefix = feedInfo?.feed_version ? `${feedInfo.feed_version}_` : '';
    const normalizeId = (id: string) => (idPrefix && id.startsWith(idPrefix) ? id.slice(idPrefix.length) : id);
    console.log(`Feed version ${feedInfo?.feed_version ?? 'n/a'}, valid ${feedInfo?.feed_start_date ?? '?'}–${feedInfo?.feed_end_date ?? '?'}`);

    // --- ROUTES ---
    const routes = new Map<string, RouteInfo>();
    for (const r of readTable(zip, 'routes.txt', TABLES.routes)) {
        const name = r.route_short_name || r.route_long_name || r.route_id;
        routes.set(r.route_id, {
            name,
            type: r.route_type,
            route_color: r.route_color ? `#${r.route_color}` : routeColorFor(name),
        });
    }

    // --- TRIPS ---
    const trips = new Map<string, Trip>();
    for (const t of readTable(zip, 'trips.txt', TABLES.trips)) {
        trips.set(normalizeId(t.trip_id), {
            route_id: t.route_id,
            headsign: t.trip_headsign,
            service_id: normalizeId(t.service_id),
            wheelchair_accessible: Number(t.wheelchair_accessible || 0),
            direction_id: Number(t.direction_id || 0),
            shape_id: t.shape_id || null,
        });
    }

    // --- CALENDAR ---
    const days = getServiceDays(CONFIG.TIMEZONE, CONFIG.DAY_OFFSETS);
    const serviceDates = new Map<string, Set<ServiceDay>>();
    for (const [rawId, dates] of readServiceDates(zip, days)) serviceDates.set(normalizeId(rawId), dates);

    const activeTrips = new Map<string, ActiveTrip>();
    for (const [tripId, t] of trips) {
        const dates = serviceDates.get(t.service_id);
        if (dates && dates.size > 0) {
            activeTrips.set(tripId, { ...t, dates: [...dates].sort((a, b) => a.midnight - b.midnight) });
        }
    }
    console.log(`Found ${activeTrips.size} active trips across ${days.map(d => d.str).join(', ')}`);

    // --- STOPS (request flag lives in the name) ---
    const stops = readStops(zip);
    const requestStopIds = new Set<string>();
    for (const s of stops) {
        if (REQUEST_STOP_SUFFIX.test(s.stop_name)) requestStopIds.add(s.stop_id);
    }

    // --- STOP TIMES ---
    const stopTimesCsv = readTable(zip, 'stop_times.txt', TABLES.stopTimes);
    const tripMaxStopSeq = new Map<string, number>();
    for (const st of stopTimesCsv) {
        const tripId = normalizeId(st.trip_id);
        const seq = Number(st.stop_sequence);
        if (!(tripMaxStopSeq.get(tripId)! >= seq)) tripMaxStopSeq.set(tripId, seq);
    }

    const stopRoutes = new Map<string, Set<string>>();
    const departuresByStop = new Map<string, DepartureRow[]>();
    const tripsData = new Map<string, StopTime[]>();

    const parsedHeadsigns = new Map<string, StopHeadsign>();
    const parseCached = (raw: string): StopHeadsign => {
        let parsed = parsedHeadsigns.get(raw);
        if (!parsed) { parsed = parseStopHeadsign(raw); parsedHeadsigns.set(raw, parsed); }
        return parsed;
    };
    /** The line and direction each trip continues as, from its stop headsigns. */
    const tripContinues = new Map<string, { line: string; headsign: string }>();
    /** Departure rows that announce a continuation, filled once continuations are resolved. */
    const pendingContinuations: Array<{ deps: DepartureRow[]; index: number; tripId: string }> = [];

    for (const st of stopTimesCsv) {
        const tripId = normalizeId(st.trip_id);
        const trip = trips.get(tripId);
        if (!trip) continue;

        const isLastStop = tripMaxStopSeq.get(tripId) === Number(st.stop_sequence);
        const isNoPickup = st.pickup_type === '1';
        const isRequestStop = requestStopIds.has(st.stop_id)
            || st.pickup_type === '2' || st.pickup_type === '3'
            || st.drop_off_type === '2' || st.drop_off_type === '3';

        if (!isLastStop && !isNoPickup) {
            let set = stopRoutes.get(st.stop_id);
            if (!set) { set = new Set(); stopRoutes.set(st.stop_id, set); }
            set.add(trip.route_id);
        }

        const activeTrip = activeTrips.get(tripId);
        if (!activeTrip || !st.departure_time) continue;

        let stops = tripsData.get(tripId);
        if (!stops) { stops = []; tripsData.set(tripId, stops); }
        stops.push({
            stop_id: st.stop_id,
            arrival_time: st.arrival_time,
            departure_time: st.departure_time,
            stop_sequence: Number(st.stop_sequence),
            is_request_stop: isRequestStop,
        });

        const stopHeadsign = parseCached(st.stop_headsign ?? '');
        if (stopHeadsign.continues) tripContinues.set(tripId, stopHeadsign.continues);

        if (isNoPickup || isLastStop) continue;

        const offsetMs = timeToOffsetMs(st.departure_time);
        const headsign = stopHeadsign.headsign ?? activeTrip.headsign;
        let deps = departuresByStop.get(st.stop_id);
        if (!deps) { deps = []; departuresByStop.set(st.stop_id, deps); }
        for (const day of activeTrip.dates) {
            if (stopHeadsign.continues) pendingContinuations.push({ deps, index: deps.length, tripId });
            deps.push([tripId, activeTrip.route_id, headsign, day.midnight + offsetMs, activeTrip.wheelchair_accessible, isRequestStop ? 1 : 0]);
        }
    }

    // --- STATIONS: synthesise parents, since the feed ships platforms only ---
    const platforms: Platform[] = [];
    for (const s of stops) {
        if (s.location_type !== 0 || s.lat === null || s.lon === null) continue;
        platforms.push({
            stop_id: s.stop_id,
            name: cleanStopName(s.stop_name),
            lat: s.lat,
            lon: s.lon,
            zone_id: s.zone_id,
        });
    }

    const byName = new Map<string, Platform[]>();
    for (const p of platforms) {
        const key = stationKey(p.name);
        let group = byName.get(key);
        if (!group) { group = []; byName.set(key, group); }
        group.push(p);
    }

    const stations: { id: string; platforms: Platform[] }[] = [];
    const usedStationIds = new Set<string>();
    for (const group of byName.values()) {
        group.sort((a, b) => a.stop_id.localeCompare(b.stop_id, undefined, { numeric: true }));
        for (const cluster of clusterByDistance(group, CONFIG.STATION_CLUSTER_RADIUS_M, p => p.stop_id)) {
            const base = `centroid-${slugify(cluster[0]!.name)}`;
            let id = base;
            for (let n = 2; usedStationIds.has(id); n++) id = `${base}-${n}`;
            usedStationIds.add(id);
            stations.push({ id, platforms: cluster });
        }
    }

    const features: StopFeature[] = [];
    const parentChildMap: ParentChildMap = {};
    for (const station of stations) {
        const lat = station.platforms.reduce((sum, p) => sum + p.lat, 0) / station.platforms.length;
        const lon = station.platforms.reduce((sum, p) => sum + p.lon, 0) / station.platforms.length;
        features.push({
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [round6(lon), round6(lat)] },
            properties: {
                stop_id: station.id,
                stop_name: station.platforms[0]!.name,
                platform_code: null,
                location_type: 1,
                parent_station: null,
                zone_id: station.platforms[0]!.zone_id,
                lines: [],
            },
        });
        parentChildMap[station.id] = [];
        for (const p of station.platforms) {
            const lines = linesOf(stopRoutes.get(p.stop_id), routes);
            features.push({
                type: 'Feature',
                geometry: { type: 'Point', coordinates: [p.lon, p.lat] },
                properties: {
                    stop_id: p.stop_id,
                    stop_name: p.name,
                    platform_code: null,
                    location_type: 0,
                    parent_station: station.id,
                    zone_id: p.zone_id,
                    is_drop_off_only: lines.length === 0 || undefined,
                    lines,
                },
            });
            parentChildMap[station.id]!.push(p.stop_id);
        }
    }

    const platformFeatures = features.filter(f => f.properties.location_type === 0);
    const fanned = fanOutColocated(platformFeatures.map(f => ({ lon: f.geometry.coordinates[0], lat: f.geometry.coordinates[1] })), CONFIG.COLOCATED_OFFSET_DEG);
    platformFeatures.forEach((f, i) => { f.geometry.coordinates = fanned[i]!; });

    // --- SAFETY CHECK ---
    safetyCheck(departuresByStop.size, tripsData.size, CONFIG.MIN_DEPARTURE_STOPS, CONFIG.MIN_ACTIVE_TRIPS,
        `feed valid ${feedInfo?.feed_start_date ?? '?'}–${feedInfo?.feed_end_date ?? '?'}`);

    const tripRoutes: Record<string, string> = {};
    for (const [tripId, t] of activeTrips) tripRoutes[tripId] = t.route_id;

    // --- TRIP WINDOWS: Brno format plus a trailing direction_id for CSV trip matching ---
    const dayPos = new Map(days.map((d, i) => [d.str, i]));
    const tripWindows: Record<string, TripWindow> = {};
    for (const [tripId, stops] of tripsData) {
        stops.sort((a, b) => a.stop_sequence - b.stop_sequence);
        const first = stops[0]!;
        const last = stops[stops.length - 1]!;
        const start = first.departure_time || first.arrival_time;
        const end = last.arrival_time || last.departure_time || start;
        let flags = 0;
        for (const d of activeTrips.get(tripId)!.dates) flags |= 1 << dayPos.get(d.str)!;
        tripWindows[tripId] = [timeToMinutes(start), timeToMinutes(end), flags, activeTrips.get(tripId)!.direction_id];
    }

    // --- SHAPES (from shapes.txt) ---
    const tripShapes: Record<string, string> = {};
    const neededShapes = new Set<string>();
    for (const [tripId, t] of activeTrips) {
        if (!t.shape_id) continue;
        tripShapes[tripId] = t.shape_id;
        neededShapes.add(t.shape_id);
    }

    const windowsFile: TripWindowsFile = { days: days.map(d => d.str), trips: tripWindows };
    writeCityFiles(DATA_DIR, { features, parentChildMap, routes, tripRoutes, tripWindows: windowsFile });
    console.log(`Wrote ${stations.length} stations over ${platforms.length} platforms`);

    // --- CONTINUATIONS: the feed has no block_id, so match the named line leaving the same stop ---
    // Services are day types, so a trip on the same service_id runs on exactly the same days.
    const stopNameById = new Map(stops.map(s => [s.stop_id, stationKey(cleanStopName(s.stop_name))]));
    const routeIdByName = new Map<string, string>();
    for (const [routeId, r] of routes) routeIdByName.set(r.name, routeId);

    const bySequence = (a: StopTime, b: StopTime) => a.stop_sequence - b.stop_sequence;
    const tripStarts = new Map<string, Array<[number, string]>>();
    for (const [tripId, stops] of tripsData) {
        const first = stops.reduce((a, b) => (bySequence(a, b) <= 0 ? a : b));
        const trip = activeTrips.get(tripId)!;
        const key = `${stopNameById.get(first.stop_id)}|${routes.get(trip.route_id)?.name}|${trip.service_id}`;
        let list = tripStarts.get(key);
        if (!list) { list = []; tripStarts.set(key, list); }
        list.push([timeToOffsetMs(first.departure_time), tripId]);
    }
    for (const list of tripStarts.values()) list.sort((a, b) => a[0] - b[0]);

    const continuationOf = new Map<string, ContinuationRow>();
    const windowMs = CONFIG.CONTINUATION_WINDOW_MINS * 60_000;
    let matched = 0, ambiguous = 0;
    for (const [tripId, next] of tripContinues) {
        const stops = tripsData.get(tripId)!;
        const last = stops.reduce((a, b) => (bySequence(a, b) >= 0 ? a : b));
        const arrivalMs = timeToOffsetMs(last.arrival_time || last.departure_time);
        const key = `${stopNameById.get(last.stop_id)}|${next.line}|${activeTrips.get(tripId)!.service_id}`;
        let found: [number, string] | undefined;
        let candidates = 0;
        for (const start of tripStarts.get(key) ?? []) {
            if (start[0] < arrivalMs) continue;
            if (start[0] - arrivalMs > windowMs) break;
            found ??= start;
            candidates++;
        }
        if (found) matched++;
        if (candidates > 1) ambiguous++;
        const nextStops = found ? tripsData.get(found[1])! : null;
        continuationOf.set(tripId, [
            found ? found[1] : null,
            found ? activeTrips.get(found[1])!.route_id : (routeIdByName.get(next.line) ?? null),
            next.line,
            next.headsign,
            nextStops ? nextStops.reduce((a, b) => (bySequence(a, b) <= 0 ? a : b)).departure_time : null,
        ]);
    }
    console.log(`Continuations: ${tripContinues.size} announced, ${matched} matched to a trip (${ambiguous} with several candidates, earliest kept)`);

    for (const { deps, index, tripId } of pendingContinuations) {
        const continues = continuationOf.get(tripId);
        if (!continues) continue;
        const [id, routeId, headsign, ts, wheelchair, isRequest] = deps[index]!;
        deps[index] = [id, routeId, headsign, ts, wheelchair, isRequest, { continues }];
    }

    // --- DEPARTURES ---
    sortDepartures(departuresByStop);
    const parentOf = parentIndex(parentChildMap);
    const departureBuckets = chunkBy(departuresByStop, (id) => departuresBucketId(id, parentOf));
    writeChunks(path.join(DATA_DIR, DEPARTURE_BUCKETS_DIR), departureBuckets);
    console.log(`Wrote ${departureBuckets.size} departure buckets for ${departuresByStop.size} stops`);

    // --- TRIPS ---
    const platformById = new Map(platforms.map(p => [p.stop_id, p]));
    const tripStops = new Map<string, TripStop[]>();
    for (const [tripId, stops] of tripsData) {
        const continues = continuationOf.get(tripId);
        const lastSequence = continues ? Math.max(...stops.map(s => s.stop_sequence)) : -1;
        tripStops.set(tripId, stops.map((s): TripStop => {
            const node = platformById.get(s.stop_id);
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
                ...(continues && s.stop_sequence === lastSequence ? { continues_as: continues } : {}),
            };
        }));
    }
    const tripBuckets = chunkBy(tripStops, tripBucketId);
    writeChunks(path.join(DATA_DIR, TRIP_BUCKETS_DIR), tripBuckets);
    console.log(`Wrote ${tripBuckets.size} trip buckets for ${tripsData.size} trips`);

    // --- SHAPE GEOMETRY ---
    const shapeGeometry = readGtfsShapes(zip, neededShapes, { coordDecimals: CONFIG.SHAPE_COORD_DECIMALS });
    const largestShapeFile = writeShapeBuckets(DATA_DIR, tripShapes, shapeGeometry);
    console.log(`Wrote ${shapeGeometry.size} shapes into hashed buckets (largest ${(largestShapeFile / 1024).toFixed(0)}KB)`);

    if (modified) fs.writeFileSync(lastModifiedPath, modified);
    console.log('Done!');
}

main().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
});
