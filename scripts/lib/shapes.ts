import path from 'node:path';
import type AdmZip from 'adm-zip';
import { readTable } from './feed.ts';
import { chunkBy, writeChunks } from './emit.ts';
import { SHAPE_BUCKETS_DIR, shapeBucketId, TRIP_SHAPE_BUCKETS_DIR, tripShapeBucketId, type ShapeGeometry, type ShapePoint } from './contract.ts';

const SHAPES_TABLE = {
    required: ['shape_id', 'shape_pt_sequence', 'shape_pt_lat', 'shape_pt_lon'],
    optional: ['shape_dist_traveled'],
    fileOptional: true,
} as const;

export interface ShapeReadOptions {
    /** Decimals kept on coordinates. */
    coordDecimals: number;
    /** Decimals kept on `shape_dist_traveled`; omitted, distances are not written. */
    distDecimals?: number;
}

/** The feed's `shapes.txt` as one ordered segment per shape, limited to `needed`. */
export function readGtfsShapes(zip: AdmZip, needed: ReadonlySet<string>, opts: ShapeReadOptions): Map<string, ShapeGeometry> {
    const points = new Map<string, Array<{ seq: number; point: ShapePoint }>>();
    const round = (x: number, decimals: number) => Number(x.toFixed(decimals));
    for (const pt of readTable(zip, 'shapes.txt', SHAPES_TABLE)) {
        if (!needed.has(pt.shape_id)) continue;
        const lon = round(Number(pt.shape_pt_lon), opts.coordDecimals);
        const lat = round(Number(pt.shape_pt_lat), opts.coordDecimals);
        const point: ShapePoint = opts.distDecimals !== undefined && pt.shape_dist_traveled
            ? [lon, lat, round(Number(pt.shape_dist_traveled), opts.distDecimals)]
            : [lon, lat];
        let list = points.get(pt.shape_id);
        if (!list) { list = []; points.set(pt.shape_id, list); }
        list.push({ seq: Number(pt.shape_pt_sequence), point });
    }

    const shapes = new Map<string, ShapeGeometry>();
    for (const [shapeId, list] of points) {
        list.sort((a, b) => a.seq - b.seq);
        shapes.set(shapeId, [list.map(p => p.point)]);
    }
    return shapes;
}

/**
 * Writes the app's route shapes: `trip_shape_buckets/` (trip -> shape_id) and `shape_buckets/`
 * (geometry), both hashed so the app reads one small file of each per trip. Returns the largest file.
 */
export function writeShapeBuckets(
    dataDir: string,
    tripShapes: Readonly<Record<string, string>>,
    shapes: ReadonlyMap<string, ShapeGeometry>,
    prune: 'all' | 'stale' = 'all'
): number {
    const tripLargest = writeChunks(path.join(dataDir, TRIP_SHAPE_BUCKETS_DIR), chunkBy(Object.entries(tripShapes), tripShapeBucketId), prune);
    const shapeLargest = writeChunks(path.join(dataDir, SHAPE_BUCKETS_DIR), chunkBy(shapes, shapeBucketId), prune);
    return Math.max(tripLargest, shapeLargest);
}
