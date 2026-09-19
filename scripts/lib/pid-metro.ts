import type AdmZip from 'adm-zip';
import type { MetroExitsFile, MetroPlatformExits } from './contract.ts';
import { readTable } from './feed.ts';

const METRO_CONFIG = {
    /** Walking time assumed for a pathway segment that has no `traversal_time`. */
    DEFAULT_TRAVERSAL_S: 15,
    /** Cars whose step-free way out is within this of the best one count as equally good. */
    STEP_FREE_TIE_S: 15,
} as const;

const TABLES = {
    stops: { required: ['stop_id', 'stop_name', 'location_type'], optional: ['parent_station'] },
    pathways: { required: ['from_stop_id', 'to_stop_id', 'pathway_mode', 'is_bidirectional'], optional: ['traversal_time', 'signposted_as', 'reversed_signposted_as'], fileOptional: true },
    boardings: { required: ['vehicle_category_id', 'child_sequence', 'boarding_area_id'], fileOptional: true },
} as const;

/** GTFS `pathway_mode` values a wheelchair or pram cannot use. */
const STEPPED_MODES = new Set(['2', '4']);
const ENTRANCE = '2';

interface Edge { to: string; seconds: number; stepped: boolean }

/** A metro trip's platforms in travel order, with its line name. */
export interface MetroPattern { line: string; platforms: string[] }

/**
 * Which metro car to ride for the nearest way out at each platform, from PID's `vehicle_boardings`
 * (car -> platform section) and `pathways` (section -> exits). Car 1 is the front of the train in
 * the direction of travel, as PID numbers the coupling per platform.
 */
export function buildMetroExits(zip: AdmZip, patterns: Iterable<MetroPattern>): MetroExitsFile {
    const stops = new Map<string, { name: string; type: string; parent: string }>();
    for (const s of readTable(zip, 'stops.txt', TABLES.stops)) stops.set(s.stop_id, { name: s.stop_name.trim(), type: s.location_type, parent: s.parent_station ?? '' });

    const edges = new Map<string, Edge[]>();
    const hints = new Map<string, string>();
    const addEdge = (from: string, to: string, seconds: number, stepped: boolean, sign: string | undefined) => {
        let list = edges.get(from);
        if (!list) { list = []; edges.set(from, list); }
        list.push({ to, seconds, stepped });
        if (sign && stops.get(to)?.type === ENTRANCE && !hints.has(to)) hints.set(to, sign);
    };
    for (const p of readTable(zip, 'pathways.txt', TABLES.pathways)) {
        const seconds = Number(p.traversal_time) || METRO_CONFIG.DEFAULT_TRAVERSAL_S;
        const stepped = STEPPED_MODES.has(p.pathway_mode);
        addEdge(p.from_stop_id, p.to_stop_id, seconds, stepped, p.signposted_as);
        if (p.is_bidirectional === '1') addEdge(p.to_stop_id, p.from_stop_id, seconds, stepped, p.reversed_signposted_as);
    }

    const carsByPlatform = new Map<string, Array<[number, string]>>();
    for (const b of readTable(zip, 'vehicle_boardings.txt', TABLES.boardings)) {
        const platform = stops.get(b.boarding_area_id)?.parent;
        if (!platform) continue;
        let list = carsByPlatform.get(platform);
        if (!list) { list = []; carsByPlatform.set(platform, list); }
        list.push([Number(b.child_sequence), b.boarding_area_id]);
    }

    const platforms: Record<string, MetroPlatformExits> = {};
    for (const [platform, cars] of carsByPlatform) {
        cars.sort((a, b) => a[0] - b[0]);
        const exits = new Map<string, number[]>();
        let bestStepFree = Infinity;
        const stepFree: Array<{ car: number; seconds: number; exit: string }> = [];
        for (const [car, area] of cars) {
            const nearest = nearestExit(area, edges, stops, false);
            if (nearest) {
                let list = exits.get(nearest.exit);
                if (!list) { list = []; exits.set(nearest.exit, list); }
                list.push(car);
            }
            const free = nearestExit(area, edges, stops, true);
            if (free) {
                stepFree.push({ car, seconds: free.seconds, exit: free.exit });
                bestStepFree = Math.min(bestStepFree, free.seconds);
            }
        }
        if (exits.size === 0) continue;

        const named = [...exits].filter(([exit]) => exitName(stops.get(exit)!.name));
        if (named.length === 0) continue;
        const entry: MetroPlatformExits = {
            exits: named.map(([exit, carList]) => [exitName(stops.get(exit)!.name)!, hintFor(exit, stops, hints), carList]),
        };
        const bestFree = stepFree.filter(s => s.seconds - bestStepFree <= METRO_CONFIG.STEP_FREE_TIE_S);
        const freeName = bestFree.length > 0 ? exitName(stops.get(bestFree[0]!.exit)!.name) : null;
        if (freeName) entry.stepFree = [freeName, bestFree.map(s => s.car)];
        platforms[platform] = entry;
    }

    // Direction comes from the neighbouring station, since trip detail upstream carries no platform ids.
    const keys: Record<string, string> = {};
    for (const { line, platforms: seq } of patterns) {
        for (let i = 0; i < seq.length; i++) {
            const here = seq[i]!;
            if (!platforms[here]) continue;
            const name = stops.get(here)?.name;
            const next = seq[i + 1] ? stops.get(seq[i + 1]!)?.name : undefined;
            const prev = seq[i - 1] ? stops.get(seq[i - 1]!)?.name : undefined;
            if (name && next) keys[metroKey(line, name, '>', next)] = here;
            if (name && prev) keys[metroKey(line, name, '<', prev)] = here;
        }
    }
    return { keys, platforms };
}

/** `A|Můstek|>Muzeum`: the platform of line A at Můstek whose next station is Muzeum. */
export const metroKey = (line: string, station: string, side: '>' | '<', neighbour: string): string => `${line}|${station}|${side}${neighbour}`;

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
function exitName(raw: string): string | null {
    const name = raw.replace(/^\((.*)\)$/, '$1').trim();
    return name && name !== '-' ? name : null;
}

/** The signposted destination of an exit without its repeated code ("E2 TRAM U Elektry" -> "TRAM U Elektry"). */
function hintFor(exit: string, stops: ReadonlyMap<string, { name: string }>, hints: ReadonlyMap<string, string>): string | null {
    const sign = hints.get(exit);
    const name = stops.get(exit)?.name ?? '';
    if (!sign || sign === name) return null;
    return sign.startsWith(`${name} `) ? sign.slice(name.length + 1).trim() : sign;
}
