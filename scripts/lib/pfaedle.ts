import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import AdmZip from 'adm-zip';
import type { ShapeGeometry, TripStop } from './contract.ts';
import { readTable } from './feed.ts';
import { readGtfsShapes } from './shapes.ts';

/*
 * Route shapes for a network whose sources ship none (DÚK's JDF), drawn by pfaedle
 * (github.com/ad-freiburg/pfaedle) on OpenStreetMap: each distinct run of located stops is
 * map-matched once, through the tool's Docker image, and shared by every trip that runs it.
 */

const PFAEDLE_IMAGE = 'ghcr.io/ad-freiburg/pfaedle:latest';

/** Route types pfaedle has no profile for, as one that runs on the same infrastructure: a trolleybus keeps to a bus's roads. */
const PFAEDLE_ROUTE_TYPES: Record<string, string> = { '11': '3' };

/** One distinct run of located stops of one mode, which the trips sharing it share a shape for. */
export interface ShapePattern {
    routeType: string;
    stops: Array<{ lat: number; lon: number }>;
}

/**
 * The trips' distinct runs, keyed by a shape id that stays the same while the run does, and each trip's
 * shape id. A trip with fewer than two located stops gets none.
 */
export function shapePatterns(
    tripStops: ReadonlyMap<string, readonly TripStop[]>,
    routeTypeOf: (tripId: string) => string,
): { patterns: Map<string, ShapePattern>; tripShapes: Record<string, string> } {
    const patterns = new Map<string, ShapePattern>();
    const tripShapes: Record<string, string> = {};
    for (const [tripId, stops] of tripStops) {
        const located = stops.flatMap(s => (s.lat !== undefined && s.lon !== undefined ? [{ lat: s.lat, lon: s.lon }] : []));
        if (located.length < 2) continue;
        const routeType = routeTypeOf(tripId);
        const shapeId = createHash('sha1').update(`${routeType}|${located.map(s => `${s.lat},${s.lon}`).join(';')}`).digest('hex').slice(0, 16);
        if (!patterns.has(shapeId)) patterns.set(shapeId, { routeType, stops: located });
        tripShapes[tripId] = shapeId;
    }
    return { patterns, tripShapes };
}

/** `patterns` as a minimal GTFS feed: one trip per pattern, under the pattern's own id. */
function writePatternFeed(file: string, patterns: ReadonlyMap<string, ShapePattern>): void {
    const stopIds = new Map<string, string>();
    const stopIdOf = (s: { lat: number; lon: number }) => {
        const key = `${s.lat},${s.lon}`;
        if (!stopIds.has(key)) stopIds.set(key, `s${stopIds.size}`);
        return stopIds.get(key)!;
    };
    const routeTypes = new Set<string>();
    const trips: string[] = [];
    const stopTimes: string[] = [];
    for (const [id, p] of patterns) {
        const type = PFAEDLE_ROUTE_TYPES[p.routeType] ?? p.routeType;
        routeTypes.add(type);
        trips.push(`r${type},${id},all`);
        p.stops.forEach((s, i) => {
            const time = `${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}:00`;
            stopTimes.push(`${id},${time},${time},${stopIdOf(s)},${i + 1}`);
        });
    }
    const zip = new AdmZip();
    const add = (name: string, lines: string[]) => zip.addFile(name, Buffer.from(lines.join('\n') + '\n'));
    add('agency.txt', ['agency_id,agency_name,agency_url,agency_timezone', 'a,a,https://departs.app,Europe/Prague']);
    add('calendar.txt', ['service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date', 'all,1,1,1,1,1,1,1,20000101,20991231']);
    add('routes.txt', ['route_id,agency_id,route_short_name,route_type', ...[...routeTypes].map(t => `r${t},a,${t},${t}`)]);
    add('stops.txt', ['stop_id,stop_name,stop_lat,stop_lon', ...[...stopIds].map(([key, id]) => `${id},${id},${key}`)]);
    add('trips.txt', ['route_id,trip_id,service_id', ...trips]);
    add('stop_times.txt', ['trip_id,arrival_time,departure_time,stop_id,stop_sequence', ...stopTimes]);
    zip.writeZip(file);
}

/**
 * Each pattern's shape, by pfaedle map-matching it on `osmFile` (OSM PBF or XML). A pattern pfaedle
 * returns no shape for is left out.
 */
export function shapesFromOsm(osmFile: string, patterns: ReadonlyMap<string, ShapePattern>, coordDecimals: number): Map<string, ShapeGeometry> {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'pfaedle-'));
    try {
        fs.mkdirSync(path.join(work, 'in'));
        fs.mkdirSync(path.join(work, 'out'));
        writePatternFeed(path.join(work, 'in', 'feed.zip'), patterns);
        const osm = path.resolve(osmFile);
        execFileSync('docker', [
            'run', '--rm', '--user', `${process.getuid?.() ?? 0}:${process.getgid?.() ?? 0}`,
            '-v', `${path.dirname(osm)}:/osm:ro`, '-v', `${path.join(work, 'in')}:/gtfs:ro`, '-v', `${path.join(work, 'out')}:/gtfs-out`,
            PFAEDLE_IMAGE, '-D', '-x', `/osm/${path.basename(osm)}`, '-i', '/gtfs/feed.zip',
        ], { stdio: 'inherit' });

        const out = new AdmZip();
        out.addLocalFolder(path.join(work, 'out'));
        const shapeOf = new Map(readTable(out, 'trips.txt', { required: ['trip_id', 'shape_id'] }).map(t => [t.trip_id, t.shape_id]));
        const geometry = readGtfsShapes(out, new Set(shapeOf.values()), { coordDecimals });
        const shapes = new Map<string, ShapeGeometry>();
        for (const id of patterns.keys()) {
            const shape = geometry.get(shapeOf.get(id) ?? '');
            if (shape) shapes.set(id, shape);
        }
        return shapes;
    } finally {
        fs.rmSync(work, { recursive: true, force: true });
    }
}
