import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DepartureRow, ParentChildMap, RouteInfo, StopFeature, TripWindowsFile } from './contract.ts';

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
export type RouteLookup = ReadonlyMap<string, RouteInfo> | Record<string, RouteInfo>;

export function linesOf(routeIds: Iterable<string> | undefined, routes: RouteLookup): RouteInfo[] {
    const lookup = (id: string): RouteInfo | undefined =>
        routes instanceof Map ? routes.get(id) : (routes as Record<string, RouteInfo>)[id];
    const seen = new Map<string, RouteInfo>();
    for (const id of routeIds ?? []) {
        const route = lookup(id);
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
    parentChildMap: ParentChildMap;
    routes: RouteLookup;
    tripRoutes: Record<string, string>;
    tripWindows: TripWindowsFile;
    /** Omitted where the city writes its own geometry mapping later, so an earlier file is not clobbered. */
    tripShapes?: Record<string, string> | undefined;
}

/** Writes the six root JSON files every city adapter reads. */
export function writeCityFiles(dir: string, files: CityFiles): void {
    fs.mkdirSync(dir, { recursive: true });
    writeJson(dir, 'stops.json', files.features);
    writeJson(dir, 'parent_child_map.json', files.parentChildMap);
    writeJson(dir, 'routes.json', files.routes instanceof Map ? Object.fromEntries(files.routes) : files.routes);
    writeJson(dir, 'trip_routes.json', files.tripRoutes);
    if (files.tripShapes) writeJson(dir, 'trip_shapes.json', files.tripShapes);
    const bytes = writeJson(dir, 'trip_windows.json', files.tripWindows);
    console.log(`Wrote trip_windows.json: ${Object.keys(files.tripWindows.trips).length} trips, ${(bytes / 1024).toFixed(0)}KB`);
}
