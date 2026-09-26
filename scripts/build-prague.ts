import fs from 'node:fs';
import type AdmZip from 'adm-zip';
import path from 'node:path';
import { outputDir, writeJson } from './lib/emit.ts';
import { MAP_STOPS_FILE, type RouteInfo } from './lib/contract.ts';
import { fetchZip, readTable } from './lib/feed.ts';
import { readStops } from './lib/stops.ts';
import { readGtfsShapes, writeShapeBuckets } from './lib/shapes.ts';
import { buildPragueMapStops, type GtfsStopFeature, type PidEnrichment } from './lib/pid-stops.ts';
import { writeStopSearch } from './lib/stop-search.ts';

/**
 * Prague (PID) stops.
 *
 * Writes `stops-enrichment.json`, an O(1) lookup of PID lines and names keyed by GTFS id that the
 * Worker still reads for departures and vehicle detail, `map-stops.json`, the final map stop list
 * built from the PID GTFS stops and that enrichment, and the route shapes the app reads directly.
 */
const CONFIG = {
    CITY: 'prague',
    SOURCE_URL: 'https://data.pid.cz/stops/json/stops.json',
    OUTPUT_FILE: 'stops-enrichment.json',
    /** Abort threshold guarding against an empty or truncated upstream feed. */
    MIN_ENTRIES: 1000,
    GTFS_URL: 'https://data.pid.cz/PID_GTFS.zip',
    /** Abort threshold for the GTFS stop list, which currently holds about 20,000 stops. */
    MIN_GTFS_STOPS: 10000,
    /** Abort threshold for trips with a shape, currently about 87,000. */
    MIN_SHAPED_TRIPS: 10000,
    /** Abort threshold for routes, currently about 900. */
    MIN_ROUTES: 500,
    /** ~1m; the map line gains nothing finer. */
    SHAPE_COORD_DECIMALS: 5,
    /** Kilometres to the metre, the resolution Golemio reports a vehicle's progress in. */
    SHAPE_DIST_DECIMALS: 3,
    /** PID's static feed populates `route_color` for every route (verified); this only guards a future gap. */
    DEFAULT_ROUTE_COLOR: '#888888',
} as const;

interface PidLine { name: string; type: string; exitOnly?: boolean }
interface PidStop { gtfsIds?: string[]; lines?: PidLine[]; mainTrafficType?: string }
interface PidGroup { stops?: PidStop[]; fullName?: string; name?: string; mainTrafficType?: string; avgLat?: number; avgLon?: number }

/** PID's portal rejects default agents, so the originals sent a browser UA; keep it. */
const FETCH_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36',
};

async function main(): Promise<void> {
    const dataDir = outputDir(CONFIG.CITY);
    console.log(`[SYNC] Fetching PID stops from ${CONFIG.SOURCE_URL}...`);

    const res = await fetch(CONFIG.SOURCE_URL, { headers: FETCH_HEADERS });
    if (!res.ok) throw new Error(`Failed to fetch: ${res.status} ${res.statusText}`);

    const data = await res.json() as { stopGroups?: PidGroup[] };
    console.log(`[SYNC] Received ${data.stopGroups?.length ?? 0} stop groups.`);

    const enrichmentMap: Record<string, PidEnrichment & Record<string, unknown>> = {};
    for (const g of data.stopGroups ?? []) {
        for (const s of g.stops ?? []) {
            for (const id of s.gtfsIds ?? []) {
                enrichmentMap[id] = {
                    l: (s.lines ?? []).map(l => ({ n: l.name, t: l.type, e: l.exitOnly ? 1 : 0 })),
                    n: g.fullName || g.name,
                    mtt: s.mainTrafficType || g.mainTrafficType,
                    alat: g.avgLat,
                    alon: g.avgLon,
                };
            }
        }
    }

    const count = Object.keys(enrichmentMap).length;
    console.log(`[SYNC] Processed ${count} GTFS IDs.`);
    if (count < CONFIG.MIN_ENTRIES) {
        throw new Error(`Suspiciously low number of entries (${count}). Aborting save to protect existing data.`);
    }

    fs.mkdirSync(dataDir, { recursive: true });
    const outputFile = path.join(dataDir, CONFIG.OUTPUT_FILE);
    fs.writeFileSync(outputFile, JSON.stringify(enrichmentMap));
    console.log(`[SYNC] SUCCESS: Saved enrichment data to ${outputFile}`);

    const zip = await fetchZip(CONFIG.GTFS_URL, 'GTFS_ZIP');
    writePragueRoutes(zip, dataDir);

    const gtfsStops = readGtfsStops(zip);
    const mapStops = buildPragueMapStops(gtfsStops, enrichmentMap);
    writeJson(dataDir, MAP_STOPS_FILE, mapStops);
    writeStopSearch(dataDir, mapStops);
    console.log(`[SYNC] SUCCESS: Saved ${mapStops.features.length} map stops to ${path.join(dataDir, MAP_STOPS_FILE)}`);

    writePragueShapes(zip, dataDir);
}

const isDigit = (c: string) => c >= '0' && c <= '9';

/**
 * The order Golemio lists stops in (letters before digits, case ignored, then case), which decides
 * the order of merged stop ids and the member a centroid is named after. Published ids are stored in
 * users' favorites and links, so this must not change.
 */
function compareStopIds(a: string, b: string): number {
    for (let i = 0; i < Math.min(a.length, b.length); i++) {
        const ca = a[i]!, cb = b[i]!;
        if (isDigit(ca) !== isDigit(cb)) return isDigit(ca) ? 1 : -1;
        const la = ca.toLowerCase(), lb = cb.toLowerCase();
        if (la !== lb) return la < lb ? -1 : 1;
    }
    if (a.length !== b.length) return a.length - b.length;
    return a < b ? -1 : a > b ? 1 : 0;
}

/** Every stop in the PID GTFS as a point feature. */
function readGtfsStops(zip: AdmZip): GtfsStopFeature[] {
    const rows = readStops(zip).sort((a, b) => compareStopIds(a.stop_id, b.stop_id));
    const stops = rows.map((s): GtfsStopFeature => ({
        type: 'Feature',
        geometry: { coordinates: [s.lon ?? 0, s.lat ?? 0], type: 'Point' },
        properties: {
            stop_id: s.stop_id,
            stop_name: s.stop_name || null,
            location_type: s.location_type,
            parent_station: s.parent_station,
            platform_code: s.platform_code,
            zone_id: s.zone_id,
        },
    }));

    console.log(`[SYNC] Read ${stops.length} GTFS stops.`);
    if (stops.length < CONFIG.MIN_GTFS_STOPS) {
        throw new Error(`Suspiciously low number of GTFS stops (${stops.length}). Aborting save to protect existing data.`);
    }
    return stops;
}

const ROUTES_TABLE = { required: ['route_id', 'route_type', 'route_short_name'], optional: ['route_color', 'is_substitute_transport'] } as const;

/** PID's own bright highlight for substitute (replacement) service and night lines - the static feed's `route_color` column never carries these, it colors every bus/tram plainly by type regardless. Matches `functions/_domain/golemio/vehicles/colors.ts`'s `SUBSTITUTE`/`NIGHT` constants exactly, so this migration doesn't silently drop them. */
const SUBSTITUTE_COLOR = '#FF4500';
const NIGHT_COLOR = '#262050';

/** Night trams are numbered 90-99, night buses 900-999 - Prague's numbering never reuses those ranges for a day route. */
function isNightRoute(name: string): boolean {
    const n = Number(name);
    if (!Number.isInteger(n)) return false;
    if (name.length === 2 && n >= 90 && n <= 99) return true;
    if (name.length === 3 && n >= 900 && n <= 999) return true;
    return false;
}

/**
 * Every route's display branding (name, type, color) - the same `RouteInfo` shape Brno/Prešov/DÚK
 * already publish, so the frontend can join a vehicle's `route_short_name` to a color for any of the
 * four cities the same way. PID's static feed carries a real hex per route (verified: all ~900 rows
 * populated) for everything except substitute/night lines, which need the same override the Worker's
 * heuristic already applied.
 */
function writePragueRoutes(zip: AdmZip, dataDir: string): void {
    const routes: Record<string, RouteInfo> = {};
    for (const r of readTable(zip, 'routes.txt', ROUTES_TABLE)) {
        const isSubstitute = r.is_substitute_transport === '1' || r.route_short_name.toUpperCase().startsWith('X');
        const routeColor = isSubstitute ? SUBSTITUTE_COLOR
            : isNightRoute(r.route_short_name) ? NIGHT_COLOR
            : r.route_color ? `#${r.route_color}` : CONFIG.DEFAULT_ROUTE_COLOR;
        routes[r.route_id] = {
            name: r.route_short_name,
            type: r.route_type,
            route_color: routeColor,
        };
    }
    const count = Object.keys(routes).length;
    if (count < CONFIG.MIN_ROUTES) {
        throw new Error(`Suspiciously low number of routes (${count}). Aborting save to protect existing data.`);
    }
    writeJson(dataDir, 'routes.json', routes);
    console.log(`[SYNC] SUCCESS: Saved ${count} routes to ${path.join(dataDir, 'routes.json')}`);
}

const TRIPS_TABLE = { required: ['trip_id', 'shape_id'] } as const;

/** Every trip's shape, with distances along it so the app can split the line at the vehicle. */
function writePragueShapes(zip: AdmZip, dataDir: string): void {
    const tripShapes: Record<string, string> = {};
    const needed = new Set<string>();
    for (const t of readTable(zip, 'trips.txt', TRIPS_TABLE)) {
        if (!t.shape_id) continue;
        tripShapes[t.trip_id] = t.shape_id;
        needed.add(t.shape_id);
    }
    const tripCount = Object.keys(tripShapes).length;
    if (tripCount < CONFIG.MIN_SHAPED_TRIPS) {
        throw new Error(`Suspiciously low number of trips with a shape (${tripCount}). Aborting save to protect existing data.`);
    }

    const shapes = readGtfsShapes(zip, needed, { coordDecimals: CONFIG.SHAPE_COORD_DECIMALS, distDecimals: CONFIG.SHAPE_DIST_DECIMALS });
    const largest = writeShapeBuckets(dataDir, tripShapes, shapes);
    console.log(`[SYNC] SUCCESS: Saved ${shapes.size} shapes for ${tripCount} trips (largest file ${(largest / 1024).toFixed(0)}KB)`);
}

main().catch((err: unknown) => {
    console.error('[SYNC] FAILED:', err);
    process.exit(1);
});
