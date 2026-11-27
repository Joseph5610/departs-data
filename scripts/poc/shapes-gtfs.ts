/**
 * PoC: a minimal GTFS of a few published DÚK lines (one trip per stop pattern), for pfaedle to draw shapes on.
 * Usage: [DATA_DIR=<data branch>/duk] node scripts/poc/shapes-gtfs.ts <out dir> <route id>...
 */
import fs from 'node:fs';
import path from 'node:path';
import { tripBucketId } from '../lib/contract.ts';

/** The published DÚK folder: a checkout of the data branch (DATA_DIR), else data.departs.app. */
const BASE = process.env.DATA_DIR ?? 'https://data.departs.app/duk';
const [outDir, ...routeIds] = process.argv.slice(2);
if (!outDir || routeIds.length === 0) throw new Error('usage: shapes-gtfs.ts <out dir> <route id>...');

const get = async <T>(url: string): Promise<T> => {
    if (!/^https?:/.test(url)) return JSON.parse(fs.readFileSync(url, 'utf8')) as T;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${url}: ${res.status}`);
    return res.json() as Promise<T>;
};

const routes = await get<Record<string, { name: string; type: string }>>(`${BASE}/routes.json`);
const GTFS_TYPE: Record<string, number> = { bus: 3, trolleybus: 11, tram: 0, train: 2, ferry: 4, funicular: 7 };

const tripsOfRoute = new Map<string, Set<string>>();
for (let h = 0; h < 24; h++) {
    const s = await get<{ routes: string[]; trips: Record<string, number[]> }>(`${BASE}/schedule/${String(h).padStart(2, '0')}.json`);
    for (const [tripId, t] of Object.entries(s.trips)) {
        const routeId = s.routes[t[3]!];
        if (!routeId || !routeIds.includes(routeId)) continue;
        if (!tripsOfRoute.has(routeId)) tripsOfRoute.set(routeId, new Set());
        tripsOfRoute.get(routeId)!.add(tripId);
    }
}

type Stop = { stop_id: string; name: string; arrival_time: string; departure_time: string; lat?: number; lon?: number };
const buckets = new Map<string, Record<string, Stop[]>>();
const stops = new Map<string, { name: string; lat: number; lon: number }>();
const out = { trips: [] as string[], stopTimes: [] as string[] };
for (const [routeId, tripIds] of tripsOfRoute) {
    const patterns = new Set<string>();
    for (const tripId of tripIds) {
        const b = tripBucketId(tripId);
        if (!buckets.has(b)) buckets.set(b, await get(`${BASE}/trip_buckets/${b}.json`));
        const calls = (buckets.get(b)![tripId] ?? []).filter(s => s.lat !== undefined && s.lon !== undefined);
        if (calls.length < 2) continue;
        const pattern = calls.map(c => `${c.lat},${c.lon}`).join(';');
        if (patterns.has(pattern)) continue;
        patterns.add(pattern);
        out.trips.push(`${routeId},${tripId},all`);
        calls.forEach((c, i) => {
            const id = c.stop_id || `${c.lat}_${c.lon}`;
            stops.set(id, { name: c.name, lat: c.lat!, lon: c.lon! });
            out.stopTimes.push(`${tripId},${c.arrival_time || c.departure_time},${c.departure_time || c.arrival_time},${id},${i + 1}`);
        });
    }
    console.log(`${routeId} (${routes[routeId]?.name}): ${tripIds.size} trips, ${patterns.size} stop patterns`);
}

const q = (s: string) => `"${s.replaceAll('"', '""')}"`;
fs.mkdirSync(outDir, { recursive: true });
const write = (name: string, lines: string[]) => fs.writeFileSync(path.join(outDir, name), lines.join('\n') + '\n');
write('agency.txt', ['agency_id,agency_name,agency_url,agency_timezone', 'duk,DÚK,https://departs.app,Europe/Prague']);
write('routes.txt', ['route_id,agency_id,route_short_name,route_type', ...[...tripsOfRoute.keys()].map(r => `${r},duk,${q(routes[r]?.name ?? r)},${GTFS_TYPE[routes[r]?.type ?? 'bus'] ?? 3}`)]);
write('calendar.txt', ['service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date', 'all,1,1,1,1,1,1,1,20260101,20271231']);
write('stops.txt', ['stop_id,stop_name,stop_lat,stop_lon', ...[...stops].map(([id, s]) => `${id},${q(s.name)},${s.lat},${s.lon}`)]);
write('trips.txt', ['route_id,trip_id,service_id', ...out.trips]);
write('stop_times.txt', ['trip_id,arrival_time,departure_time,stop_id,stop_sequence', ...out.stopTimes]);
console.log(`GTFS: ${out.trips.length} trips, ${stops.size} stops`);
