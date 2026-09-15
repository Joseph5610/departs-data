import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import AdmZip from 'adm-zip';

/**
 * Ústecký kraj (DÚK) static build from the national CIS JŘ timetable export (JDF).
 *
 * Emits the same file set and formats as build-presov.mjs so the departs-app GtfsAdapter reads it
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
    JDF_ENCODING: 'windows-1250',
    DOWNLOAD_TIMEOUT_S: 600,
    DOWNLOAD_ATTEMPTS: 4,
    JDF_CACHE_MAX_AGE_MS: 12 * 3_600_000,

    /** Licensing-office prefixes of the kraj's line numbers: Děčín, Chomutov, Litoměřice, Louny, Most, Teplice, Ústí n.L. */
    LINE_PREFIXES: ['51', '52', '55', '56', '57', '58', '59'],
    /** LinExt transport-system code of DÚK, which also covers regional lines licensed outside the kraj. */
    DUK_SYSTEM_CODE: '30421',
    /** Public names JDF does not carry, by CIS line number; otherwise LinExt or the last three digits. */
    LINE_NAMES: { '595901': 'LD', '558001': 'MHD' },
    /** JDF stop names that differ from Portabo's, as `district|match key` to the Portabo name. */
    STOP_ALIASES: {
        'UL|odkvet': 'Ústí n.L.,Neštěmice,Květ',
        'UL|strekovnadr': 'Ústí n.L.,Střekov,žel.st.',
        'CV|jirkovnoveervenice': 'Nové Ervěnice',
    },

    /** Must match DEPARTURES_CHUNK_PREFIX / TRIP_CHUNK_PREFIX in departs-app `functions/_adapters/gtfs/core/config.ts`. */
    DEPARTURES_CHUNK_PREFIX: 4,
    TRIP_CHUNK_PREFIX: 3,

    /** Station ids; platforms are `<node>-<post>` and departures chunks are keyed by the bare node. */
    STATION_PREFIX: 'centroid-',
    /** Portabo's catch-all platform, which only repeats another platform's position. */
    VIRTUAL_POST: 999,
    /** Posts from here on are Portabo's rail and ferry stops, not numbered bus platforms. */
    FIRST_UNNUMBERED_POST: 90,
    /** Posts from here on are ferry landings. */
    FERRY_POST_START: 200,
    /** Platforms of a station closer than this are spread apart so their map markers do not overlap. */
    MIN_PLATFORM_SEPARATION_M: 25,
    PLATFORM_SEPARATION_PASSES: 3,
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
    },

    /** JDF `dopravní prostředek` to GTFS route_type; 1.9 timetables carry none and are buses. */
    ROUTE_TYPES: { A: '3', T: '11', E: '0', L: '7', P: '4', M: '1' },
    DEFAULT_ROUTE_TYPE: '3',
    /** DÚK branding, matching `functions/_adapters/duk/utils/colors.ts`. */
    ROUTE_COLORS: { '3': '#7BBA2E', '11': '#00829B', '0': '#CF003D', '4': '#00B3CB' },
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
};

/** Field positions per JDF version; the export mixes 1.9, 1.10 and 1.11 timetables. */
const LAYOUTS = {
    '1.9': {
        linky: { mode: null, detour: null, validFrom: 8, validTo: 9, variant: null },
        zasspoje: { codes: [5, 6], arrival: 8, departure: 9 },
        zaslinky: { codes: [4, 5, 6] },
    },
    '1.10': {
        linky: { mode: 4, detour: 5, validFrom: 12, validTo: 13, variant: 14 },
        zasspoje: { codes: [6, 7], arrival: 9, departure: 10 },
        zaslinky: { codes: [5, 6, 7] },
    },
    '1.11': {
        linky: { mode: 4, detour: 5, validFrom: 13, validTo: 14, variant: 15 },
        zasspoje: { codes: [6, 7, 8], arrival: 10, departure: 11 },
        zaslinky: { codes: [5, 6, 7] },
    },
};
/** Spoje.txt: pevné kódy 1–10, identical in every version. */
const TRIP_CODE_FIELDS = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11];

/** JDF časový kód types. */
const CALENDAR = { RUNS: '1', ALSO_RUNS: '2', ONLY_RUNS: '3', DOES_NOT_RUN: '4' };
/** JDF pevný kód symbols read here. */
const SYMBOL = { WORKDAYS: 'X', SUNDAYS_AND_HOLIDAYS: '+', REQUEST_STOP: 'x', WHEELCHAIR: '@' };
const WEEKDAY_SYMBOLS = ['7', '1', '2', '3', '4', '5', '6'];
/** Zasspoje time markers: the trip passes the stop without stopping, or does not run via it. */
const PASSES = '<';
const NOT_VIA = '|';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', CONFIG.CITY);
const DAY_MS = 86_400_000;
const decoder = new TextDecoder(CONFIG.JDF_ENCODING);

/** JDF rows: quoted, comma-separated fields terminated by `;`. */
function parseRows(text) {
    const rows = [];
    for (const line of text.split(/\r?\n/)) {
        if (!line.trim()) continue;
        rows.push([...line.matchAll(/"([^"]*)"/g)].map(m => m[1]));
    }
    return rows;
}

/** `DDMMYYYY` to `YYYYMMDD`; empty stays empty. */
const jdfDate = (d) => (d && d.length === 8 ? `${d.slice(4)}${d.slice(2, 4)}${d.slice(0, 2)}` : '');

/** UTC offset of `timezone` at `atMs`, in milliseconds. */
function zoneOffsetMs(timezone, atMs) {
    const name = new Intl.DateTimeFormat('en-US', { timeZone: timezone, timeZoneName: 'longOffset' })
        .formatToParts(new Date(atMs))
        .find(p => p.type === 'timeZoneName')?.value ?? '';
    const m = /GMT([+-])(\d{2}):(\d{2})/.exec(name);
    return m ? (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 3_600_000 + Number(m[3]) * 60_000) : 0;
}

/** Gregorian Easter Sunday as a UTC date. */
function easterSunday(year) {
    const a = year % 19;
    const b = Math.floor(year / 100);
    const c = year % 100;
    const d = Math.floor(b / 4);
    const e = b % 4;
    const f = Math.floor((b + 8) / 25);
    const g = Math.floor((b - f + 1) / 3);
    const h = (19 * a + b - d - g + 15) % 30;
    const i = Math.floor(c / 4);
    const k = c % 4;
    const l = (32 + 2 * e + 2 * i - h - k) % 7;
    const m = Math.floor((a + 11 * h + 22 * l) / 451);
    const month = Math.floor((h + l - 7 * m + 114) / 31);
    const day = ((h + l - 7 * m + 114) % 31) + 1;
    return Date.UTC(year, month - 1, day);
}

/** Czech public holidays of `year` as `YYYYMMDD`. */
function czechHolidays(year) {
    const fixed = ['0101', '0501', '0508', '0705', '0706', '0928', '1028', '1117', '1224', '1225', '1226'];
    const easter = easterSunday(year);
    const toStr = (ms) => new Date(ms).toISOString().slice(0, 10).replace(/-/g, '');
    return new Set([...fixed.map(md => `${year}${md}`), toStr(easter - 2 * DAY_MS), toStr(easter + DAY_MS)]);
}

/** Yesterday, today and tomorrow in the feed timezone, with weekday and holiday flags. */
function getServiceDays() {
    const nowMs = Date.now();
    const days = [];
    for (const offsetDays of [-1, 0, 1]) {
        const local = new Date(nowMs + zoneOffsetMs(CONFIG.TIMEZONE, nowMs) + offsetDays * DAY_MS);
        const y = local.getUTCFullYear();
        const m = String(local.getUTCMonth() + 1).padStart(2, '0');
        const d = String(local.getUTCDate()).padStart(2, '0');
        const str = `${y}${m}${d}`;
        const utcMidnight = Date.UTC(y, local.getUTCMonth(), local.getUTCDate());
        // Timetable times are measured from "noon minus 12h", so resolve the offset at local noon.
        const midnight = utcMidnight - zoneOffsetMs(CONFIG.TIMEZONE, utcMidnight + 12 * 3_600_000);
        days.push({ str, midnight, weekday: new Date(utcMidnight).getUTCDay(), isHoliday: czechHolidays(y).has(str) });
    }
    return days;
}

/** Match key tolerant of JDF and Portabo spacing, abbreviations and comma-versus-space separators. */
function routeColorFor(line, name, type) {
    const city = CONFIG.USTI_CITY;
    if (line.startsWith(city.LINE_PREFIX)) {
        if (city.NIGHT_LINES.includes(name)) return city.COLORS.night;
        if (city.TOURIST_LINES.includes(name)) return city.COLORS.tourist;
        return type === '11' ? city.COLORS.trolleybus : city.COLORS.bus;
    }
    return CONFIG.ROUTE_COLORS[type] ?? CONFIG.DEFAULT_ROUTE_COLOR;
}

function normalizeName(name) {
    let key = name.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[\s.,]+/g, '');
    for (const [full, short] of CONFIG.NAME_ABBREVIATIONS) key = key.replaceAll(full, short);
    return key;
}

function distanceM(a, b) {
    const toRad = (x) => x * Math.PI / 180;
    const dLat = toRad(b.lat - a.lat);
    const dLon = toRad(b.lon - a.lon);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
    return 6_371_000 * 2 * Math.asin(Math.sqrt(h));
}

/** `HHMM` to minutes; null for an empty or marker field. */
function jdfTime(value) {
    if (!/^\d{4}$/.test(value)) return null;
    return Number(value.slice(0, 2)) * 60 + Number(value.slice(2));
}

function formatTime(mins) {
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00`;
}

function writeChunks(dir, chunks) {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    for (const [chunkId, data] of chunks) {
        fs.writeFileSync(path.join(dir, `${encodeURIComponent(chunkId)}.json`), JSON.stringify(data));
    }
}

/** Downloads a JDF export; `JDF_CACHE_DIR` keeps it for local rebuilds within `JDF_CACHE_MAX_AGE_MS`. */
function downloadJdf(url, n) {
    const cacheDir = process.env.JDF_CACHE_DIR;
    const target = cacheDir ? path.join(cacheDir, `jdf-${n}.zip`) : path.join(os.tmpdir(), `jdf-${process.pid}-${n}.zip`);
    const isFresh = cacheDir && fs.existsSync(target) && Date.now() - fs.statSync(target).mtimeMs < CONFIG.JDF_CACHE_MAX_AGE_MS;
    if (!isFresh) {
        fs.rmSync(target, { force: true });
        for (let attempt = 1; ; attempt++) {
            try {
                // `-C -` resumes what a timed-out attempt got.
                execFileSync('curl', ['-sSf', '-C', '-', '--max-time', String(CONFIG.DOWNLOAD_TIMEOUT_S), '-o', target, url], { stdio: 'inherit' });
                break;
            } catch (err) {
                if (attempt >= CONFIG.DOWNLOAD_ATTEMPTS) throw err;
                console.warn(`JDF download attempt ${attempt} failed, resuming...`);
            }
        }
    }
    const zip = new AdmZip(target);
    if (!cacheDir) fs.rmSync(target, { force: true });
    return zip;
}

/** Portabo nodes with a usable position, plus exact-name, alternate-name and town-less-suffix indexes over them. */
async function fetchNodes() {
    const res = await fetch(CONFIG.STATIONS_URL, { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`Portabo stations fetch failed: ${res.status}`);
    const posts = (await res.json()).ItemList ?? [];

    const [west, south, east, north] = CONFIG.POST_BOUNDS;
    const postsByNode = new Map();
    for (const p of posts) {
        if (!p.Name || !(p.Longitude >= west && p.Longitude <= east && p.Latitude >= south && p.Latitude <= north)) continue;
        if (!postsByNode.has(p.Node)) postsByNode.set(p.Node, []);
        postsByNode.get(p.Node).push(p);
    }

    const nodes = new Map();
    const byName = new Map();
    const bySuffix = new Map();
    /** Other names a node's posts carry, used only where no node has the name as its own. */
    const byAltName = new Map();
    const byAltSuffix = new Map();
    const addTo = (index, key, node) => {
        if (!index.has(key)) index.set(key, []);
        index.get(key).push(node);
    };

    for (const [nodeId, nodePosts] of postsByNode) {
        const real = nodePosts.filter(p => p.Post !== CONFIG.VIRTUAL_POST);
        const located = real.length > 0 ? real : nodePosts;
        // The virtual post carries the CIS JŘ name JDF uses; real posts may carry a local one ("Loučná").
        const virtual = nodePosts.find(p => p.Post === CONFIG.VIRTUAL_POST);
        const node = {
            id: String(nodeId),
            name: (virtual ?? located[0]).Name.trim(),
            lat: located.reduce((s, p) => s + p.Latitude, 0) / located.length,
            lon: located.reduce((s, p) => s + p.Longitude, 0) / located.length,
            zone_id: located[0].Zone ? String(located[0].Zone) : null,
            platforms: located.map(p => ({ post: String(p.Post), lat: p.Latitude, lon: p.Longitude })),
        };
        nodes.set(node.id, node);
        const indexName = (name, nameIndex, suffixIndex) => {
            addTo(nameIndex, normalizeName(name), node);
            const parts = name.split(',');
            for (let i = 1; i < parts.length; i++) addTo(suffixIndex, normalizeName(parts.slice(i).join(',')), node);
        };
        indexName(node.name, byName, bySuffix);
        const altNames = new Map(nodePosts.map(p => [normalizeName(p.Name), p.Name.trim()]));
        altNames.delete(normalizeName(node.name));
        for (const name of altNames.values()) indexName(name, byAltName, byAltSuffix);
    }

    return { nodes, byName, bySuffix, byAltName, byAltSuffix };
}

/** Parses one JDF timetable, or returns null when it is outside the kraj or unreadable. */
function readTimetable(buffer) {
    const zip = new AdmZip(buffer);
    const files = new Map(zip.getEntries().map(e => [path.basename(e.entryName).toLowerCase(), e]));
    const read = (name) => {
        const entry = files.get(name);
        return entry ? parseRows(decoder.decode(entry.getData())) : [];
    };

    const [linky] = read('linky.txt');
    if (!linky) return null;
    const line = linky[0];
    const linext = read('linext.txt');
    const zastavky = read('zastavky.txt');
    // Lines licensed elsewhere (PID, Liberec, …) still count when they call anywhere in the kraj.
    const isInKraj = CONFIG.LINE_PREFIXES.includes(line.slice(0, 2))
        || linext.some(r => r[2] === CONFIG.DUK_SYSTEM_CODE)
        || zastavky.some(r => CONFIG.DISTRICT_CENTERS[r[4]]);
    if (!isInKraj) return null;
    const designation = linext.map(r => r[3]).find(d => d && d !== line && d !== String(Number(line))) ?? null;

    const version = read('verzejdf.txt')[0]?.[0];
    const layout = LAYOUTS[version];
    if (!layout) {
        console.warn(`Skipping line ${line}: unsupported JDF version ${version}`);
        return null;
    }

    const symbols = new Map(read('pevnykod.txt').map(r => [r[0], r[1]]));
    const symbolsOf = (row, fields) => {
        const out = new Set();
        for (const f of fields) {
            const symbol = symbols.get(row[f]);
            if (symbol) out.add(symbol);
        }
        return out;
    };

    const stops = new Map();
    for (const r of zastavky) {
        stops.set(r[0], { name: [r[1], r[2], r[3]].filter(Boolean).join(','), district: r[4] });
    }

    const lineStops = [];
    const lineStopSymbols = new Map();
    for (const r of read('zaslinky.txt')) {
        lineStops.push({ tariff: Number(r[1]), stopId: r[3] });
        lineStopSymbols.set(r[1], symbolsOf(r, layout.zaslinky.codes));
    }
    lineStops.sort((a, b) => a.tariff - b.tariff);

    const trips = new Map();
    for (const r of read('spoje.txt')) {
        trips.set(r[1], { symbols: symbolsOf(r, TRIP_CODE_FIELDS), calendar: [], stops: [] });
    }
    for (const r of read('caskody.txt')) {
        const trip = trips.get(r[1]);
        if (!trip || !r[4]) continue;
        const from = jdfDate(r[5]);
        trip.calendar.push({ type: r[4], from, to: jdfDate(r[6]) || from });
    }
    const { arrival, departure, codes } = layout.zasspoje;
    for (const r of read('zasspoje.txt')) {
        const trip = trips.get(r[1]);
        if (!trip) continue;
        const symbols = symbolsOf(r, codes);
        for (const s of lineStopSymbols.get(r[2]) ?? []) symbols.add(s);
        trip.stops.push({ tariff: Number(r[2]), stopId: r[3], arrival: r[arrival], departure: r[departure], symbols });
    }

    const { mode, detour, validFrom, validTo, variant } = layout.linky;
    return {
        line,
        designation,
        lineType: linky[3],
        routeType: CONFIG.ROUTE_TYPES[mode === null ? '' : linky[mode]] ?? CONFIG.DEFAULT_ROUTE_TYPE,
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
function runsOn(trip, day) {
    const inRange = (c) => day.str >= c.from && day.str <= c.to;
    const only = trip.calendar.filter(c => c.type === CALENDAR.ONLY_RUNS);
    const excluded = trip.calendar.some(c => c.type === CALENDAR.DOES_NOT_RUN && inRange(c));
    if (only.length > 0) return !excluded && only.some(inRange);
    if (excluded) return false;
    if (trip.calendar.some(c => c.type === CALENDAR.ALSO_RUNS && inRange(c))) return true;

    const periods = trip.calendar.filter(c => c.type === CALENDAR.RUNS);
    if (periods.length > 0 && !periods.some(inRange)) return false;

    const weekdaySymbol = WEEKDAY_SYMBOLS[day.weekday];
    const hasDayRule = trip.symbols.has(SYMBOL.WORKDAYS) || trip.symbols.has(SYMBOL.SUNDAYS_AND_HOLIDAYS)
        || WEEKDAY_SYMBOLS.some(s => trip.symbols.has(s));
    if (!hasDayRule) return true;

    const isWorkday = day.weekday >= 1 && day.weekday <= 5 && !day.isHoliday;
    return (trip.symbols.has(SYMBOL.WORKDAYS) && isWorkday)
        || (trip.symbols.has(SYMBOL.SUNDAYS_AND_HOLIDAYS) && (day.weekday === 0 || day.isHoliday))
        || trip.symbols.has(weekdaySymbol);
}

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
function resolveStops(timetable, index) {
    const order = new Map();
    timetable.lineStops.forEach((s, i) => { if (!order.has(s.stopId)) order.set(s.stopId, i); });

    const isCityLine = CONFIG.CITY_LINE_TYPES.includes(timetable.lineType);
    const options = [];
    for (const [stopId, stop] of timetable.stops) {
        const alias = CONFIG.STOP_ALIASES[`${stop.district}|${normalizeName(stop.name)}`];
        const key = normalizeName(alias ?? stop.name);
        const center = CONFIG.DISTRICT_CENTERS[stop.district];
        const inDistrict = (node) => !center || distanceM(center, node) <= CONFIG.DISTRICT_RADIUS_M;
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
    const rejected = new Map();
    const isAllowed = (stopId, node) => !rejected.get(stopId)?.has(node.id);
    let resolved = new Map();
    for (let pass = 0; pass < CONFIG.STOP_RESOLVE_PASSES; pass++) {
        resolved = assignStops(options, order, isAllowed, lineTown);
        const implausible = findImplausibleStops(timetable, resolved);
        if (implausible.size === 0) return resolved;
        for (const stopId of implausible) {
            if (!rejected.has(stopId)) rejected.set(stopId, new Set());
            rejected.get(stopId).add(resolved.get(stopId).id);
        }
    }
    for (const stopId of findImplausibleStops(timetable, resolved)) resolved.delete(stopId);
    return resolved;
}

/**
 * Centre of the town a city line serves: the town most of its town-less stop names match in,
 * which may be any town of the district (Kadaň, Žatec), not just its seat.
 */
function lineTownCentre(options) {
    const votes = new Map();
    for (const { candidates, maxDistance } of options) {
        if (maxDistance !== CONFIG.TOWNLESS_MATCH_RADIUS_M) continue;
        const byTown = new Map();
        for (const node of candidates) {
            const town = node.name.split(',')[0];
            if (!byTown.has(town)) byTown.set(town, node);
        }
        for (const [town, node] of byTown) {
            if (!votes.has(town)) votes.set(town, []);
            votes.get(town).push(node);
        }
    }
    let best = null;
    for (const nodes of votes.values()) if (!best || nodes.length > best.length) best = nodes;
    if (!best) return null;
    return { lat: best.reduce((s, n) => s + n.lat, 0) / best.length, lon: best.reduce((s, n) => s + n.lon, 0) / best.length };
}

/** One resolution pass over `options`, skipping candidates `isAllowed` rules out. */
function assignStops(options, order, isAllowed, lineTown) {
    const resolved = new Map();
    const pending = [];
    for (const option of options) {
        const candidates = option.candidates.filter(node => isAllowed(option.stopId, node));
        if (candidates.length === 1 && option.maxDistance === CONFIG.MAX_STOP_MATCH_DISTANCE_M) resolved.set(option.stopId, candidates[0]);
        else if (candidates.length > 0) pending.push({ ...option, candidates });
    }

    const anchored = [...resolved.entries()]
        .filter(([stopId]) => order.has(stopId))
        .map(([stopId, node]) => ({ pos: order.get(stopId), node }));

    /** The closest anchored stops before and after `pos` along the line, else the line's town or district centre. */
    const referencesFor = (pos, district) => {
        let before = null;
        let after = null;
        if (pos !== undefined) {
            for (const a of anchored) {
                if (a.pos < pos && (!before || a.pos > before.pos)) before = a;
                if (a.pos > pos && (!after || a.pos < after.pos)) after = a;
            }
        }
        const refs = [before?.node, after?.node].filter(Boolean);
        const fallback = lineTown ?? CONFIG.DISTRICT_CENTERS[district];
        if (refs.length === 0 && fallback) refs.push(fallback);
        return refs;
    };

    for (const { stopId, stop, candidates, maxDistance } of pending) {
        const pos = order.get(stopId);
        const refs = referencesFor(pos, stop.district);
        if (refs.length === 0) continue;

        // The candidate that lies best between both neighbours, i.e. the smallest detour.
        let pick = null;
        let pickScore = Infinity;
        for (const c of candidates) {
            const score = refs.reduce((sum, r) => sum + distanceM(r, c), 0);
            if (score < pickScore) { pickScore = score; pick = c; }
        }
        const town = lineTown ?? CONFIG.DISTRICT_CENTERS[stop.district];
        const nearest = pick ? Math.min(...refs.map(r => distanceM(r, pick)), town ? distanceM(town, pick) : Infinity) : Infinity;
        if (nearest <= maxDistance) {
            resolved.set(stopId, pick);
            if (pos !== undefined) anchored.push({ pos, node: pick });
        }
    }
    return resolved;
}

/**
 * Stops whose match sends a trip on an implausible detour: more than MAX_PLAUSIBLE_DETOUR_M off the
 * line between its located neighbours, driven faster than MAX_PLAUSIBLE_SPEED_KMH. A trip end, with
 * one neighbour, is only blamed when that neighbour is not itself the culprit.
 */
function findImplausibleStops(timetable, resolved) {
    const maxMetresPerMin = CONFIG.MAX_PLAUSIBLE_SPEED_KMH * 1000 / 60;
    const dist = (a, b) => distanceM(resolved.get(a.stopId), resolved.get(b.stopId));
    const isImplausible = (detour, path, mins) => detour > CONFIG.MAX_PLAUSIBLE_DETOUR_M && path / Math.max(mins, 1) > maxMetresPerMin;

    const suspects = new Set();
    const endSuspects = [];
    for (const [spoj, trip] of timetable.trips) {
        const located = tripStopTimes(trip, Number(spoj) % 2 === 0).filter(st => resolved.has(st.stopId));
        for (let i = 0; i < located.length; i++) {
            const prev = located[i - 1];
            const stop = located[i];
            const next = located[i + 1];
            if (prev && next) {
                const path = dist(prev, stop) + dist(stop, next);
                if (isImplausible(path - dist(prev, next), path, next.arrival - prev.departure)) suspects.add(stop.stopId);
            } else if (prev || next) {
                const neighbour = prev ?? next;
                const d = dist(neighbour, stop);
                if (isImplausible(d, d, prev ? stop.arrival - prev.departure : next.arrival - stop.departure)) {
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

/**
 * Moves a node's platforms that would overlap on the map (closer than MIN_PLATFORM_SEPARATION_M)
 * onto a circle around their common centre, keeping their order around it, so each stays tappable.
 */
function separatePlatforms(platforms) {
    const minSep = CONFIG.MIN_PLATFORM_SEPARATION_M;
    const clusters = [];
    const assigned = new Set();
    for (const seed of platforms) {
        if (assigned.has(seed)) continue;
        const cluster = [seed];
        assigned.add(seed);
        for (let i = 0; i < cluster.length; i++) {
            for (const other of platforms) {
                if (!assigned.has(other) && distanceM(cluster[i], other) < minSep) {
                    cluster.push(other);
                    assigned.add(other);
                }
            }
        }
        clusters.push(cluster);
    }

    const out = [];
    for (const cluster of clusters) {
        if (cluster.length === 1) {
            out.push(cluster[0]);
            continue;
        }
        const centre = {
            lat: cluster.reduce((s, p) => s + p.lat, 0) / cluster.length,
            lon: cluster.reduce((s, p) => s + p.lon, 0) / cluster.length,
        };
        const angleOf = (p) => { const v = localXY(centre, p); return Math.hypot(v.x, v.y) < 0.5 ? null : Math.atan2(v.y, v.x); };
        const ordered = cluster.map((p, i) => ({ p, angle: angleOf(p) ?? (2 * Math.PI * i) / cluster.length })).sort((a, b) => a.angle - b.angle);
        const radius = minSep / (2 * Math.sin(Math.PI / cluster.length));
        const metresPerDegLon = 111_320 * Math.cos(centre.lat * Math.PI / 180);
        ordered.forEach(({ p }, i) => {
            const angle = ordered[0].angle + (2 * Math.PI * i) / cluster.length;
            out.push({ ...p, lat: centre.lat + (radius * Math.sin(angle)) / 110_540, lon: centre.lon + (radius * Math.cos(angle)) / metresPerDegLon });
        });
    }
    return out;
}

/** Metres east and north of `origin`, precise enough for directions within a stop's surroundings. */
function localXY(origin, point) {
    return {
        x: (point.lon - origin.lon) * 111_320 * Math.cos(origin.lat * Math.PI / 180),
        y: (point.lat - origin.lat) * 110_540,
    };
}

/** Identifies where a line leaves a station for; must match `learn-duk-platforms.mjs`. */
function platformHintKey(nodeId, routeId, nextNodeId) {
    return `${nodeId}|${routeId}|${nextNodeId ?? 'end'}`;
}

/** Platforms `learn-duk-platforms.mjs` has seen lines use, keyed by `platformHintKey`. */
function loadPlatformHints() {
    const file = path.join(DATA_DIR, 'platform_hints.json');
    return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
}

/**
 * Picks the platform each located stop call uses; JDF names the stop, not the platform. Traffic
 * keeps right, so the platform right of the direction of travel wins, then the one closest to the
 * line between the neighbouring calls.
 */
function assignPlatforms(trip, platformsOf, hints, routeType) {
    const located = trip.stopTimes.filter(st => st.node);
    const isFerry = routeType === CONFIG.ROUTE_TYPES.P;
    located.forEach((st, i) => {
        const all = platformsOf.get(st.node.id) ?? [];
        const ofMode = all.filter(p => (Number(p.post) >= CONFIG.FERRY_POST_START) === isFerry && (isFerry || Number(p.post) < CONFIG.FIRST_UNNUMBERED_POST));
        const platforms = ofMode.length ? ofMode : all;
        if (platforms.length <= 1) {
            st.platform = platforms[0] ?? null;
            st.isPlatformKnown = true;
            return;
        }
        const hinted = hints[platformHintKey(st.node.id, trip.routeId, located[i + 1]?.node.id)];
        const known = hinted && platforms.find(p => p.post === hinted.post);
        if (known) {
            st.platform = known;
            st.isPlatformKnown = true;
            return;
        }
        const prev = i > 0 ? (located[i - 1].platform ?? located[i - 1].node) : null;
        const next = i < located.length - 1 ? located[i + 1].node : null;
        const from = localXY(st.node, prev ?? st.node);
        const to = localXY(st.node, next ?? st.node);
        const dir = { x: to.x - from.x, y: to.y - from.y };
        const hasDirection = Math.hypot(dir.x, dir.y) > 0;

        let best = null;
        let bestScore = Infinity;
        for (const platform of platforms) {
            const p = localXY(st.node, platform);
            const isLeft = hasDirection && dir.x * p.y - dir.y * p.x > 0;
            const detour = (prev ? distanceM(prev, platform) : 0) + (next ? distanceM(platform, next) : 0);
            const score = detour + (isLeft ? CONFIG.LEFT_SIDE_PENALTY_M : 0);
            if (score < bestScore) { bestScore = score; best = platform; }
        }
        // A guess places the route line; departures and platform line lists use known platforms only.
        st.platform = best;
        st.isPlatformKnown = false;
    });
}

/** Served stops of a trip in travel order, with times made monotonic across midnight. */
function tripStopTimes(trip, isReversed) {
    const ordered = [...trip.stops].sort((a, b) => (isReversed ? b.tariff - a.tariff : a.tariff - b.tariff));
    const out = [];
    let prev = -Infinity;
    let dayShift = 0;
    for (const s of ordered) {
        if (s.arrival === NOT_VIA || s.departure === NOT_VIA || s.arrival === PASSES || s.departure === PASSES) continue;
        let arr = jdfTime(s.arrival);
        let dep = jdfTime(s.departure);
        if (arr === null && dep === null) continue;
        arr ??= dep;
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

async function main() {
    console.log(`[${CONFIG.CITY}] Starting JDF preprocess...`);
    fs.mkdirSync(DATA_DIR, { recursive: true });

    const index = await fetchNodes();
    console.log(`Portabo: ${index.nodes.size} located nodes`);

    const timetablesByLine = new Map();
    let timetableCount = 0;
    for (const [n, url] of CONFIG.JDF_URLS.entries()) {
        for (const entry of downloadJdf(url, n).getEntries()) {
            const timetable = readTimetable(entry.getData());
            if (!timetable) continue;
            timetableCount++;
            if (!timetablesByLine.has(timetable.line)) timetablesByLine.set(timetable.line, []);
            timetablesByLine.get(timetable.line).push(timetable);
        }
    }
    console.log(`JDF: ${timetableCount} timetables for ${timetablesByLine.size} lines`);

    // CIS JŘ files every change as a new timetable valid to the end of the licence, so on a given
    // day only a line's most recently started timetables apply (e.g. the 3.1. one, not the 24.12.
    // holiday one still nominally valid). Where those share a trip number, a detour wins.
    const byPrecedence = (a, b) => Number(b.isDetour) - Number(a.isDetour)
        || b.validFrom.localeCompare(a.validFrom)
        || Number(b.variant) - Number(a.variant);
    for (const timetables of timetablesByLine.values()) timetables.sort(byPrecedence);

    // --- ROUTES: typed by the regular timetable, since a detour may substitute buses for rail ---
    const routes = {};
    for (const [line, timetables] of timetablesByLine) {
        const regular = timetables.find(t => !t.isDetour) ?? timetables[0];
        const name = CONFIG.LINE_NAMES[line] ?? timetables.find(t => t.designation)?.designation ?? String(Number(line.slice(-3)));
        routes[line] = { name, type: regular.routeType, route_color: routeColorFor(line, name, regular.routeType) };
    }

    // --- ACTIVE TRIPS ---
    const days = getServiceDays();
    const resolvedStops = new Map();
    const activeTrips = new Map();
    const unmatchedNames = new Map();
    let keptStops = 0;

    for (const [line, timetables] of timetablesByLine) {
        for (const day of days) {
            const isValid = (t) => t.validFrom <= day.str && (!t.validTo || day.str <= t.validTo);
            let latestFrom = '';
            for (const t of timetables) if (isValid(t) && t.validFrom > latestFrom) latestFrom = t.validFrom;

            const claimedTrips = new Set();
            for (const [timetableIdx, timetable] of timetables.entries()) {
                if (!isValid(timetable) || timetable.validFrom !== latestFrom) continue;

                if (!resolvedStops.has(timetable)) resolvedStops.set(timetable, resolveStops(timetable, index));
                const nodeOf = resolvedStops.get(timetable);

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
                    const stopTimes = [];
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
                        headsign: stopTimes[stopTimes.length - 1].name,
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

    // --- PLATFORMS: posts sharing a position (typically rail posts 92 and 101) are one platform ---
    const round6 = (x) => Number(x.toFixed(6));
    const postAliases = {};
    const platformsOf = new Map();
    for (const node of index.nodes.values()) {
        const byPosition = new Map();
        for (const platform of node.platforms) {
            const position = `${round6(platform.lon)},${round6(platform.lat)}`;
            const kept = byPosition.get(position);
            if (kept) postAliases[`${node.id}-${platform.post}`] = `${node.id}-${kept.post}`;
            else byPosition.set(position, platform);
        }
        let platforms = [...byPosition.values()];
        for (let pass = 0; pass < CONFIG.PLATFORM_SEPARATION_PASSES; pass++) platforms = separatePlatforms(platforms);
        platformsOf.set(node.id, platforms);
    }
    const hints = loadPlatformHints();
    for (const t of activeTrips.values()) assignPlatforms(t, platformsOf, hints, routes[t.routeId]?.type);

    // --- DEPARTURES, TRIPS, WINDOWS ---
    const departuresByStop = new Map();
    const stopRoutes = new Map();
    const tripChunks = new Map();
    const tripRoutes = {};
    const tripWindows = {};
    const dayPos = new Map(days.map((d, i) => [d.str, i]));

    for (const [tripId, t] of activeTrips) {
        tripRoutes[tripId] = t.routeId;

        let flags = 0;
        for (const d of t.dates) flags |= 1 << dayPos.get(d.str);
        const first = t.stopTimes[0];
        const last = t.stopTimes[t.stopTimes.length - 1];
        tripWindows[tripId] = [first.departure, last.arrival, flags];

        t.stopTimes.forEach((st, i) => {
            const isLast = i === t.stopTimes.length - 1;
            const isRequestStop = st.symbols.has(SYMBOL.REQUEST_STOP);
            if (isLast || !st.node) return;

            // Routes with an unknown platform are listed on every platform of the station.
            const routeKey = st.isPlatformKnown ? `${st.node.id}-${st.platform.post}` : st.node.id;
            if (!stopRoutes.has(routeKey)) stopRoutes.set(routeKey, new Set());
            stopRoutes.get(routeKey).add(t.routeId);

            if (!departuresByStop.has(st.node.id)) departuresByStop.set(st.node.id, []);
            const deps = departuresByStop.get(st.node.id);
            for (const day of t.dates) {
                // Format: [trip_id, route_id, headsign, timestamp_ms, wheelchair_accessible, is_request_stop, platform_post]
                deps.push([tripId, t.routeId, t.headsign, day.midnight + st.departure * 60_000, t.wheelchair, isRequestStop ? 1 : 0, st.isPlatformKnown ? st.platform.post : null]);
            }
        });

        const chunkId = tripId.substring(0, CONFIG.TRIP_CHUNK_PREFIX).toUpperCase();
        if (!tripChunks.has(chunkId)) tripChunks.set(chunkId, {});
        // An empty stop_id marks an unlocated stop; the app renders it without a map point or link.
        tripChunks.get(chunkId)[tripId] = t.stopTimes.map(st => ({
            stop_id: st.platform ? `${st.node.id}-${st.platform.post}` : '',
            name: st.name,
            arrival_time: formatTime(st.arrival),
            departure_time: formatTime(st.departure),
            ...(st.platform ? { lat: round6(st.platform.lat), lon: round6(st.platform.lon) } : {}),
            is_passed: false,
            zone_id: st.node?.zone_id ?? null,
            is_request_stop: st.symbols.has(SYMBOL.REQUEST_STOP),
        }));
    }

    // --- STOPS: one station per Portabo node that any active trip serves ---
    const servedNodes = new Map();
    for (const t of activeTrips.values()) {
        for (const st of t.stopTimes) if (st.node) servedNodes.set(st.node.id, st.node);
    }

    const linesOf = (...keys) => {
        const seen = new Map();
        for (const routeId of keys.flatMap(key => [...(stopRoutes.get(key) ?? [])])) {
            const route = routes[routeId];
            if (route && !seen.has(route.name)) seen.set(route.name, route);
        }
        return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    };

    const features = [];
    const parentChildMap = {};
    for (const node of servedNodes.values()) {
        const parentId = `${CONFIG.STATION_PREFIX}${node.id}`;
        features.push({
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [round6(node.lon), round6(node.lat)] },
            properties: { stop_id: parentId, stop_name: node.name, platform_code: null, location_type: 1, parent_station: null, zone_id: node.zone_id, lines: [] },
        });
        parentChildMap[parentId] = [];
        for (const platform of platformsOf.get(node.id)) {
            const id = `${node.id}-${platform.post}`;
            const platformCode = Number(platform.post) < CONFIG.FIRST_UNNUMBERED_POST ? platform.post : null;
            const lines = linesOf(id, node.id);
            features.push({
                type: 'Feature',
                geometry: { type: 'Point', coordinates: [round6(platform.lon), round6(platform.lat)] },
                properties: { stop_id: id, stop_name: node.name, platform_code: platformCode, location_type: 0, parent_station: parentId, zone_id: node.zone_id, is_drop_off_only: lines.length === 0 || undefined, lines },
            });
            parentChildMap[parentId].push(id);
        }
    }

    // --- SAFETY CHECK ---
    if (departuresByStop.size < CONFIG.MIN_DEPARTURE_STOPS || activeTrips.size < CONFIG.MIN_ACTIVE_TRIPS) {
        throw new Error(`Safety Check Failed: only ${departuresByStop.size} stops and ${activeTrips.size} trips. Aborting to prevent data wipeout.`);
    }

    fs.writeFileSync(path.join(DATA_DIR, 'stops.json'), JSON.stringify(features));
    fs.writeFileSync(path.join(DATA_DIR, 'parent_child_map.json'), JSON.stringify(parentChildMap));
    fs.writeFileSync(path.join(DATA_DIR, 'post_aliases.json'), JSON.stringify(postAliases));
    fs.writeFileSync(path.join(DATA_DIR, 'routes.json'), JSON.stringify(routes));
    fs.writeFileSync(path.join(DATA_DIR, 'trip_routes.json'), JSON.stringify(tripRoutes));
    // JDF has no geometry; the app draws the route stop to stop.
    fs.writeFileSync(path.join(DATA_DIR, 'trip_shapes.json'), JSON.stringify({}));
    console.log(`Wrote ${servedNodes.size} stations and ${Object.keys(routes).length} routes`);

    const tripWindowsPayload = JSON.stringify({ days: days.map(d => d.str), trips: tripWindows });
    fs.writeFileSync(path.join(DATA_DIR, 'trip_windows.json'), tripWindowsPayload);
    console.log(`Wrote trip_windows.json: ${Object.keys(tripWindows).length} trips, ${(tripWindowsPayload.length / 1024).toFixed(0)}KB`);

    const departuresChunks = new Map();
    for (const [stopId, deps] of departuresByStop) {
        deps.sort((a, b) => a[3] - b[3]);
        const chunkId = stopId.substring(0, CONFIG.DEPARTURES_CHUNK_PREFIX).toUpperCase();
        if (!departuresChunks.has(chunkId)) departuresChunks.set(chunkId, {});
        departuresChunks.get(chunkId)[stopId] = deps;
    }
    writeChunks(path.join(DATA_DIR, 'departures'), departuresChunks);
    console.log(`Wrote ${departuresChunks.size} departure chunks for ${departuresByStop.size} stops`);

    writeChunks(path.join(DATA_DIR, 'trips'), tripChunks);
    console.log(`Wrote ${tripChunks.size} trip chunks for ${activeTrips.size} trips`);
    console.log('Done!');
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
