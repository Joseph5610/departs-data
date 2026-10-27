import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { COVERAGE_CELL_DEG, COVERAGE_FILE, FEED_INDEX_DIR, RETIRED_OUTPUTS, SCHEDULE_DIR, STOPS_FILE, type CoverageFile, type StopsFile, type DepartureRow, type RouteInfo, type StopFeature, type TripWindowsFile } from './contract.ts';
import { writeStopSearch, type StopSearchOptions } from './stop-search.ts';
import { publishedRoutes } from './route-types.ts';
import { buildScheduleFiles } from './schedule.ts';
import { platformDirections } from './directions.ts';
import { gtfsStopsFile, routeOf, validateStopsFile, type RouteLookup } from './stops-file.ts';

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** A city's output directory, redirectable via `OUT_DIR` so a build can be diffed without touching the tracked data. */
export function outputDir(city: string): string {
    return process.env.OUT_DIR || path.join(REPO_ROOT, city);
}

export function writeJson(dir: string, name: string, data: unknown): number {
    const payload = JSON.stringify(data);
    fs.writeFileSync(path.join(dir, name), payload);
    return payload.length;
}

/** A `feed_index/` lookup. */
export function writeFeedIndex(dir: string, name: string, data: unknown): number {
    fs.mkdirSync(path.join(dir, FEED_INDEX_DIR), { recursive: true });
    return writeJson(path.join(dir, FEED_INDEX_DIR), name, data);
}

/** Groups entries into chunk files by `chunkIdOf`, preserving insertion order within each chunk. */
export function chunkBy<T>(entries: Iterable<readonly [string, T]>, chunkIdOf: (id: string) => string): Map<string, Record<string, T>> {
    const chunks = new Map<string, Record<string, T>>();
    for (const [id, value] of entries) {
        const chunkId = chunkIdOf(id);
        let chunk = chunks.get(chunkId);
        if (!chunk) { chunk = {}; chunks.set(chunkId, chunk); }
        chunk[id] = value;
    }
    return chunks;
}

/**
 * Writes a chunk directory. `prune: 'all'` recreates it from scratch; `prune: 'stale'` keeps the
 * directory and removes only files no longer backed by a chunk, for sets rebuilt incrementally.
 */
export function writeChunks(dir: string, chunks: Map<string, unknown>, prune: 'all' | 'stale' = 'all'): number {
    if (prune === 'all') {
        fs.rmSync(dir, { recursive: true, force: true });
        fs.mkdirSync(dir, { recursive: true });
    } else {
        fs.mkdirSync(dir, { recursive: true });
        for (const existing of fs.readdirSync(dir)) {
            if (existing.endsWith('.json') && !chunks.has(existing.replace('.json', ''))) {
                fs.unlinkSync(path.join(dir, existing));
            }
        }
    }
    let largest = 0;
    for (const [chunkId, data] of chunks) {
        const payload = JSON.stringify(data);
        largest = Math.max(largest, payload.length);
        fs.writeFileSync(path.join(dir, `${encodeURIComponent(chunkId)}.json`), payload);
    }
    return largest;
}

/** The distinct routes serving a stop, deduplicated by name and sorted as the UI lists them. */
export function linesOf(routeIds: Iterable<string> | undefined, routes: RouteLookup): RouteInfo[] {
    const seen = new Map<string, RouteInfo>();
    for (const id of routeIds ?? []) {
        const route = routeOf(routes, id);
        if (route && !seen.has(route.name)) seen.set(route.name, route);
    }
    return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
}

/** Sorts each stop's departures by timestamp, in place. */
export function sortDepartures(departuresByStop: Map<string, DepartureRow[]>): void {
    for (const deps of departuresByStop.values()) deps.sort((a, b) => a[3] - b[3]);
}

/** Refuses to overwrite good data with an empty or truncated upstream feed. */
export function safetyCheck(stops: number, trips: number, minStops: number, minTrips: number, context = ''): void {
    if (stops < minStops || trips < minTrips) {
        throw new Error(`Safety Check Failed: only ${stops} stops and ${trips} trips${context ? ` (${context})` : ''}. Aborting to prevent data wipeout.`);
    }
}

export interface CityFiles {
    features: StopFeature[];
    /** Each station's published id where it is not its feed id (`stableStationIds`). */
    stationIds?: ReadonlyMap<string, string>;
    routes: RouteLookup;
    tripRoutes: Record<string, string>;
    tripWindows: TripWindowsFile;
    /** Each platform's boardable route ids. */
    stopRoutes: ReadonlyMap<string, Iterable<string>>;
    /** Each active trip's stop ids in stop order, from which platforms without a code get their direction. */
    tripCalls: Iterable<readonly string[]>;
}

/** Validates and writes `stops.json`. */
function writeStopsFile(dir: string, file: StopsFile, routes: RouteLookup): void {
    validateStopsFile(file, routes);
    const bytes = writeJson(dir, STOPS_FILE, file);
    console.log(`Wrote ${STOPS_FILE}: ${file.stations.length} stations, ${file.platforms.length} platforms, ${file.entrances.length} entrances, ${(bytes / 1024).toFixed(0)}KB`);
}

/** Writes the grid of where the network has stops, counting each platform. */
function writeCoverage(dir: string, file: StopsFile): void {
    const cells: Record<string, number> = {};
    for (const { pos: [lng, lat] } of file.platforms) {
        const key = `${Math.floor(lng / COVERAGE_CELL_DEG)}|${Math.floor(lat / COVERAGE_CELL_DEG)}`;
        cells[key] = (cells[key] ?? 0) + 1;
    }
    const coverage: CoverageFile = { cell: COVERAGE_CELL_DEG, cells };
    const bytes = writeJson(dir, COVERAGE_FILE, coverage);
    console.log(`Wrote ${COVERAGE_FILE}: ${Object.keys(cells).length} cells, ${(bytes / 1024).toFixed(0)}KB`);
}

/** Deletes a city's `RETIRED_OUTPUTS`, so the next publish drops them from the data branch. */
export function removeRetired(dir: string): void {
    for (const name of RETIRED_OUTPUTS) fs.rmSync(path.join(dir, name), { recursive: true, force: true });
}

/**
 * What every city publishes about its stops and routes, in one place: `stops.json`, the coverage grid, the stop
 * search index and sitemap, and `routes.json` with app vehicle types instead of GTFS codes.
 */
export function writeStopsAndRoutes(dir: string, stops: StopsFile, routes: RouteLookup, search: StopSearchOptions = {}): void {
    writeStopsFile(dir, stops, routes);
    writeCoverage(dir, stops);
    const published = publishedRoutes(routes);
    writeStopSearch(dir, stops, published, search);
    writeJson(dir, 'routes.json', published);
}

/** Writes the root JSON files every GTFS city adapter reads. */
export function writeCityFiles(dir: string, files: CityFiles): void {
    fs.mkdirSync(dir, { recursive: true });
    removeRetired(dir);
    const directions = platformDirections(files.features, files.tripCalls);
    const stops = gtfsStopsFile(files.features, files.stopRoutes, directions, files.routes, files.stationIds);
    writeStopsAndRoutes(dir, stops, files.routes);
    const schedule = buildScheduleFiles(files.tripWindows, files.tripRoutes);
    const largestSchedule = writeChunks(path.join(dir, SCHEDULE_DIR), schedule);
    console.log(`Wrote ${schedule.size} schedule files, largest ${(largestSchedule / 1024).toFixed(0)}KB`);
}
