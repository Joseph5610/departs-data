import type AdmZip from 'adm-zip';
import { METRO_EXITS_FILE, type MetroExitsFile, type MetroPlatformExits } from './contract.ts';
import { readTable } from './feed.ts';
import { writeJson } from './emit.ts';

const METRO_CONFIG = {
    /** Walking time assumed for a pathway segment that has no `traversal_time`. */
    DEFAULT_TRAVERSAL_S: 15,
    /** Cars whose step-free way out is within this of the best one count as equally good. */
    STEP_FREE_TIE_S: 15,
    /** Abort threshold guarding against a feed that lost its boardings or pathways. */
    MIN_PLATFORMS: 80,
} as const;

const TABLES = {
    stops: { required: ['stop_id', 'location_type'], optional: ['stop_name', 'parent_station'] },
    pathways: { required: ['from_stop_id', 'to_stop_id', 'pathway_mode', 'is_bidirectional'], optional: ['traversal_time', 'signposted_as', 'reversed_signposted_as'], fileOptional: true },
    boardings: { required: ['child_sequence', 'boarding_area_id'], fileOptional: true },
} as const;

/** GTFS `pathway_mode` values a wheelchair or pram cannot use: stairs and escalators. */
const STEPPED_MODES = new Set(['2', '4']);
const ENTRANCE = '2';

export interface MetroStop { name: string; type: string; parent: string }
export interface MetroPathway { from: string; to: string; mode: string; bidirectional: boolean; seconds: number | null; sign: string | null; reversedSign: string | null }
/** `[car number, boarding area id]`, car 1 at the front of the train. */
export type MetroBoarding = [number, string];

interface Edge { to: string; seconds: number; stepped: boolean }

/** Writes `metro_exits.json` into `dir` from the PID GTFS. */
export function writeMetroExits(zip: AdmZip, dir: string): void {
    const { stops, pathways, boardings } = readMetroTables(zip);
    const exits = buildMetroExits(stops, pathways, boardings);
    const count = Object.keys(exits).length;
    if (count < METRO_CONFIG.MIN_PLATFORMS) throw new Error(`Safety Check Failed: metro exits for only ${count} platforms. Aborting to prevent data wipeout.`);
    const size = writeJson(dir, METRO_EXITS_FILE, exits);
    console.log(`Wrote ${METRO_EXITS_FILE}: ${count} platforms, ${(size / 1024).toFixed(1)}KB`);
}

/** Reads the tables `buildMetroExits` needs from the PID GTFS. */
export function readMetroTables(zip: AdmZip): { stops: Map<string, MetroStop>; pathways: MetroPathway[]; boardings: MetroBoarding[] } {
    const stops = new Map<string, MetroStop>();
    for (const s of readTable(zip, 'stops.txt', TABLES.stops)) stops.set(s.stop_id, { name: (s.stop_name ?? '').trim(), type: s.location_type, parent: s.parent_station ?? '' });
    const pathways = readTable(zip, 'pathways.txt', TABLES.pathways).map((p): MetroPathway => ({
        from: p.from_stop_id,
        to: p.to_stop_id,
        mode: p.pathway_mode,
        bidirectional: p.is_bidirectional === '1',
        seconds: Number(p.traversal_time) || null,
        sign: p.signposted_as || null,
        reversedSign: p.reversed_signposted_as || null,
    }));
    const boardings = readTable(zip, 'vehicle_boardings.txt', TABLES.boardings).map((b): MetroBoarding => [Number(b.child_sequence), b.boarding_area_id]);
    return { stops, pathways, boardings };
}

/**
 * Which metro car to ride for the nearest way out at each platform, keyed by the platform's GTFS stop id,
 * from PID's `vehicle_boardings` (car -> boarding area on the platform) and `pathways` (area -> exits).
 */
export function buildMetroExits(stops: ReadonlyMap<string, MetroStop>, pathways: readonly MetroPathway[], boardings: readonly MetroBoarding[]): MetroExitsFile {
    const edges = new Map<string, Edge[]>();
    const signs = new Map<string, string>();
    const addEdge = (from: string, to: string, seconds: number, stepped: boolean, sign: string | null) => {
        let list = edges.get(from);
        if (!list) { list = []; edges.set(from, list); }
        list.push({ to, seconds, stepped });
        if (sign && stops.get(to)?.type === ENTRANCE && !signs.has(to)) signs.set(to, sign);
    };
    for (const p of pathways) {
        const seconds = p.seconds ?? METRO_CONFIG.DEFAULT_TRAVERSAL_S;
        const stepped = STEPPED_MODES.has(p.mode);
        addEdge(p.from, p.to, seconds, stepped, p.sign);
        if (p.bidirectional) addEdge(p.to, p.from, seconds, stepped, p.reversedSign);
    }

    const carsByPlatform = new Map<string, MetroBoarding[]>();
    for (const [car, area] of boardings) {
        const platform = stops.get(area)?.parent;
        if (!platform) continue;
        let list = carsByPlatform.get(platform);
        if (!list) { list = []; carsByPlatform.set(platform, list); }
        list.push([car, area]);
    }

    const out: MetroExitsFile = {};
    for (const [platform, cars] of [...carsByPlatform].sort(([a], [b]) => (a < b ? -1 : 1))) {
        cars.sort((a, b) => a[0] - b[0]);
        const byExit = new Map<string, number[]>();
        const stepFree: Array<{ car: number; seconds: number; name: string }> = [];
        for (const [car, area] of cars) {
            const nearest = nearestExit(area, edges, stops, false);
            const name = nearest && exitName(stops.get(nearest.exit)!.name);
            if (nearest && name) {
                const key = `${name}\u0000${signFor(nearest.exit, stops, signs) ?? ''}`;
                let list = byExit.get(key);
                if (!list) { list = []; byExit.set(key, list); }
                if (!list.includes(car)) list.push(car);
            }
            const free = nearestExit(area, edges, stops, true);
            const freeName = free && exitName(stops.get(free.exit)!.name);
            if (free && freeName) stepFree.push({ car, seconds: free.seconds, name: freeName });
        }
        if (byExit.size === 0) continue;

        const entry: MetroPlatformExits = {
            exits: [...byExit].map(([key, carList]) => {
                const [name, sign] = key.split('\u0000') as [string, string];
                return [name, sign || null, carList];
            }),
        };
        const best = Math.min(...stepFree.map(s => s.seconds));
        const tied = stepFree.filter(s => s.seconds - best <= METRO_CONFIG.STEP_FREE_TIE_S);
        if (tied.length > 0) entry.stepFree = [tied[0]!.name, [...new Set(tied.map(s => s.car))]];
        out[platform] = entry;
    }
    return out;
}

function nearestExit(
    start: string,
    edges: ReadonlyMap<string, Edge[]>,
    stops: ReadonlyMap<string, { type: string }>,
    stepFreeOnly: boolean
): { exit: string; seconds: number } | null {
    const dist = new Map<string, number>([[start, 0]]);
    const queue: Array<[number, string]> = [[0, start]];
    while (queue.length > 0) {
        queue.sort((a, b) => a[0] - b[0]);
        const [d, node] = queue.shift()!;
        if (d > (dist.get(node) ?? Infinity)) continue;
        if (stops.get(node)?.type === ENTRANCE) return { exit: node, seconds: d };
        for (const e of edges.get(node) ?? []) {
            if (stepFreeOnly && e.stepped) continue;
            const nd = d + e.seconds;
            if (nd < (dist.get(e.to) ?? Infinity)) { dist.set(e.to, nd); queue.push([nd, e.to]); }
        }
    }
    return null;
}

/** PID names exits "E1", or "(ul. Nádražní)" where unnumbered; "(-)" marks one with no public name. */
export function exitName(raw: string): string | null {
    const name = raw.replace(/^\((.*)\)$/, '$1').trim();
    return name && name !== '-' ? name : null;
}

/** The signposted destination of an exit without its repeated code ("E2 TRAM U Elektry" -> "TRAM U Elektry"). */
function signFor(exit: string, stops: ReadonlyMap<string, { name: string }>, signs: ReadonlyMap<string, string>): string | null {
    const sign = signs.get(exit)?.trim();
    const name = stops.get(exit)?.name ?? '';
    if (!sign || sign === name) return null;
    return sign.startsWith(`${name} `) ? sign.slice(name.length + 1).trim() || null : sign;
}
