import fs from 'node:fs';
import type AdmZip from 'adm-zip';
import { nightFlag, type ContinuationRow, type ParentChildMap, type RouteInfo, type StopFeature, type TripStop } from './lib/contract.ts';
import { fetchZip, readTable } from './lib/feed.ts';
import { getServiceDays, timeToOffsetMs } from './lib/time.ts';
import { clusterByDistance } from './lib/cluster.ts';
import { buildDepartures, gtfsBoardings, gtfsTripStop, gtfsWindow, readGtfsTimetable, tripWindows, writeDepartures, writeTrips, type Call } from './lib/timetable.ts';
import { fanOutColocated, round6 } from './lib/geo.ts';
import { linesOf, outputDir, safetyCheck, writeCityFiles } from './lib/emit.ts';
import { readStops } from './lib/stops.ts';
import { readGtfsShapes, writeShapeBuckets } from './lib/shapes.ts';
import { buildNetwork, writeNetwork, type NetworkMode } from './lib/network.ts';

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
    /** Drawn on the map at all times: the trolleybus wires as one network, about 26 km. */
    NETWORK_MODES: [{ routeTypes: ['11', '800'], style: 'merged', minKm: 15 }] satisfies NetworkMode[],

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
    /** Night lines are numbered N<digit>. */
    NIGHT_LINE: /^N\d/,

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

interface Platform { stop_id: string; name: string; lat: number; lon: number; zone_id: string | null }

async function main(): Promise<void> {
    console.log(`[${CONFIG.CITY}] Starting GTFS preprocess...`);
    fs.mkdirSync(DATA_DIR, { recursive: true });

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
            ...nightFlag(CONFIG.NIGHT_LINE.test(name)),
        });
    }

    // --- STOPS (request flag lives in the name) ---
    const stops = readStops(zip);
    const requestStopIds = new Set<string>();
    for (const s of stops) {
        if (REQUEST_STOP_SUFFIX.test(s.stop_name)) requestStopIds.add(s.stop_id);
    }

    // --- TIMETABLE ---
    const days = getServiceDays(CONFIG.TIMEZONE, CONFIG.DAY_OFFSETS);
    const timetable = readGtfsTimetable(zip, days, { normalizeId, isRequestStop: stopId => requestStopIds.has(stopId) });
    const { activeTrips, calls: tripsData, stopRoutes } = timetable;
    console.log(`Found ${activeTrips.size} active trips across ${days.map(d => d.str).join(', ')}`);

    const parsedHeadsigns = new Map<string, StopHeadsign>();
    const stopHeadsignOf = (call: Call): StopHeadsign => {
        let parsed = parsedHeadsigns.get(call.stopHeadsign);
        if (!parsed) { parsed = parseStopHeadsign(call.stopHeadsign); parsedHeadsigns.set(call.stopHeadsign, parsed); }
        return parsed;
    };
    /** The line and direction each trip continues as, from its stop headsigns. */
    const tripContinues = new Map<string, { line: string; headsign: string }>();
    for (const call of timetable.callsInFeedOrder) {
        const { continues } = stopHeadsignOf(call);
        if (continues) tripContinues.set(call.tripId, continues);
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
    for (const group of byName.values()) {
        group.sort((a, b) => a.stop_id.localeCompare(b.stop_id, undefined, { numeric: true }));
        for (const cluster of clusterByDistance(group, CONFIG.STATION_CLUSTER_RADIUS_M, p => p.stop_id)) {
            // The feed has no stations and names may change: a station is `U` and its lowest platform id.
            stations.push({ id: `U${Math.min(...cluster.map(p => Number(p.stop_id)))}`, platforms: cluster });
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

    // --- CONTINUATIONS: the feed has no block_id, so match the named line leaving the same stop ---
    // Services are day types, so a trip on the same service_id runs on exactly the same days.
    const stopNameById = new Map(stops.map(s => [s.stop_id, stationKey(cleanStopName(s.stop_name))]));
    const routeIdByName = new Map<string, string>();
    for (const [routeId, r] of routes) routeIdByName.set(r.name, routeId);

    const tripStarts = new Map<string, Array<[number, string]>>();
    for (const [tripId, calls] of tripsData) {
        const first = calls[0]!;
        const trip = activeTrips.get(tripId)!;
        const key = `${stopNameById.get(first.stopId)}|${routes.get(trip.routeId)?.name}|${trip.serviceId}`;
        let list = tripStarts.get(key);
        if (!list) { list = []; tripStarts.set(key, list); }
        list.push([timeToOffsetMs(first.departure), tripId]);
    }
    for (const list of tripStarts.values()) list.sort((a, b) => a[0] - b[0]);

    const continuationOf = new Map<string, ContinuationRow>();
    const windowMs = CONFIG.CONTINUATION_WINDOW_MINS * 60_000;
    let matched = 0, ambiguous = 0;
    for (const [tripId, next] of tripContinues) {
        const calls = tripsData.get(tripId)!;
        const last = calls[calls.length - 1]!;
        const arrivalMs = timeToOffsetMs(last.arrival || last.departure);
        const key = `${stopNameById.get(last.stopId)}|${next.line}|${activeTrips.get(tripId)!.serviceId}`;
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
        const nextCalls = found ? tripsData.get(found[1])! : null;
        continuationOf.set(tripId, [
            found ? found[1] : null,
            found ? activeTrips.get(found[1])!.routeId : (routeIdByName.get(next.line) ?? null),
            next.line,
            next.headsign,
            nextCalls ? nextCalls[0]!.departure : null,
        ]);
    }
    console.log(`Continuations: ${tripContinues.size} announced, ${matched} matched to a trip (${ambiguous} with several candidates, earliest kept)`);

    // --- DEPARTURES ---
    const departuresByStop = buildDepartures(
        gtfsBoardings(timetable, call => stopHeadsignOf(call).headsign),
        tripId => activeTrips.get(tripId)!,
        (b) => {
            const continues = b.call && stopHeadsignOf(b.call).continues ? continuationOf.get(b.tripId) : undefined;
            return continues ? { continues } : undefined;
        },
    );

    // --- SAFETY CHECK ---
    safetyCheck(departuresByStop.size, tripsData.size, CONFIG.MIN_DEPARTURE_STOPS, CONFIG.MIN_ACTIVE_TRIPS,
        `feed valid ${feedInfo?.feed_start_date ?? '?'}–${feedInfo?.feed_end_date ?? '?'}`);

    const tripRoutes: Record<string, string> = {};
    for (const [tripId, t] of activeTrips) tripRoutes[tripId] = t.routeId;

    // Brno's window plus a trailing direction_id for CSV trip matching.
    const windowsFile = tripWindows([...tripsData].map(([tripId, calls]) => [tripId, gtfsWindow(activeTrips.get(tripId)!, calls)]), days, tripId => activeTrips.get(tripId)!.directionId);

    // --- SHAPES (from shapes.txt) ---
    const tripShapes: Record<string, string> = {};
    const neededShapes = new Set<string>();
    for (const [tripId, t] of activeTrips) {
        if (!t.shapeId) continue;
        tripShapes[tripId] = t.shapeId;
        neededShapes.add(t.shapeId);
    }

    writeCityFiles(DATA_DIR, { features, routes, tripRoutes, tripWindows: windowsFile, stopRoutes, tripCalls: [...tripsData.values()].map(calls => calls.map(call => call.stopId)) });
    console.log(`Wrote ${stations.length} stations over ${platforms.length} platforms`);

    writeDepartures(DATA_DIR, departuresByStop, parentChildMap);

    // --- TRIPS ---
    const platformById = new Map(platforms.map(p => [p.stop_id, p]));
    const tripStops = new Map<string, TripStop[]>();
    for (const [tripId, calls] of tripsData) {
        const continues = continuationOf.get(tripId);
        const last = calls[calls.length - 1];
        tripStops.set(tripId, calls.map((call): TripStop =>
            gtfsTripStop(call, platformById.get(call.stopId), continues && call === last ? { continues_as: continues } : {})));
    }
    writeTrips(DATA_DIR, tripStops, windowsFile, tripRoutes);

    // --- SHAPE GEOMETRY ---
    const shapeGeometry = readGtfsShapes(zip, neededShapes, { coordDecimals: CONFIG.SHAPE_COORD_DECIMALS });
    const largestShapeFile = writeShapeBuckets(DATA_DIR, tripShapes, shapeGeometry);
    console.log(`Wrote ${shapeGeometry.size} shapes into hashed buckets (largest ${(largestShapeFile / 1024).toFixed(0)}KB)`);
    const shapedTrips = Object.entries(tripShapes).map(([tripId, shapeId]) => ({ routeId: activeTrips.get(tripId)!.routeId, shapeId }));
    writeNetwork(DATA_DIR, buildNetwork(shapedTrips, routes, shapeGeometry, CONFIG.NETWORK_MODES));

    console.log('Done!');
}

main().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
});
