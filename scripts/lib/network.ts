import { NETWORK_FILE, type NetworkFeature, type NetworkFile, type RouteInfo, type ShapeGeometry } from './contract.ts';
import { localXY, type Point } from './geo.ts';
import { writeJson } from './emit.ts';
import { routeOf, type RouteLookup } from './stops-file.ts';

/** How one GTFS route type is drawn: each route as its own coloured line, or every route merged into one track network. */
export interface NetworkMode {
    routeTypes: readonly string[];
    style: 'lines' | 'merged';
    /** Abort threshold for the mode's drawn length, guarding against an empty or truncated shape source. */
    minKm: number;
}

const CONFIG = {
    /** A shape run by fewer than this share of its route's trips is a depot run or short turn, not the line. */
    MIN_SHAPE_SHARE: 0.1,
    /** Tracks closer than this are drawn as one, so a street's two directions read as a single line. */
    MERGE_DISTANCE_M: 25,
    /** Spacing of the points coverage is checked at. */
    SAMPLE_M: 3,
    /** Every nth sampled point is kept in the output. */
    KEEP_EVERY: 3,
    COORD_DECIMALS: 5,
} as const;

type Coord = [number, number];
interface Trip { routeId: string; shapeId: string }

/**
 * The network file for `modes`: each route's usual shapes (those carrying at least MIN_SHAPE_SHARE of
 * its trips), drawn per route for `lines` modes and merged into one track network for `merged` ones.
 * Throws when a mode draws less than its `minKm`.
 */
export function buildNetwork(
    trips: Iterable<Trip>,
    routes: RouteLookup,
    shapes: ReadonlyMap<string, ShapeGeometry>,
    modes: readonly NetworkMode[],
): NetworkFile {
    const tripsByShape = new Map<string, Map<string, number>>();
    for (const { routeId, shapeId } of trips) {
        let counts = tripsByShape.get(routeId);
        if (!counts) { counts = new Map(); tripsByShape.set(routeId, counts); }
        counts.set(shapeId, (counts.get(shapeId) ?? 0) + 1);
    }

    const features: NetworkFeature[] = [];
    for (const mode of modes) {
        const types = new Set(mode.routeTypes);
        const routeIds = [...tripsByShape.keys()].filter(id => types.has(routeOf(routes, id)?.type ?? '')).sort();
        const modeFeatures = mode.style === 'lines'
            ? routeIds.flatMap(id => routeLine(id, routeOf(routes, id)!, tripsByShape.get(id)!, shapes))
            : mergedTrack(routeIds.flatMap(id => usualShapes(tripsByShape.get(id)!, shapes)), Number(mode.routeTypes[0]));
        const km = modeFeatures.reduce((sum, f) => sum + lengthM(f.geometry.coordinates), 0) / 1000;
        if (km < mode.minKm) {
            throw new Error(`Network for route types ${mode.routeTypes.join(',')} is only ${km.toFixed(1)} km (expected >= ${mode.minKm}). Aborting save to protect existing data.`);
        }
        console.log(`Network: route types ${mode.routeTypes.join(',')} drawn as ${modeFeatures.length} ${mode.style === 'lines' ? 'lines' : 'pieces'}, ${km.toFixed(1)} km`);
        features.push(...modeFeatures);
    }
    return { type: 'FeatureCollection', features };
}

export function writeNetwork(dir: string, network: NetworkFile): void {
    const bytes = writeJson(dir, NETWORK_FILE, network);
    console.log(`Wrote ${NETWORK_FILE}: ${network.features.length} features, ${(bytes / 1024).toFixed(0)}KB`);
}

/** The route's shapes run by at least MIN_SHAPE_SHARE of its trips, as plain lines, in id order. */
function usualShapes(counts: ReadonlyMap<string, number>, shapes: ReadonlyMap<string, ShapeGeometry>): { id: string; trips: number; lines: Coord[][] }[] {
    const total = [...counts.values()].reduce((a, b) => a + b, 0);
    const out: { id: string; trips: number; lines: Coord[][] }[] = [];
    for (const [id, trips] of [...counts].sort((a, b) => a[0].localeCompare(b[0]))) {
        const geometry = shapes.get(id);
        if (!geometry || trips < CONFIG.MIN_SHAPE_SHARE * total) continue;
        out.push({ id, trips, lines: geometry.map(segment => segment.map(p => [p[0], p[1]] as Coord)).filter(l => l.length >= 2) });
    }
    return out;
}

/** The route's variant carrying most of its service (trips times length), so neither a short turn nor a rare extension wins. */
function routeLine(routeId: string, route: RouteInfo, counts: ReadonlyMap<string, number>, shapes: ReadonlyMap<string, ShapeGeometry>): NetworkFeature[] {
    let best: { score: number; coords: Coord[] } | null = null;
    for (const shape of usualShapes(counts, shapes)) {
        const coords = shape.lines.flat();
        const score = shape.trips * lengthM(coords);
        if (!best || score > best.score) best = { score, coords };
    }
    if (!best) return [];
    return [{
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: best.coords.map(round) },
        properties: { route_type: Number(route.type), route_id: routeId, name: route.name, route_color: route.route_color },
    }];
}

/**
 * Every stretch of track drawn once: shapes are walked longest first, and only the parts further than
 * MERGE_DISTANCE_M from track already drawn are added, each joined at its ends onto the track it leaves.
 */
function mergedTrack(shapes: readonly { lines: Coord[][] }[], routeType: number): NetworkFeature[] {
    const lines = shapes.flatMap(s => s.lines).map(densify).sort((a, b) => b.length - a.length);
    const origin: Point = lines.length ? { lon: lines[0]![0]![0], lat: lines[0]![0]![1] } : { lon: 0, lat: 0 };
    const grid = new TrackGrid(origin);

    const runs: Coord[][] = [];
    for (const line of lines) {
        const covered = line.map(p => grid.covers(p));
        let start = -1;
        for (let i = 0; i <= line.length; i++) {
            if (i < line.length && !covered[i]) {
                if (start < 0) start = i;
                continue;
            }
            if (start < 0) continue;
            const run = line.slice(start, i);
            const head = start > 0 ? grid.nearest(run[0]!) : null;
            const tail = i < line.length ? grid.nearest(run.at(-1)!) : null;
            if (head) run.unshift(head);
            if (tail) run.push(tail);
            if (run.length >= 3) runs.push(run);
            start = -1;
        }
        line.forEach((p, i) => { if (!covered[i]) grid.add(p); });
    }
    return runs.map(run => ({
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: run.filter((_, i) => i % CONFIG.KEEP_EVERY === 0 || i === run.length - 1).map(round) },
        properties: { route_type: routeType },
    }));
}

/** Drawn track points bucketed by MERGE_DISTANCE_M cells, for nearby lookups. */
class TrackGrid {
    private readonly cells = new Map<string, Coord[]>();
    private readonly origin: Point;
    constructor(origin: Point) { this.origin = origin; }

    add(p: Coord): void {
        const key = this.cellKey(p);
        const cell = this.cells.get(key);
        if (cell) cell.push(p); else this.cells.set(key, [p]);
    }

    covers(p: Coord): boolean {
        return this.within(p, CONFIG.MERGE_DISTANCE_M) !== null;
    }

    /** The closest drawn point within twice the merge distance, where a run rejoins the track. */
    nearest(p: Coord): Coord | null {
        return this.within(p, 2 * CONFIG.MERGE_DISTANCE_M);
    }

    private within(p: Coord, radius: number): Coord | null {
        const { x, y } = this.xy(p);
        const reach = Math.ceil(radius / CONFIG.MERGE_DISTANCE_M);
        const cx = Math.floor(x / CONFIG.MERGE_DISTANCE_M), cy = Math.floor(y / CONFIG.MERGE_DISTANCE_M);
        let best: Coord | null = null, bestD = radius;
        for (let dx = -reach; dx <= reach; dx++) for (let dy = -reach; dy <= reach; dy++) {
            for (const q of this.cells.get(`${cx + dx}|${cy + dy}`) ?? []) {
                const qxy = this.xy(q);
                const d = Math.hypot(qxy.x - x, qxy.y - y);
                if (d <= bestD) { bestD = d; best = q; }
            }
        }
        return best;
    }

    private cellKey(p: Coord): string {
        const { x, y } = this.xy(p);
        return `${Math.floor(x / CONFIG.MERGE_DISTANCE_M)}|${Math.floor(y / CONFIG.MERGE_DISTANCE_M)}`;
    }

    private xy(p: Coord): { x: number; y: number } {
        return localXY(this.origin, { lon: p[0], lat: p[1] });
    }
}

/** The line with a point every SAMPLE_M or closer, so coverage is checked along it, not only at its vertices. */
function densify(line: readonly Coord[]): Coord[] {
    const out: Coord[] = [line[0]!];
    for (let i = 1; i < line.length; i++) {
        const a = line[i - 1]!, b = line[i]!;
        const steps = Math.max(1, Math.ceil(segmentM(a, b) / CONFIG.SAMPLE_M));
        for (let k = 1; k <= steps; k++) out.push([a[0] + (b[0] - a[0]) * k / steps, a[1] + (b[1] - a[1]) * k / steps]);
    }
    return out;
}

function segmentM(a: Coord, b: Coord): number {
    const { x, y } = localXY({ lon: a[0], lat: a[1] }, { lon: b[0], lat: b[1] });
    return Math.hypot(x, y);
}

function lengthM(line: readonly Coord[]): number {
    let sum = 0;
    for (let i = 1; i < line.length; i++) sum += segmentM(line[i - 1]!, line[i]!);
    return sum;
}

const round = (p: Coord): Coord => [Number(p[0].toFixed(CONFIG.COORD_DECIMALS)), Number(p[1].toFixed(CONFIG.COORD_DECIMALS))];
