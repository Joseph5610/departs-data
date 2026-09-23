import fs from 'node:fs';
import path from 'node:path';
import AdmZip from 'adm-zip';
import type { DepartureRow, ParentChildMap, RouteInfo, StopFeature, TripStop, TripWindow, TripWindowsFile } from './lib/contract.ts';
import { DEPARTURE_BUCKETS_DIR, departuresBucketId, departuresChunkId, parentIndex, TRACKS_DIR, TRIP_BUCKETS_DIR, tripBucketId, tripChunkId } from './lib/contract.ts';
import { downloadLargeZip, fetchJson } from './lib/feed.ts';
import { czechHolidays, formatTime, getServiceDays, type ServiceDay } from './lib/time.ts';
import { distanceM, fanOutColocated, localXY, round6, type Point } from './lib/geo.ts';
import { chunkBy, linesOf, outputDir, safetyCheck, sortDepartures, writeChunks, writeCityFiles } from './lib/emit.ts';
import { buildTripTracks } from './lib/tracks.ts';
import {
    CALENDAR, LAYOUTS, NOT_VIA, PASSES, SYMBOL, TRIP_CODE_FIELDS, WEEKDAY_SYMBOLS,
    decodeJdf, jdfDate, jdfTime, parseRows,
} from './lib/jdf.ts';

/**
 * Ústecký kraj (DÚK) static build from the national CIS JŘ timetable export (JDF).
 *
 * Emits the same file set and formats as build-presov.ts so the departs-app GtfsAdapter reads it
 * unchanged. JDF carries timetables but no stop positions, so stops are the Portabo network's nodes
 * (the ids the DÚK realtime feed reports), matched to JDF stops by name. Trip ids are
 * `<spoj>-<line>-<timetable>`, which departs-app `DukTripMatcher` parses to map a realtime
 * `CISLineID` + `RouteID` onto them.
 */
const CONFIG = {
    CITY: 'duk',
    TIMEZONE: 'Europe/Prague',
    /** Bus lines, and urban rail (trolleybuses, trams, funiculars) which CIS JŘ exports separately. */
    JDF_URLS: ['https://portal.cisjr.cz/pub/JDF/JDF.zip', 'https://portal.cisjr.cz/pub/draha/mestske/JDF.zip'],
    STATIONS_URL: 'https://tabule.portabo.cz/api/v1-tabule/cis/GetStations',
    DOWNLOAD_TIMEOUT_S: 600,
    DOWNLOAD_ATTEMPTS: 4,
    JDF_CACHE_MAX_AGE_MS: 12 * 3_600_000,

    /** Yesterday, today and tomorrow. */
    DAY_OFFSETS: [-1, 0, 1],

    /** Licensing-office prefixes of the kraj's line numbers: Děčín, Chomutov, Litoměřice, Louny, Most, Teplice, Ústí n.L. */
    LINE_PREFIXES: ['51', '52', '55', '56', '57', '58', '59'],
    /** LinExt transport-system code of DÚK, which also covers regional lines licensed outside the kraj. */
    DUK_SYSTEM_CODE: '30421',
    /** Public names JDF does not carry, by CIS line number; otherwise LinExt or the last three digits. */
    LINE_NAMES: { '595901': 'LD', '558001': 'MHD' } as Record<string, string>,
    /** JDF stop names that differ from Portabo's, as `district|match key` to the Portabo name. */
    STOP_ALIASES: {
        'UL|odkvet': 'Ústí n.L.,Neštěmice,Květ',
        'UL|strekovnadr': 'Ústí n.L.,Střekov,žel.st.',
        'CV|jirkovnoveervenice': 'Nové Ervěnice',
    } as Record<string, string>,

    /** Station ids; platforms are `<node>-<post>` and departures chunks are keyed by the bare node. */
    STATION_PREFIX: 'centroid-',
    /** Portabo's catch-all platform, which only repeats another platform's position. */
    VIRTUAL_POST: 999,
    /** Posts from here on are Portabo's rail and ferry stops, not numbered bus platforms. */
    FIRST_UNNUMBERED_POST: 90,
    /** Posts from here on are ferry landings. */
    FERRY_POST_START: 200,
    /** Platforms Portabo puts on the exact same point are fanned out on a circle this wide, as for Brno. */
    STACKED_PLATFORM_OFFSET_DEG: 0.00012,
    /** Detour, in metres, that outweighs a platform being left of the direction of travel. */
    LEFT_SIDE_PENALTY_M: 500,
    /** [w, s, e, n] around the kraj and its cross-border termini; Portabo parks unknown platforms in Tallinn. */
    POST_BOUNDS: [12.0, 49.8, 15.5, 51.3],
    /** A name match further than this from the rest of its line is a namesake elsewhere. */
    MAX_STOP_MATCH_DISTANCE_M: 30_000,
    /** A stop tagged with one of DISTRICT_CENTERS only matches nodes within this radius of it. */
    DISTRICT_RADIUS_M: 45_000,
    /** A town-less city stop name only matches nodes this close to its line's neighbours or district town. */
    TOWNLESS_MATCH_RADIUS_M: 10_000,
    /** A matched stop forcing a detour longer than this, driven faster than this, is a namesake. */
    MAX_PLAUSIBLE_DETOUR_M: 3_000,
    MAX_PLAUSIBLE_SPEED_KMH: 100,
    /** JDF `typ linky` of city lines (městská, městská s přesahem), whose bare stop names are streets. */
    CITY_LINE_TYPES: ['A', 'B'],
    /** Rounds of rejecting implausible matches and re-resolving without them. */
    STOP_RESOLVE_PASSES: 4,
    UNMATCHED_REPORT_COUNT: 15,
    /** Words JDF and Portabo abbreviate inconsistently, as they appear in a diacritics-free match key. */
    NAME_ABBREVIATIONS: [['namesti', 'nam'], ['nadrazi', 'nadr'], ['hlavni', 'hl'], ['nemocnice', 'nem'], ['sanatorium', 'sanat']],
    /** Centre per JDF district code, bounding matches and anchoring city lines whose stop names omit the town. */
    DISTRICT_CENTERS: {
        DC: { lat: 50.7736, lon: 14.1953 },
        CV: { lat: 50.4605, lon: 13.4178 },
        LT: { lat: 50.5335, lon: 14.1318 },
        LN: { lat: 50.3570, lon: 13.7967 },
        MO: { lat: 50.5030, lon: 13.6362 },
        TP: { lat: 50.6404, lon: 13.8245 },
        UL: { lat: 50.6607, lon: 14.0322 },
    } as Record<string, Point | undefined>,

    /** JDF `dopravní prostředek` to GTFS route_type; 1.9 timetables carry none and are buses. */
    ROUTE_TYPES: { A: '3', T: '11', E: '0', L: '7', P: '4', M: '1' } as Record<string, string | undefined>,
    DEFAULT_ROUTE_TYPE: '3',
    /** DÚK branding, matching `functions/_adapters/duk/utils/colors.ts`. */
    ROUTE_COLORS: { '3': '#7BBA2E', '11': '#00829B', '0': '#CF003D', '4': '#00B3CB' } as Record<string, string | undefined>,
    DEFAULT_ROUTE_COLOR: '#5A5A5A',
    /** DPmÚL (Ústí n.L. city transport) colours by line category, as on dpmul.cz. */
    USTI_CITY: {
        LINE_PREFIX: '595',
        NIGHT_LINES: ['41', '42', '43', '46'],
        TOURIST_LINES: ['LD', '20', '21'],
        COLORS: { bus: '#4AB280', trolleybus: '#212855', night: '#D10C15', tourist: '#F7C914' },
    },

    /** Abort thresholds guarding against an empty or truncated upstream export. */
    MIN_DEPARTURE_STOPS: 1500,
    MIN_ACTIVE_TRIPS: 5000,
} as const;

const DATA_DIR = outputDir(CONFIG.CITY);

function routeColorFor(line: string, name: string, type: string): string {
    const city = CONFIG.USTI_CITY;
    if (line.startsWith(city.LINE_PREFIX)) {
        if ((city.NIGHT_LINES as readonly string[]).includes(name)) return city.COLORS.night;
        if ((city.TOURIST_LINES as readonly string[]).includes(name)) return city.COLORS.tourist;
        return type === '11' ? city.COLORS.trolleybus : city.COLORS.bus;
    }
    return CONFIG.ROUTE_COLORS[type] ?? CONFIG.DEFAULT_ROUTE_COLOR;
}

/** Match key tolerant of JDF and Portabo spacing, abbreviations and comma-versus-space separators. */
function normalizeName(name: string): string {
    let key = name.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[\s.,]+/g, '');
    for (const [full, short] of CONFIG.NAME_ABBREVIATIONS) key = key.replaceAll(full!, short!);
    return key;
}

interface PortaboPost { Name?: string; Node: number | string; Post: number; Latitude: number; Longitude: number; Zone?: unknown }
interface NodePlatform { post: string; lat: number; lon: number }
interface Node { id: string; name: string; lat: number; lon: number; zone_id: string | null; platforms: NodePlatform[] }
interface NodeIndex {
    nodes: Map<string, Node>;
    byName: Map<string, Node[]>;
    bySuffix: Map<string, Node[]>;
    byAltName: Map<string, Node[]>;
    byAltSuffix: Map<string, Node[]>;
}

/** Portabo nodes with a usable position, plus exact-name, alternate-name and town-less-suffix indexes over them. */
async function fetchNodes(): Promise<NodeIndex> {
    const payload = await fetchJson<{ ItemList?: PortaboPost[] }>(CONFIG.STATIONS_URL, 'STATIONS_JSON');
    const posts = payload.ItemList ?? [];

    const [west, south, east, north] = CONFIG.POST_BOUNDS;
    const postsByNode = new Map<string | number, PortaboPost[]>();
    for (const p of posts) {
        if (!p.Name || !(p.Longitude >= west! && p.Longitude <= east! && p.Latitude >= south! && p.Latitude <= north!)) continue;
        let list = postsByNode.get(p.Node);
        if (!list) { list = []; postsByNode.set(p.Node, list); }
        list.push(p);
    }

    const nodes = new Map<string, Node>();
    const byName = new Map<string, Node[]>();
    const bySuffix = new Map<string, Node[]>();
    /** Other names a node's posts carry, used only where no node has the name as its own. */
    const byAltName = new Map<string, Node[]>();
    const byAltSuffix = new Map<string, Node[]>();
    const addTo = (index: Map<string, Node[]>, key: string, node: Node) => {
        let list = index.get(key);
        if (!list) { list = []; index.set(key, list); }
        list.push(node);
    };

    for (const [nodeId, nodePosts] of postsByNode) {
        const real = nodePosts.filter(p => p.Post !== CONFIG.VIRTUAL_POST);
        const located = real.length > 0 ? real : nodePosts;
        // The virtual post carries the CIS JŘ name JDF uses; real posts may carry a local one ("Loučná").
        const virtual = nodePosts.find(p => p.Post === CONFIG.VIRTUAL_POST);
        const node: Node = {
            id: String(nodeId),
            name: (virtual ?? located[0]!).Name!.trim(),
            lat: located.reduce((s, p) => s + p.Latitude, 0) / located.length,
            lon: located.reduce((s, p) => s + p.Longitude, 0) / located.length,
            zone_id: located[0]!.Zone ? String(located[0]!.Zone) : null,
            platforms: located.map(p => ({ post: String(p.Post), lat: p.Latitude, lon: p.Longitude })),
        };
        nodes.set(node.id, node);
        const indexName = (name: string, nameIndex: Map<string, Node[]>, suffixIndex: Map<string, Node[]>) => {
            addTo(nameIndex, normalizeName(name), node);
            const parts = name.split(',');
            for (let i = 1; i < parts.length; i++) addTo(suffixIndex, normalizeName(parts.slice(i).join(',')), node);
        };
        indexName(node.name, byName, bySuffix);
        const altNames = new Map(nodePosts.map(p => [normalizeName(p.Name!), p.Name!.trim()]));
        altNames.delete(normalizeName(node.name));
        for (const name of altNames.values()) indexName(name, byAltName, byAltSuffix);
    }

    return { nodes, byName, bySuffix, byAltName, byAltSuffix };
}

interface JdfStop { name: string; district: string }
interface JdfTripStop { tariff: number; stopId: string; arrival: string; departure: string; symbols: Set<string> }
interface JdfTrip { symbols: Set<string>; calendar: { type: string; from: string; to: string }[]; stops: JdfTripStop[] }
interface Timetable {
    line: string;
    designation: string | null;
    lineType: string;
    routeType: string;
    isDetour: boolean;
    validFrom: string;
    validTo: string;
    variant: string;
    stops: Map<string, JdfStop>;
    lineStops: { tariff: number; stopId: string }[];
    trips: Map<string, JdfTrip>;
}

/** Parses one JDF timetable, or returns null when it is outside the kraj or unreadable. */
function readTimetable(buffer: Buffer): Timetable | null {
    const zip = new AdmZip(buffer);
    const files = new Map(zip.getEntries().map(e => [path.basename(e.entryName).toLowerCase(), e]));
    const read = (name: string): string[][] => {
        const entry = files.get(name);
        return entry ? parseRows(decodeJdf(entry.getData())) : [];
    };

    const linky = read('linky.txt')[0];
    if (!linky) return null;
    const line = linky[0]!;
    const linext = read('linext.txt');
    const zastavky = read('zastavky.txt');
    // Lines licensed elsewhere (PID, Liberec, …) still count when they call anywhere in the kraj.
    const isInKraj = (CONFIG.LINE_PREFIXES as readonly string[]).includes(line.slice(0, 2))
        || linext.some(r => r[2] === CONFIG.DUK_SYSTEM_CODE)
        || zastavky.some(r => CONFIG.DISTRICT_CENTERS[r[4]!]);
    if (!isInKraj) return null;
    const designation = linext.map(r => r[3]).find(d => d && d !== line && d !== String(Number(line))) ?? null;

    const version = read('verzejdf.txt')[0]?.[0];
    const layout = version ? LAYOUTS[version] : undefined;
    if (!layout) {
        console.warn(`Skipping line ${line}: unsupported JDF version ${version}`);
        return null;
    }

    const symbols = new Map(read('pevnykod.txt').map(r => [r[0]!, r[1]!]));
    const symbolsOf = (row: string[], fields: readonly number[]): Set<string> => {
        const out = new Set<string>();
        for (const f of fields) {
            const symbol = symbols.get(row[f]!);
            if (symbol) out.add(symbol);
        }
        return out;
    };

    const stops = new Map<string, JdfStop>();
    for (const r of zastavky) {
        stops.set(r[0]!, { name: [r[1], r[2], r[3]].filter(Boolean).join(','), district: r[4]! });
    }

    const lineStops: { tariff: number; stopId: string }[] = [];
    const lineStopSymbols = new Map<string, Set<string>>();
    for (const r of read('zaslinky.txt')) {
        lineStops.push({ tariff: Number(r[1]), stopId: r[3]! });
        lineStopSymbols.set(r[1]!, symbolsOf(r, layout.zaslinky.codes));
    }
    lineStops.sort((a, b) => a.tariff - b.tariff);

    const trips = new Map<string, JdfTrip>();
    for (const r of read('spoje.txt')) {
        trips.set(r[1]!, { symbols: symbolsOf(r, TRIP_CODE_FIELDS), calendar: [], stops: [] });
    }
    for (const r of read('caskody.txt')) {
        const trip = trips.get(r[1]!);
        if (!trip || !r[4]) continue;
        const from = jdfDate(r[5]);
        trip.calendar.push({ type: r[4], from, to: jdfDate(r[6]) || from });
    }
    const { arrival, departure, codes } = layout.zasspoje;
    for (const r of read('zasspoje.txt')) {
        const trip = trips.get(r[1]!);
        if (!trip) continue;
        const stopSymbols = symbolsOf(r, codes);
        for (const s of lineStopSymbols.get(r[2]!) ?? []) stopSymbols.add(s);
        trip.stops.push({ tariff: Number(r[2]), stopId: r[3]!, arrival: r[arrival]!, departure: r[departure]!, symbols: stopSymbols });
    }

    const { mode, detour, validFrom, validTo, variant } = layout.linky;
    return {
        line,
        designation,
        lineType: linky[3]!,
        routeType: CONFIG.ROUTE_TYPES[mode === null ? '' : linky[mode]!] ?? CONFIG.DEFAULT_ROUTE_TYPE,
        isDetour: detour !== null && linky[detour] === '1',
        validFrom: jdfDate(linky[validFrom]),
        validTo: jdfDate(linky[validTo]),
        variant: variant === null ? '1' : linky[variant] || '1',
        stops,
        lineStops,
        trips,
    };
}

/** Whether a trip's pevné and časové kódy let it run on `day`. */
function runsOn(trip: JdfTrip, day: ServiceDay): boolean {
    const inRange = (c: { from: string; to: string }) => day.str >= c.from && day.str <= c.to;
    const only = trip.calendar.filter(c => c.type === CALENDAR.ONLY_RUNS);
    const excluded = trip.calendar.some(c => c.type === CALENDAR.DOES_NOT_RUN && inRange(c));
    if (only.length > 0) return !excluded && only.some(inRange);
    if (excluded) return false;
    if (trip.calendar.some(c => c.type === CALENDAR.ALSO_RUNS && inRange(c))) return true;

    const periods = trip.calendar.filter(c => c.type === CALENDAR.RUNS);
    if (periods.length > 0 && !periods.some(inRange)) return false;

    const weekdaySymbol = WEEKDAY_SYMBOLS[day.weekday]!;
    const hasDayRule = trip.symbols.has(SYMBOL.WORKDAYS) || trip.symbols.has(SYMBOL.SUNDAYS_AND_HOLIDAYS)
        || WEEKDAY_SYMBOLS.some(s => trip.symbols.has(s));
    if (!hasDayRule) return true;

    const isWorkday = day.weekday >= 1 && day.weekday <= 5 && !day.isHoliday;
    return (trip.symbols.has(SYMBOL.WORKDAYS) && isWorkday)
        || (trip.symbols.has(SYMBOL.SUNDAYS_AND_HOLIDAYS) && (day.weekday === 0 || day.isHoliday))
        || trip.symbols.has(weekdaySymbol);
}

interface StopOption { stopId: string; stop: JdfStop; candidates: Node[]; maxDistance: number }

/**
 * Maps a timetable's JDF stops to Portabo nodes. A name unique in Portabo anchors the line.
 * Namesakes and town-less city stop names are then resolved to the candidate lying best between
 * the closest anchored stops before and after them on the line, or nearest the district centre
 * when the line has no anchor; a town-less name only within a city-sized radius, so a stop
 * missing from Portabo cannot borrow a same-named one in a neighbouring town.
 *
 * Matches that make a trip detour implausibly are rejected and the rest re-resolved without them,
 * so one namesake anchor cannot drag the stops around it away as well.
 */
function resolveStops(timetable: Timetable, index: NodeIndex): Map<string, Node> {
    const order = new Map<string, number>();
    timetable.lineStops.forEach((s, i) => { if (!order.has(s.stopId)) order.set(s.stopId, i); });

    const isCityLine = (CONFIG.CITY_LINE_TYPES as readonly string[]).includes(timetable.lineType);
    const options: StopOption[] = [];
    for (const [stopId, stop] of timetable.stops) {
        const alias = CONFIG.STOP_ALIASES[`${stop.district}|${normalizeName(stop.name)}`];
        const key = normalizeName(alias ?? stop.name);
        const center = CONFIG.DISTRICT_CENTERS[stop.district];
        const inDistrict = (node: Node) => !center || distanceM(center, node) <= CONFIG.DISTRICT_RADIUS_M;
        // "Town,Place" is specific anywhere. A bare name is a village on a regional line but a street
        // of the served town on a city line, where a same-named village elsewhere must not match.
        const isTownQualified = Boolean(alias) || stop.name.includes(',');
        const exact = (index.byName.get(key) ?? index.byAltName.get(key) ?? []).filter(node => isTownQualified || inDistrict(node));
        if (exact.length > 0 && (isTownQualified || !isCityLine)) {
            options.push({ stopId, stop, candidates: exact, maxDistance: CONFIG.MAX_STOP_MATCH_DISTANCE_M });
        } else {
            const townless = [...new Set([...exact, ...(index.bySuffix.get(key) ?? index.byAltSuffix.get(key) ?? []).filter(inDistrict)])];
            if (townless.length > 0) options.push({ stopId, stop, candidates: townless, maxDistance: CONFIG.TOWNLESS_MATCH_RADIUS_M });
        }
    }

    const lineTown = isCityLine ? lineTownCentre(options) : null;
    const rejected = new Map<string, Set<string>>();
    const isAllowed = (stopId: string, node: Node) => !rejected.get(stopId)?.has(node.id);
    let resolved = new Map<string, Node>();
    for (let pass = 0; pass < CONFIG.STOP_RESOLVE_PASSES; pass++) {
        resolved = assignStops(options, order, isAllowed, lineTown);
        const implausible = findImplausibleStops(timetable, resolved);
        if (implausible.size === 0) return resolved;
        for (const stopId of implausible) {
            let set = rejected.get(stopId);
            if (!set) { set = new Set(); rejected.set(stopId, set); }
            set.add(resolved.get(stopId)!.id);
        }
    }
    for (const stopId of findImplausibleStops(timetable, resolved)) resolved.delete(stopId);
    return resolved;
}

/**
 * Centre of the town a city line serves: the town most of its town-less stop names match in,
 * which may be any town of the district (Kadaň, Žatec), not just its seat.
 */
function lineTownCentre(options: readonly StopOption[]): Point | null {
    const votes = new Map<string, Node[]>();
    for (const { candidates, maxDistance } of options) {
        if (maxDistance !== CONFIG.TOWNLESS_MATCH_RADIUS_M) continue;
        const byTown = new Map<string, Node>();
        for (const node of candidates) {
            const town = node.name.split(',')[0]!;
            if (!byTown.has(town)) byTown.set(town, node);
        }
        for (const [town, node] of byTown) {
            let list = votes.get(town);
            if (!list) { list = []; votes.set(town, list); }
            list.push(node);
        }
    }
    let best: Node[] | null = null;
    for (const nodes of votes.values()) if (!best || nodes.length > best.length) best = nodes;
    if (!best) return null;
    return { lat: best.reduce((s, n) => s + n.lat, 0) / best.length, lon: best.reduce((s, n) => s + n.lon, 0) / best.length };
}

/** One resolution pass over `options`, skipping candidates `isAllowed` rules out. */
function assignStops(
    options: readonly StopOption[],
    order: Map<string, number>,
    isAllowed: (stopId: string, node: Node) => boolean,
    lineTown: Point | null,
): Map<string, Node> {
    const resolved = new Map<string, Node>();
    const pending: StopOption[] = [];
    for (const option of options) {
        const candidates = option.candidates.filter(node => isAllowed(option.stopId, node));
        if (candidates.length === 1 && option.maxDistance === CONFIG.MAX_STOP_MATCH_DISTANCE_M) resolved.set(option.stopId, candidates[0]!);
        else if (candidates.length > 0) pending.push({ ...option, candidates });
    }

    const anchored = [...resolved.entries()]
        .filter(([stopId]) => order.has(stopId))
        .map(([stopId, node]) => ({ pos: order.get(stopId)!, node }));

    /** The closest anchored stops before and after `pos` along the line, else the line's town or district centre. */
    const referencesFor = (pos: number | undefined, district: string): Point[] => {
        let before: { pos: number; node: Node } | null = null;
        let after: { pos: number; node: Node } | null = null;
        if (pos !== undefined) {
            for (const a of anchored) {
                if (a.pos < pos && (!before || a.pos > before.pos)) before = a;
                if (a.pos > pos && (!after || a.pos < after.pos)) after = a;
            }
        }
        const refs: Point[] = [before?.node, after?.node].filter((n): n is Node => Boolean(n));
        const fallback = lineTown ?? CONFIG.DISTRICT_CENTERS[district];
        if (refs.length === 0 && fallback) refs.push(fallback);
        return refs;
    };

    for (const { stopId, stop, candidates, maxDistance } of pending) {
        const pos = order.get(stopId);
        const refs = referencesFor(pos, stop.district);
        if (refs.length === 0) continue;

        // The candidate that lies best between both neighbours, i.e. the smallest detour.
        let pick: Node | null = null;
        let pickScore = Infinity;
        for (const c of candidates) {
            const score = refs.reduce((sum, r) => sum + distanceM(r, c), 0);
            if (score < pickScore) { pickScore = score; pick = c; }
        }
        const town = lineTown ?? CONFIG.DISTRICT_CENTERS[stop.district];
        const nearest = pick ? Math.min(...refs.map(r => distanceM(r, pick!)), town ? distanceM(town, pick) : Infinity) : Infinity;
        if (nearest <= maxDistance) {
            resolved.set(stopId, pick!);
            if (pos !== undefined) anchored.push({ pos, node: pick! });
        }
    }
    return resolved;
}

/**
 * Stops whose match sends a trip on an implausible detour: more than MAX_PLAUSIBLE_DETOUR_M off the
 * line between its located neighbours, driven faster than MAX_PLAUSIBLE_SPEED_KMH. A trip end, with
 * one neighbour, is only blamed when that neighbour is not itself the culprit.
 */
function findImplausibleStops(timetable: Timetable, resolved: Map<string, Node>): Set<string> {
    const maxMetresPerMin = CONFIG.MAX_PLAUSIBLE_SPEED_KMH * 1000 / 60;
    const dist = (a: { stopId: string }, b: { stopId: string }) => distanceM(resolved.get(a.stopId)!, resolved.get(b.stopId)!);
    const isImplausible = (detour: number, path: number, mins: number) =>
        detour > CONFIG.MAX_PLAUSIBLE_DETOUR_M && path / Math.max(mins, 1) > maxMetresPerMin;

    const suspects = new Set<string>();
    const endSuspects: { stopId: string; neighbourId: string }[] = [];
    for (const [spoj, trip] of timetable.trips) {
        const located = tripStopTimes(trip, Number(spoj) % 2 === 0).filter(st => resolved.has(st.stopId));
        for (let i = 0; i < located.length; i++) {
            const prev = located[i - 1];
            const stop = located[i]!;
            const next = located[i + 1];
            if (prev && next) {
                const path = dist(prev, stop) + dist(stop, next);
                if (isImplausible(path - dist(prev, next), path, next.arrival - prev.departure)) suspects.add(stop.stopId);
            } else if (prev || next) {
                const neighbour = prev ?? next!;
                const d = dist(neighbour, stop);
                if (isImplausible(d, d, prev ? stop.arrival - prev.departure : next!.arrival - stop.departure)) {
                    endSuspects.push({ stopId: stop.stopId, neighbourId: neighbour.stopId });
                }
            }
        }
    }
    for (const { stopId, neighbourId } of endSuspects) {
        if (!suspects.has(neighbourId)) suspects.add(stopId);
    }
    return suspects;
}

interface ResolvedStopTime { stopId: string; arrival: number; departure: number; symbols: Set<string>; node: Node | null; name: string; platform?: NodePlatform | null }
interface ActiveTrip { routeId: string; headsign: string; wheelchair: number; stopTimes: ResolvedStopTime[]; dates: ServiceDay[] }

/**
 * Estimates the platform each located stop call uses, for drawing the trip's route; JDF names the
 * stop, not the platform. Traffic keeps right, so the platform right of the direction of travel
 * wins, then the one closest to the line between the neighbouring calls.
 */
function assignPlatforms(trip: ActiveTrip, platformsOf: Map<string, NodePlatform[]>, routeType: string | undefined): void {
    const located = trip.stopTimes.filter(st => st.node);
    const isFerry = routeType === CONFIG.ROUTE_TYPES.P;
    located.forEach((st, i) => {
        const all = platformsOf.get(st.node!.id) ?? [];
        const ofMode = all.filter(p => (Number(p.post) >= CONFIG.FERRY_POST_START) === isFerry && (isFerry || Number(p.post) < CONFIG.FIRST_UNNUMBERED_POST));
        const platforms = ofMode.length ? ofMode : all;
        if (platforms.length <= 1) {
            st.platform = platforms[0] ?? null;
            return;
        }
        const prev = i > 0 ? (located[i - 1]!.platform ?? located[i - 1]!.node) : null;
        const next = i < located.length - 1 ? located[i + 1]!.node : null;
        const from = localXY(st.node!, prev ?? st.node!);
        const to = localXY(st.node!, next ?? st.node!);
        const dir = { x: to.x - from.x, y: to.y - from.y };
        const hasDirection = Math.hypot(dir.x, dir.y) > 0;

        let best: NodePlatform | null = null;
        let bestScore = Infinity;
        for (const platform of platforms) {
            const p = localXY(st.node!, platform);
            const isLeft = hasDirection && dir.x * p.y - dir.y * p.x > 0;
            const detour = (prev ? distanceM(prev, platform) : 0) + (next ? distanceM(platform, next) : 0);
            const score = detour + (isLeft ? CONFIG.LEFT_SIDE_PENALTY_M : 0);
            if (score < bestScore) { bestScore = score; best = platform; }
        }
        st.platform = best;
    });
}

/** Served stops of a trip in travel order, with times made monotonic across midnight. */
function tripStopTimes(trip: JdfTrip, isReversed: boolean): { stopId: string; arrival: number; departure: number; symbols: Set<string> }[] {
    const ordered = [...trip.stops].sort((a, b) => (isReversed ? b.tariff - a.tariff : a.tariff - b.tariff));
    const out: { stopId: string; arrival: number; departure: number; symbols: Set<string> }[] = [];
    let prev = -Infinity;
    let dayShift = 0;
    for (const s of ordered) {
        if (s.arrival === NOT_VIA || s.departure === NOT_VIA || s.arrival === PASSES || s.departure === PASSES) continue;
        let arr = jdfTime(s.arrival);
        let dep = jdfTime(s.departure);
        if (arr === null && dep === null) continue;
        arr ??= dep!;
        dep ??= arr;
        if (arr + dayShift < prev) dayShift += 1440;
        arr += dayShift;
        dep += dayShift;
        if (dep < arr) dep += 1440;
        prev = dep;
        out.push({ stopId: s.stopId, arrival: arr, departure: dep, symbols: s.symbols });
    }
    return out;
}

async function main(): Promise<void> {
    console.log(`[${CONFIG.CITY}] Starting JDF preprocess...`);
    fs.mkdirSync(DATA_DIR, { recursive: true });

    const index = await fetchNodes();
    console.log(`Portabo: ${index.nodes.size} located nodes`);

    const timetablesByLine = new Map<string, Timetable[]>();
    let timetableCount = 0;
    for (const [n, url] of CONFIG.JDF_URLS.entries()) {
        const zip = downloadLargeZip(url, `jdf-${n}`, {
            timeoutS: CONFIG.DOWNLOAD_TIMEOUT_S,
            attempts: CONFIG.DOWNLOAD_ATTEMPTS,
            cacheDir: process.env.JDF_CACHE_DIR,
            cacheMaxAgeMs: CONFIG.JDF_CACHE_MAX_AGE_MS,
        });
        for (const entry of zip.getEntries()) {
            const timetable = readTimetable(entry.getData());
            if (!timetable) continue;
            timetableCount++;
            let list = timetablesByLine.get(timetable.line);
            if (!list) { list = []; timetablesByLine.set(timetable.line, list); }
            list.push(timetable);
        }
    }
    console.log(`JDF: ${timetableCount} timetables for ${timetablesByLine.size} lines`);

    // CIS JŘ files every change as a new timetable valid to the end of the licence, so on a given
    // day only a line's most recently started timetables apply (e.g. the 3.1. one, not the 24.12.
    // holiday one still nominally valid). Where those share a trip number, a detour wins.
    const byPrecedence = (a: Timetable, b: Timetable) => Number(b.isDetour) - Number(a.isDetour)
        || b.validFrom.localeCompare(a.validFrom)
        || Number(b.variant) - Number(a.variant);
    for (const timetables of timetablesByLine.values()) timetables.sort(byPrecedence);

    // --- ROUTES: typed by the regular timetable, since a detour may substitute buses for rail ---
    const routes: Record<string, RouteInfo> = {};
    for (const [line, timetables] of timetablesByLine) {
        const regular = timetables.find(t => !t.isDetour) ?? timetables[0]!;
        const name = CONFIG.LINE_NAMES[line] ?? timetables.find(t => t.designation)?.designation ?? String(Number(line.slice(-3)));
        routes[line] = { name, type: regular.routeType, route_color: routeColorFor(line, name, regular.routeType) };
    }

    // --- ACTIVE TRIPS ---
    const days = getServiceDays(CONFIG.TIMEZONE, CONFIG.DAY_OFFSETS, czechHolidays);
    const resolvedStops = new Map<Timetable, Map<string, Node>>();
    const activeTrips = new Map<string, ActiveTrip>();
    const unmatchedNames = new Map<string, number>();
    let keptStops = 0;

    for (const [line, timetables] of timetablesByLine) {
        for (const day of days) {
            const isValid = (t: Timetable) => t.validFrom <= day.str && (!t.validTo || day.str <= t.validTo);
            let latestFrom = '';
            for (const t of timetables) if (isValid(t) && t.validFrom > latestFrom) latestFrom = t.validFrom;

            const claimedTrips = new Set<string>();
            for (const [timetableIdx, timetable] of timetables.entries()) {
                if (!isValid(timetable) || timetable.validFrom !== latestFrom) continue;

                let nodeOf = resolvedStops.get(timetable);
                if (!nodeOf) { nodeOf = resolveStops(timetable, index); resolvedStops.set(timetable, nodeOf); }

                for (const [spoj, trip] of timetable.trips) {
                    if (claimedTrips.has(spoj)) continue;
                    claimedTrips.add(spoj);
                    if (!runsOn(trip, day)) continue;

                    const tripId = `${spoj}-${line}-${timetableIdx + 1}`;
                    const existing = activeTrips.get(tripId);
                    if (existing) {
                        existing.dates.push(day);
                        continue;
                    }

                    // A stop without a Portabo position stays in the timeline; it only has no map point or board.
                    const stopTimes: ResolvedStopTime[] = [];
                    for (const st of tripStopTimes(trip, Number(spoj) % 2 === 0)) {
                        const node = nodeOf.get(st.stopId) ?? null;
                        const stop = timetable.stops.get(st.stopId);
                        if (node) {
                            keptStops++;
                        } else {
                            const label = `${stop?.name ?? st.stopId} [${stop?.district ?? '?'}]`;
                            unmatchedNames.set(label, (unmatchedNames.get(label) ?? 0) + 1);
                        }
                        stopTimes.push({ ...st, node, name: node?.name ?? stop?.name ?? '' });
                    }
                    if (stopTimes.length < 2) continue;

                    activeTrips.set(tripId, {
                        routeId: line,
                        headsign: stopTimes[stopTimes.length - 1]!.name,
                        wheelchair: trip.symbols.has(SYMBOL.WHEELCHAIR) ? 1 : 0,
                        stopTimes,
                        dates: [day],
                    });
                }
            }
        }
    }
    const droppedStops = [...unmatchedNames.values()].reduce((s, n) => s + n, 0);
    console.log(`Found ${activeTrips.size} active trips across ${days.map(d => d.str).join(', ')}; ${droppedStops} of ${droppedStops + keptStops} stop calls have no Portabo position`);
    const topUnmatched = [...unmatchedNames].sort((a, b) => b[1] - a[1]).slice(0, CONFIG.UNMATCHED_REPORT_COUNT);
    console.log(`Most frequent unmatched stops: ${topUnmatched.map(([name, n]) => `${name} ×${n}`).join(', ')}`);

    // --- PLATFORMS: one per Portabo post, as GetStations lists them ---
    const platformsOf = new Map<string, NodePlatform[]>();
    for (const node of index.nodes.values()) {
        const fanned = fanOutColocated(node.platforms, CONFIG.STACKED_PLATFORM_OFFSET_DEG);
        platformsOf.set(node.id, node.platforms.map((p, i) => ({ post: p.post, lon: fanned[i]![0], lat: fanned[i]![1] })));
    }
    for (const t of activeTrips.values()) assignPlatforms(t, platformsOf, routes[t.routeId]?.type);

    // --- DEPARTURES, TRIPS, WINDOWS ---
    const departuresByStop = new Map<string, DepartureRow[]>();
    const stopRoutes = new Map<string, Set<string>>();
    const tripStops = new Map<string, TripStop[]>();
    const tripRoutes: Record<string, string> = {};
    const tripWindows: Record<string, TripWindow> = {};
    const dayPos = new Map(days.map((d, i) => [d.str, i]));

    for (const [tripId, t] of activeTrips) {
        tripRoutes[tripId] = t.routeId;

        let flags = 0;
        for (const d of t.dates) flags |= 1 << dayPos.get(d.str)!;
        const first = t.stopTimes[0]!;
        const last = t.stopTimes[t.stopTimes.length - 1]!;
        tripWindows[tripId] = [first.departure, last.arrival, flags];

        t.stopTimes.forEach((st, i) => {
            const isLast = i === t.stopTimes.length - 1;
            const isRequestStop = st.symbols.has(SYMBOL.REQUEST_STOP);
            if (isLast || !st.node) return;

            let set = stopRoutes.get(st.node.id);
            if (!set) { set = new Set(); stopRoutes.set(st.node.id, set); }
            set.add(t.routeId);

            let deps = departuresByStop.get(st.node.id);
            if (!deps) { deps = []; departuresByStop.set(st.node.id, deps); }
            for (const day of t.dates) {
                deps.push([tripId, t.routeId, t.headsign, day.midnight + st.departure * 60_000, t.wheelchair, isRequestStop ? 1 : 0]);
            }
        });

        // An empty stop_id marks an unlocated stop; the app renders it without a map point or link.
        tripStops.set(tripId, t.stopTimes.map((st): TripStop => ({
            stop_id: st.platform ? `${st.node!.id}-${st.platform.post}` : '',
            name: st.name,
            arrival_time: formatTime(st.arrival),
            departure_time: formatTime(st.departure),
            ...(st.platform ? { lat: round6(st.platform.lat), lon: round6(st.platform.lon) } : {}),
            is_passed: false,
            zone_id: st.node?.zone_id ?? null,
            is_request_stop: st.symbols.has(SYMBOL.REQUEST_STOP),
        })));
    }

    // --- STOPS: one station per Portabo node that any active trip serves ---
    const servedNodes = new Map<string, Node>();
    for (const t of activeTrips.values()) {
        for (const st of t.stopTimes) if (st.node) servedNodes.set(st.node.id, st.node);
    }

    const features: StopFeature[] = [];
    const parentChildMap: ParentChildMap = {};
    for (const node of servedNodes.values()) {
        const parentId = `${CONFIG.STATION_PREFIX}${node.id}`;
        features.push({
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [round6(node.lon), round6(node.lat)] },
            properties: { stop_id: parentId, stop_name: node.name, platform_code: null, location_type: 1, parent_station: null, zone_id: node.zone_id, lines: [] },
        });
        parentChildMap[parentId] = [];
        for (const platform of platformsOf.get(node.id)!) {
            const id = `${node.id}-${platform.post}`;
            const platformCode = Number(platform.post) < CONFIG.FIRST_UNNUMBERED_POST ? platform.post : null;
            const lines = linesOf(stopRoutes.get(node.id), routes);
            features.push({
                type: 'Feature',
                geometry: { type: 'Point', coordinates: [round6(platform.lon), round6(platform.lat)] },
                properties: { stop_id: id, stop_name: node.name, platform_code: platformCode, location_type: 0, parent_station: parentId, zone_id: node.zone_id, is_drop_off_only: lines.length === 0 || undefined, lines },
            });
            parentChildMap[parentId]!.push(id);
        }
    }

    // --- SAFETY CHECK ---
    safetyCheck(departuresByStop.size, activeTrips.size, CONFIG.MIN_DEPARTURE_STOPS, CONFIG.MIN_ACTIVE_TRIPS);

    // JDF has no geometry; the app draws the route stop to stop.
    const windowsFile: TripWindowsFile = { days: days.map(d => d.str), trips: tripWindows };
    writeCityFiles(DATA_DIR, { features, parentChildMap, routes, tripRoutes, tripWindows: windowsFile, tripShapes: {} });
    console.log(`Wrote ${servedNodes.size} stations and ${Object.keys(routes).length} routes`);

    sortDepartures(departuresByStop);
    const parentOf = parentIndex(parentChildMap);
    const departuresChunks = chunkBy(departuresByStop, departuresChunkId);
    writeChunks(path.join(DATA_DIR, 'departures'), departuresChunks);
    writeChunks(path.join(DATA_DIR, DEPARTURE_BUCKETS_DIR), chunkBy(departuresByStop, (id) => departuresBucketId(id, parentOf)));
    console.log(`Wrote ${departuresChunks.size} departure chunks for ${departuresByStop.size} stops`);

    const tripChunks = chunkBy(tripStops, tripChunkId);
    writeChunks(path.join(DATA_DIR, 'trips'), tripChunks);
    writeChunks(path.join(DATA_DIR, TRIP_BUCKETS_DIR), chunkBy(tripStops, tripBucketId));
    console.log(`Wrote ${tripChunks.size} trip chunks for ${activeTrips.size} trips`);

    const tracks = buildTripTracks(tripStops, tripWindows);
    const largestTrack = writeChunks(path.join(DATA_DIR, TRACKS_DIR), tracks);
    console.log(`Wrote ${tracks.size} track files, largest ${(largestTrack / 1024).toFixed(0)}KB`);
    console.log('Done!');
}

main().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
});
