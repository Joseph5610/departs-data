import type AdmZip from 'adm-zip';
import { METRO_EXITS_FILE, type MetroExitsFile, type MetroPlatformExits } from './contract.ts';
import { readTable } from './feed.ts';
import { writeJson } from './emit.ts';
import type { GtfsStop } from './stops.ts';

const METRO_CONFIG = {
    /** Walking time assumed for a pathway segment that has no `traversal_time`. */
    DEFAULT_TRAVERSAL_S: 15,
    /** Abort threshold guarding against a feed that lost its boardings or pathways. */
    MIN_PLATFORMS: 80,
} as const;

const TABLES = {
    pathways: { required: ['from_stop_id', 'to_stop_id', 'pathway_mode', 'is_bidirectional'], optional: ['traversal_time', 'signposted_as', 'reversed_signposted_as'], fileOptional: true },
    boardings: { required: ['child_sequence', 'boarding_area_id'], fileOptional: true },
} as const;

/** GTFS `pathway_mode` values a wheelchair or pram cannot use: stairs and escalators. */
const STEPPED_MODES = new Set(['2', '4']);
const ENTRANCE = 2;
const BOARDING_AREA = 4;

export interface MetroPathway { from: string; to: string; mode: string; bidirectional: boolean; seconds: number | null; sign: string | null; reversedSign: string | null }
/** `[car number, boarding area id]`, car 1 at the front of the train. */
export type MetroBoarding = [number, string];
/** The `stops.txt` columns the walk needs. */
export type MetroStop = Pick<GtfsStop, 'stop_id' | 'stop_name' | 'location_type' | 'parent_station'>;

interface Edge { to: string; seconds: number; stepped: boolean; sign: string | null; transfer: boolean }

/** Writes `metro_exits.json` into `dir` from the PID GTFS and its already read `stops.txt`. */
export function writeMetroExits(zip: AdmZip, stops: readonly MetroStop[], dir: string): void {
    const { pathways, boardings } = readMetroLinks(zip);
    const exits = buildMetroExits(stops, pathways, boardings);
    const count = Object.keys(exits).length;
    if (count < METRO_CONFIG.MIN_PLATFORMS) throw new Error(`Safety Check Failed: metro exits for only ${count} platforms. Aborting to prevent data wipeout.`);
    const size = writeJson(dir, METRO_EXITS_FILE, exits);
    console.log(`Wrote ${METRO_EXITS_FILE}: ${count} platforms, ${(size / 1024).toFixed(1)}KB`);
}

/** Reads `pathways.txt` and `vehicle_boardings.txt` from the PID GTFS. */
export function readMetroLinks(zip: AdmZip): { pathways: MetroPathway[]; boardings: MetroBoarding[] } {
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
    return { pathways, boardings };
}

/**
 * At which metro car the stairs, escalator or lift to each way out leave each platform, transfers to other lines left out, keyed by the platform's GTFS stop id,
 * from PID's `vehicle_boardings` (car -> boarding area on the platform) and `pathways` (area -> exits).
 */
export function buildMetroExits(stopRows: readonly MetroStop[], pathways: readonly MetroPathway[], boardings: readonly MetroBoarding[]): MetroExitsFile {
    const stops = new Map(stopRows.map(s => [s.stop_id, s]));
    const edges = new Map<string, Edge[]>();
    const signs = new Map<string, string>();
    const addEdge = (from: string, to: string, seconds: number, stepped: boolean, sign: string | null, transfer: boolean) => {
        let list = edges.get(from);
        if (!list) { list = []; edges.set(from, list); }
        list.push({ to, seconds, stepped, sign, transfer });
        if (sign && stops.get(to)?.location_type === ENTRANCE && !signs.has(to)) signs.set(to, sign);
    };
    for (const p of pathways) {
        const seconds = p.seconds ?? METRO_CONFIG.DEFAULT_TRAVERSAL_S;
        const stepped = STEPPED_MODES.has(p.mode);
        // A corridor is a transfer by the sign facing the walker: the same one reads "E2 Výtah/Lift" the other way.
        addEdge(p.from, p.to, seconds, stepped, p.sign, isTransferSign(p.sign));
        if (p.bidirectional) addEdge(p.to, p.from, seconds, stepped, p.reversedSign, isTransferSign(p.reversedSign));
    }

    const carsByPlatform = new Map<string, MetroBoarding[]>();
    for (const [car, area] of boardings) {
        const platform = stops.get(area)?.parent_station;
        if (!platform) continue;
        let list = carsByPlatform.get(platform);
        if (!list) { list = []; carsByPlatform.set(platform, list); }
        list.push([car, area]);
    }

    const exitNameOf = (exit: string) => exitName(stops.get(exit)?.stop_name ?? '');
    const out: MetroExitsFile = {};
    for (const [platform, cars] of [...carsByPlatform].sort(([a], [b]) => a.localeCompare(b))) {
        cars.sort((a, b) => a[0] - b[0]);
        // PID maps one exit as several entrances, so rows merge by the name the passenger reads.
        const byExit = new Map<string, { name: string; sign: string | null; seconds: number; cars: Set<number> }>();
        const stepFree: Array<{ car: number; seconds: number; name: string }> = [];
        // From each car's section, the way out its own stairs, escalator or lift lead to: where to stand for that exit.
        // An exit keeps only its nearest cars, not those whose stairs reach it round by a transfer bridge (Florenc C).
        for (const [car, area] of cars) {
            const nearest = nearestExit(area, edges, stops, false);
            const name = nearest && exitNameOf(nearest.exit);
            const row = name ? byExit.get(name) : undefined;
            if (nearest && name && row && nearest.seconds === row.seconds) row.cars.add(car);
            else if (nearest && name && (!row || nearest.seconds < row.seconds)) {
                const sign = nearest.platformSign ?? entranceSign(nearest.exit, signs);
                byExit.set(name, { name, sign: sign !== name ? sign : null, seconds: nearest.seconds, cars: new Set([car]) });
            }
            const free = nearestExit(area, edges, stops, true);
            const freeName = free && exitNameOf(free.exit);
            if (free && freeName) stepFree.push({ car, seconds: free.seconds, name: freeName });
        }
        if (byExit.size === 0) continue;

        const entry: MetroPlatformExits = { exits: [...byExit.values()].map(row => [row.name, row.sign, [...row.cars].sort((a, b) => a - b)]) };
        const best = stepFree.reduce<(typeof stepFree)[number] | null>((a, s) => (!a || s.seconds < a.seconds ? s : a), null);
        if (best) entry.stepFree = [best.name, [...new Set(stepFree.filter(s => s.name === best.name).map(s => s.car))].sort((a, b) => a - b)];
        out[platform] = entry;
    }
    return out;
}

function nearestExit(
    start: string,
    edges: ReadonlyMap<string, Edge[]>,
    stops: ReadonlyMap<string, MetroStop>,
    stepFreeOnly: boolean
): { exit: string; seconds: number; platformSign: string | null } | null {
    const platform = stops.get(start)?.parent_station;
    const dist = new Map<string, number>([[start, 0]]);
    const via = new Map<string, { from: string; sign: string | null }>();
    const queue: Array<[number, string]> = [[0, start]];
    while (queue.length > 0) {
        queue.sort((a, b) => a[0] - b[0]);
        const [d, node] = queue.shift()!;
        if (d > (dist.get(node) ?? Infinity)) continue;
        if (stops.get(node)?.location_type === ENTRANCE) {
            return { exit: node, seconds: d, platformSign: firstSign(node, via) };
        }
        for (const e of edges.get(node) ?? []) {
            if (stepFreeOnly && e.stepped) continue;
            // Walking along the platform is choosing another car, and a transfer leads to another line, not out,
            // unless it is the only step-free way up (Můstek B); stepping straight across an island platform is the same spot.
            if (e.transfer && !stepFreeOnly) continue;
            const to = stops.get(e.to);
            if (to?.location_type === BOARDING_AREA && !(node === start && to.parent_station !== platform)) continue;
            const nd = d + e.seconds;
            if (nd < (dist.get(e.to) ?? Infinity)) { dist.set(e.to, nd); via.set(e.to, { from: node, sign: e.sign }); queue.push([nd, e.to]); }
        }
    }
    return null;
}

/** PID names exits "E1", or "(ul. Nádražní)" where unnumbered; "(-)" marks one with no public name. */
export function exitName(raw: string): string | null {
    const name = raw.replace(/^\((.*)\)$/, '$1').trim();
    return name && name !== '-' ? name : null;
}

/** The first destination signposted on the walk to `node`, as the passenger reads it on the platform; transfer signs skipped. */
function firstSign(node: string, via: ReadonlyMap<string, { from: string; sign: string | null }>): string | null {
    let first: string | null = null;
    for (let step = via.get(node); step; step = via.get(step.from)) {
        const sign = signText(step.sign);
        if (sign) first = sign;
    }
    return first;
}

/** The destination signposted on the last step into an exit, for exits PID signs only there. */
function entranceSign(exit: string, signs: ReadonlyMap<string, string>): string | null {
    return signText(signs.get(exit) ?? null);
}

/** A sign's destination without its exit codes ("E1 - E2 náměstí OSN" -> "náměstí OSN"); null for a transfer, a bare "Exit" or a level number. */
export function signText(sign: string | null): string | null {
    const text = sign?.replace(/^E\d+[A-Z]?(\s*[-–,]\s*E\d+[A-Z]?)*/, '').replace(/^[\s,;:–-]+/, '').trim();
    if (!text || !/\p{L}/u.test(text)) return null;
    return /^(přestup|výstup\b|exit\b)/i.test(text) ? null : text;
}

/** PID signs the corridors between lines "Přestup B, Transfer B". */
function isTransferSign(sign: string | null): boolean {
    return /^\s*přestup/i.test(sign ?? '');
}
