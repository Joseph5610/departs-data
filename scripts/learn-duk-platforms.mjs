import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

/**
 * Learns which platform each DÚK line uses at a station, from Portabo's live data traced through the
 * static trips of `build-duk.mjs`:
 * - live boards name the post each departure leaves from, and
 * - the traffic feed names the node and post each vehicle last reached.
 * A hint is keyed by station, line and next stop, so it holds for every trip of that line going
 * that way. Hints merge into `duk/platform_hints.json`, which the next `build-duk.mjs` run applies.
 * Boards only reach a couple of hours ahead, so this runs hourly around the clock.
 */
const CONFIG = {
    CITY: 'duk',
    TRAFFIC_URL: 'https://tabule.portabo.cz/api/v1-tabule/cis/GetTraffic/0',
    BOARD_URL: 'https://tabule.portabo.cz/api/v1-tabule/cis/GetStationDeparturesWCount',
    /** The most departures Portabo returns per board request. */
    BOARD_DEPARTURE_COUNT: 30,
    BOARD_CONCURRENCY: 8,
    BOARD_FETCH_ATTEMPTS: 3,
    /** A station board reaching less far ahead than this is fetched platform by platform instead. */
    BOARD_MIN_SPAN_MS: 75 * 60_000,
    /** Must match build-duk.mjs: trips live in `trips/<first 3 chars>.json`, departures in `departures/<first 4>.json`. */
    TRIP_CHUNK_PREFIX: 3,
    DEPARTURE_CHUNK_PREFIX: 4,
    STATION_PREFIX: 'centroid-',
    LINE_NUMBER_LENGTH: 6,
    /** Posts from here on are rail/ferry stops or Portabo's catch-all, not bus platforms. */
    FIRST_UNNUMBERED_POST: 90,
    /** Hints not confirmed for this long are dropped, so a moved line stops using its old platform. */
    PLATFORM_HINT_MAX_AGE_DAYS: 60,
    TIME_ZONE: 'Europe/Prague',
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', CONFIG.CITY);
const DAY_MS = 86_400_000;
const readJson = (file, fallback) => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : fallback);

function localParts(ms) {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
        timeZone: CONFIG.TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(new Date(ms)).map(p => [p.type, p.value]));
    return { date: `${parts.year}${parts.month}${parts.day}`, minuteOfDay: Number(parts.hour) * 60 + Number(parts.minute) };
}

/** Must match build-duk.mjs `platformHintKey`. */
function platformHintKey(nodeId, routeId, nextNodeId) {
    return `${nodeId}|${routeId}|${nextNodeId ?? 'end'}`;
}

/** A stop name reduced to its last part for comparison: "Ústí n.L.,Dobětice točna" -> "dobeticetocna". */
function directionKey(name) {
    const last = name.split(',').pop() ?? name;
    return last.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

const timeMinutes = (hhmmss) => {
    const [h, m] = hhmmss.split(':').map(Number);
    return h * 60 + m;
};

async function fetchJson(url) {
    for (let attempt = 0; attempt < CONFIG.BOARD_FETCH_ATTEMPTS; attempt++) {
        const res = await fetch(url, { headers: { Accept: 'application/json' } }).catch(() => null);
        const body = res?.ok ? await res.json().catch(() => null) : null;
        if (body) return body;
    }
    return null;
}

function createTripIndex() {
    const chunks = new Map();
    const tripStops = (tripId) => {
        const chunkId = tripId.substring(0, CONFIG.TRIP_CHUNK_PREFIX).toUpperCase();
        if (!chunks.has(chunkId)) chunks.set(chunkId, readJson(path.join(DATA_DIR, 'trips', `${encodeURIComponent(chunkId)}.json`), {}));
        return chunks.get(chunkId)[tripId] ?? [];
    };
    /** The node a trip goes on to after its call at `node`, at `minuteOfDay` when given; undefined when it ends there. */
    const nextNodeAfter = (tripId, node, minuteOfDay) => {
        const located = tripStops(tripId).filter(s => s.stop_id);
        const at = located.findIndex(s => s.stop_id.startsWith(`${node}-`)
            && (minuteOfDay === undefined || timeMinutes(s.departure_time) % 1440 === minuteOfDay));
        if (at < 0 || at === located.length - 1) return undefined;
        return located[at + 1].stop_id.split('-')[0];
    };
    return { nextNodeAfter };
}

/** Platforms of each board departure, traced to the static trip leaving at that minute. */
async function learnFromBoards(hints, { routes, aliases, trips, today }) {
    const parentChildMap = readJson(path.join(DATA_DIR, 'parent_child_map.json'), {});
    const stations = Object.entries(parentChildMap)
        .filter(([, children]) => children.length >= 2)
        .map(([id, children]) => ({ node: id.slice(CONFIG.STATION_PREFIX.length), posts: children.map(c => c.split('-')[1]) }));

    const departureChunks = new Map();
    const timetableAt = (node) => {
        const chunkId = node.substring(0, CONFIG.DEPARTURE_CHUNK_PREFIX);
        if (!departureChunks.has(chunkId)) departureChunks.set(chunkId, readJson(path.join(DATA_DIR, 'departures', `${encodeURIComponent(chunkId)}.json`), {}));
        const byMinute = new Map();
        for (const [tripId, routeId, headsign, ts] of departureChunks.get(chunkId)[node] ?? []) {
            const key = `${routes[routeId]?.name}|${Math.round(ts / 60_000)}`;
            const bucket = byMinute.get(key) ?? [];
            bucket.push({ tripId, routeId, headsign: directionKey(headsign) });
            byMinute.set(key, bucket);
        }
        return byMinute;
    };

    const fetchBoard = async (node, post) => (await fetchJson(`${CONFIG.BOARD_URL}/${node}/${post}/${CONFIG.BOARD_DEPARTURE_COUNT}/0`))?.DeparturesList ?? null;
    const boardSpan = (board) => {
        const times = board.map(d => Date.parse(d.TODepartureDT)).filter(Number.isFinite);
        return times.length ? Math.max(...times) - Math.min(...times) : 0;
    };

    let traced = 0;
    let failed = 0;
    for (let i = 0; i < stations.length; i += CONFIG.BOARD_CONCURRENCY) {
        await Promise.all(stations.slice(i, i + CONFIG.BOARD_CONCURRENCY).map(async ({ node, posts }) => {
            let board = await fetchBoard(node, 0);
            if (!board) { failed++; return; }
            if (board.length >= CONFIG.BOARD_DEPARTURE_COUNT && boardSpan(board) < CONFIG.BOARD_MIN_SPAN_MS) {
                const perPost = await Promise.all(posts.map(post => fetchBoard(node, post)));
                board = perPost.flatMap(b => b ?? []);
            }
            if (!board.length) return;

            const timetable = timetableAt(node);
            const directionsAt = new Map();
            for (const d of board) {
                const key = `${d.LineName}|${Math.round(Date.parse(d.TODepartureDT) / 60_000)}`;
                directionsAt.set(key, (directionsAt.get(key) ?? new Set()).add(directionKey(d.Direction ?? '')));
            }
            for (const d of board) {
                if (d.StationPost == null || d.StationPost >= CONFIG.FIRST_UNNUMBERED_POST) continue;
                const departureMs = Date.parse(d.TODepartureDT);
                const minuteKey = `${d.LineName}|${Math.round(departureMs / 60_000)}`;
                const candidates = timetable.get(minuteKey) ?? [];
                // Both directions can leave in the same minute; only the board's direction tells them apart.
                const direction = directionKey(d.Direction ?? '');
                const heading = candidates.filter(c => direction && c.headsign && (direction.includes(c.headsign) || c.headsign.includes(direction)));
                const isOneWay = directionsAt.get(minuteKey).size <= 1;
                const call = heading.length === 1 ? heading[0] : candidates.length === 1 && isOneWay ? candidates[0] : null;
                if (!call) continue;
                const nextNode = trips.nextNodeAfter(call.tripId, node, localParts(departureMs).minuteOfDay);
                if (!nextNode) continue;
                hints[platformHintKey(node, call.routeId, nextNode)] = { post: (aliases[`${node}-${d.StationPost}`] ?? `${node}-${d.StationPost}`).split('-')[1], seen: today };
                traced++;
            }
        }));
    }
    return { traced, stations: stations.length, failed };
}

/** Platforms vehicles report standing at, traced through the trip they run. */
async function learnFromVehicles(hints, { tripRoutes, aliases, trips, today }) {
    const traffic = await fetchJson(CONFIG.TRAFFIC_URL);
    if (!traffic) throw new Error('Portabo traffic fetch failed');

    const tripsByNumber = new Map();
    for (const tripId of Object.keys(tripRoutes)) {
        const [spoj, line] = tripId.split('-');
        const key = `${line}|${spoj}`;
        if (!tripsByNumber.has(key)) tripsByNumber.set(key, []);
        tripsByNumber.get(key).push(tripId);
    }

    let traced = 0;
    for (const v of traffic.VehicleList ?? []) {
        const post = v.StationPost;
        if (!v.CISLineID || !v.RouteID || !v.StationNode || !post || post >= CONFIG.FIRST_UNNUMBERED_POST) continue;
        const line = String(v.CISLineID).padStart(CONFIG.LINE_NUMBER_LENGTH, '0');
        const node = String(v.StationNode);
        const platform = (aliases[`${node}-${post}`] ?? `${node}-${post}`).split('-')[1];
        for (const tripId of tripsByNumber.get(`${line}|${v.RouteID}`) ?? []) {
            const nextNode = trips.nextNodeAfter(tripId, node);
            if (!nextNode) continue;
            hints[platformHintKey(node, tripRoutes[tripId], nextNode)] = { post: platform, seen: today };
            traced++;
            break;
        }
    }
    return { traced };
}

async function main() {
    const hintsFile = path.join(DATA_DIR, 'platform_hints.json');
    const hints = readJson(hintsFile, {});
    const before = Object.keys(hints).length;
    const context = {
        routes: readJson(path.join(DATA_DIR, 'routes.json'), {}),
        tripRoutes: readJson(path.join(DATA_DIR, 'trip_routes.json'), {}),
        aliases: readJson(path.join(DATA_DIR, 'post_aliases.json'), {}),
        trips: createTripIndex(),
        today: localParts(Date.now()).date,
    };

    const vehicles = await learnFromVehicles(hints, context);
    const boards = await learnFromBoards(hints, context);

    const cutoff = Date.now() - CONFIG.PLATFORM_HINT_MAX_AGE_DAYS * DAY_MS;
    for (const [key, hint] of Object.entries(hints)) {
        const seen = Date.UTC(Number(hint.seen.slice(0, 4)), Number(hint.seen.slice(4, 6)) - 1, Number(hint.seen.slice(6)));
        if (seen < cutoff) delete hints[key];
    }

    fs.writeFileSync(hintsFile, JSON.stringify(hints));
    console.log(`[${CONFIG.CITY}] ${vehicles.traced} vehicles and ${boards.traced} board departures traced over ${boards.stations} stations (${boards.failed} boards failed); hints ${before} → ${Object.keys(hints).length}`);
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
