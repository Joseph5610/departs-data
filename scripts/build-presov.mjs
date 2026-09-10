import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import AdmZip from 'adm-zip';
import { parse } from 'csv-parse/sync';

/**
 * Prešov (DPMP) static GTFS build.
 *
 * Emits the same file set and formats as build-brno.mjs so the departs-app GtfsAdapter reads it
 * unchanged. Differences are confined to what the DPMP feed lacks or encodes differently: no
 * parent stations, no route colors, request stops marked by a `*` name suffix, and every id
 * prefixed with the monthly feed_version.
 */
const CONFIG = {
    CITY: 'presov',
    TIMEZONE: 'Europe/Bratislava',
    ARCGIS_ITEM_URL: 'https://www.arcgis.com/sharing/rest/content/items/f1033ca6c2f4461d9aba285e1c7cb079',

    /** Must match SHAPE_CHUNK_COUNT in departs-app `functions/_adapters/gtfs/core/config.ts`. */
    SHAPE_CHUNK_COUNT: 512,
    /** Must match DEPARTURES_CHUNK_PREFIX / TRIP_CHUNK_PREFIX in the same file. */
    DEPARTURES_CHUNK_PREFIX: 4,
    TRIP_CHUNK_PREFIX: 3,

    /** Same-named platforms further apart than this become separate stations. */
    STATION_CLUSTER_RADIUS_M: 300,
    /** Radial separation for platforms sharing exact coordinates (~12 m). */
    COLOCATED_OFFSET_DEG: 0.00012,
    SHAPE_COORD_DECIMALS: 5,

    /** Official DPMP network map scheme (dpmp.sk line network map, valid from 8. 1. 2025). */
    ROUTE_COLORS: {
        '1': '#55D400',
        '2': '#FF6600',
        '4': '#2A7FFF',
        '5': '#FFCC00',
        '5D': '#FFCC00',
        '7': '#338000',
        '8': '#0000AA',
        '28': '#FF0000',
        '32': '#008066',
        '32A': '#008066',
        '38': '#00CCFF',
        '39': '#800080',
        '45': '#FF0066',
    },
    /** Line groups without a map color, in DPMP/imhd.sk colors: school lines (A, C, … and H) and night lines. */
    ROUTE_COLOR_RULES: [
        { pattern: /^[A-Z]$/, color: '#EF7F1A' },
        { pattern: /^N\d+$/, color: '#00378A' },
    ],
    DEFAULT_ROUTE_COLOR: '#999999',

    /** Abort thresholds guarding against an empty or truncated upstream feed. */
    MIN_DEPARTURE_STOPS: 200,
    MIN_ACTIVE_TRIPS: 500,
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', CONFIG.CITY);
const DAY_MS = 86_400_000;

function parseCSV(buffer) {
    return parse(buffer, { columns: true, skip_empty_lines: true, bom: true, trim: false });
}

function readEntry(zip, name, required = true) {
    const entry = zip.getEntry(name);
    if (!entry) {
        if (required) throw new Error(`${name} missing from GTFS zip`);
        return [];
    }
    return parseCSV(entry.getData());
}

/** UTC offset of `timezone` at `atMs`, in milliseconds. */
function zoneOffsetMs(timezone, atMs) {
    const name = new Intl.DateTimeFormat('en-US', { timeZone: timezone, timeZoneName: 'longOffset' })
        .formatToParts(new Date(atMs))
        .find(p => p.type === 'timeZoneName')?.value ?? '';
    const m = /GMT([+-])(\d{2}):(\d{2})/.exec(name);
    return m ? (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 3_600_000 + Number(m[3]) * 60_000) : 0;
}

/** Yesterday, today and tomorrow as `{ str: YYYYMMDD, midnight: epoch ms }` in the feed timezone. */
function getServiceDays() {
    const nowMs = Date.now();
    const days = [];
    for (const offsetDays of [-1, 0, 1]) {
        const local = new Date(nowMs + zoneOffsetMs(CONFIG.TIMEZONE, nowMs) + offsetDays * DAY_MS);
        const y = local.getUTCFullYear();
        const m = String(local.getUTCMonth() + 1).padStart(2, '0');
        const d = String(local.getUTCDate()).padStart(2, '0');
        const utcMidnight = Date.UTC(y, local.getUTCMonth(), local.getUTCDate());
        // GTFS times are measured from "noon minus 12h", so resolve the offset at local noon.
        const midnight = utcMidnight - zoneOffsetMs(CONFIG.TIMEZONE, utcMidnight + 12 * 3_600_000);
        days.push({ str: `${y}${m}${d}`, midnight });
    }
    return days;
}

const timeToMinutes = (t) => {
    const [h, m] = t.split(':');
    return parseInt(h, 10) * 60 + parseInt(m, 10);
};

function routeColorFor(name) {
    const key = name.toUpperCase();
    return CONFIG.ROUTE_COLORS[key]
        ?? CONFIG.ROUTE_COLOR_RULES.find(rule => rule.pattern.test(key))?.color
        ?? CONFIG.DEFAULT_ROUTE_COLOR;
}

const REQUEST_STOP_SUFFIX = /\s*\*\s*$/;

function cleanStopName(raw) {
    return raw.replace(REQUEST_STOP_SUFFIX, '').replace(/\s{2,}/g, ' ').trim();
}

/** Grouping key tolerant of the feed's inconsistent spacing ("Rázc. Cemjata" vs "Rázc.Cemjata"). */
function stationKey(name) {
    return name.toLowerCase().replace(/\.\s*/g, '.').replace(/\s+/g, ' ').trim();
}

function slugify(name) {
    return name.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function distanceM(a, b) {
    const toRad = (x) => x * Math.PI / 180;
    const dLat = toRad(b.lat - a.lat);
    const dLon = toRad(b.lon - a.lon);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
    return 6_371_000 * 2 * Math.asin(Math.sqrt(h));
}

/** Single-linkage clusters of platforms within STATION_CLUSTER_RADIUS_M. */
function clusterByDistance(platforms) {
    const clusters = [];
    const assigned = new Set();
    for (const seed of platforms) {
        if (assigned.has(seed.stop_id)) continue;
        const cluster = [seed];
        assigned.add(seed.stop_id);
        for (let i = 0; i < cluster.length; i++) {
            for (const other of platforms) {
                if (assigned.has(other.stop_id)) continue;
                if (distanceM(cluster[i], other) <= CONFIG.STATION_CLUSTER_RADIUS_M) {
                    cluster.push(other);
                    assigned.add(other.stop_id);
                }
            }
        }
        clusters.push(cluster);
    }
    return clusters;
}

function writeChunks(dir, chunks) {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    for (const [chunkId, data] of chunks) {
        fs.writeFileSync(path.join(dir, `${encodeURIComponent(chunkId)}.json`), JSON.stringify(data));
    }
}

async function fetchItemModified() {
    const res = await fetch(`${CONFIG.ARCGIS_ITEM_URL}?f=json`);
    if (!res.ok) throw new Error(`ArcGIS item metadata fetch failed: ${res.status}`);
    const item = await res.json();
    return String(item.modified ?? '');
}

async function downloadZip() {
    const res = await fetch(`${CONFIG.ARCGIS_ITEM_URL}/data`, { redirect: 'follow' });
    if (!res.ok) throw new Error(`GTFS download failed: ${res.status}`);
    return new AdmZip(Buffer.from(await res.arrayBuffer()));
}

async function main() {
    console.log(`[${CONFIG.CITY}] Starting GTFS preprocess...`);
    fs.mkdirSync(DATA_DIR, { recursive: true });

    const lastModifiedPath = path.join(DATA_DIR, '.last_modified');
    const modified = await fetchItemModified();
    const previous = fs.existsSync(lastModifiedPath) ? fs.readFileSync(lastModifiedPath, 'utf8').trim() : '';
    console.log(modified && modified === previous
        ? `No feed change (modified ${modified}). Regenerating the rolling window...`
        : `Feed changed or first run (modified ${modified}). Processing...`);

    const zip = await downloadZip();

    const [feedInfo] = readEntry(zip, 'feed_info.txt', false);
    const idPrefix = feedInfo?.feed_version ? `${feedInfo.feed_version}_` : '';
    const normalizeId = (id) => (idPrefix && id.startsWith(idPrefix) ? id.slice(idPrefix.length) : id);
    console.log(`Feed version ${feedInfo?.feed_version ?? 'n/a'}, valid ${feedInfo?.feed_start_date ?? '?'}–${feedInfo?.feed_end_date ?? '?'}`);

    // --- ROUTES ---
    const routes = new Map();
    for (const r of readEntry(zip, 'routes.txt')) {
        const name = r.route_short_name || r.route_long_name || r.route_id;
        routes.set(r.route_id, {
            name,
            type: r.route_type,
            route_color: r.route_color ? `#${r.route_color}` : routeColorFor(name)
        });
    }

    // --- TRIPS ---
    const trips = new Map();
    for (const t of readEntry(zip, 'trips.txt')) {
        trips.set(normalizeId(t.trip_id), {
            route_id: t.route_id,
            headsign: t.trip_headsign,
            service_id: normalizeId(t.service_id),
            wheelchair_accessible: Number(t.wheelchair_accessible || 0),
            direction_id: Number(t.direction_id || 0),
            shape_id: t.shape_id || null
        });
    }

    // --- CALENDAR ---
    const days = getServiceDays();
    const dayByStr = new Map(days.map(d => [d.str, d]));
    const serviceDates = new Map();
    const addServiceDate = (serviceId, day) => {
        if (!serviceDates.has(serviceId)) serviceDates.set(serviceId, new Set());
        serviceDates.get(serviceId).add(day);
    };

    const weekdays = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
    for (const cal of readEntry(zip, 'calendar.txt', false)) {
        const serviceId = normalizeId(cal.service_id);
        for (const day of days) {
            if (day.str < cal.start_date || day.str > cal.end_date) continue;
            const dow = weekdays[new Date(day.midnight + 12 * 3_600_000).getUTCDay()];
            if (cal[dow] === '1') addServiceDate(serviceId, day);
        }
    }
    for (const ex of readEntry(zip, 'calendar_dates.txt', false)) {
        const day = dayByStr.get(ex.date);
        if (!day) continue;
        const serviceId = normalizeId(ex.service_id);
        if (ex.exception_type === '1') addServiceDate(serviceId, day);
        else if (ex.exception_type === '2') serviceDates.get(serviceId)?.delete(day);
    }

    const activeTrips = new Map();
    for (const [tripId, t] of trips) {
        const dates = serviceDates.get(t.service_id);
        if (dates && dates.size > 0) {
            activeTrips.set(tripId, { ...t, dates: [...dates].sort((a, b) => a.midnight - b.midnight) });
        }
    }
    console.log(`Found ${activeTrips.size} active trips across ${days.map(d => d.str).join(', ')}`);

    // --- STOPS (request flag lives in the name) ---
    const stopsCsv = readEntry(zip, 'stops.txt');
    const requestStopIds = new Set();
    for (const s of stopsCsv) {
        if (REQUEST_STOP_SUFFIX.test(s.stop_name)) requestStopIds.add(s.stop_id);
    }

    // --- STOP TIMES ---
    const stopTimesCsv = readEntry(zip, 'stop_times.txt');
    const tripMaxStopSeq = new Map();
    for (const st of stopTimesCsv) {
        const tripId = normalizeId(st.trip_id);
        const seq = Number(st.stop_sequence);
        if (!(tripMaxStopSeq.get(tripId) >= seq)) tripMaxStopSeq.set(tripId, seq);
    }

    const stopRoutes = new Map();
    const departuresByStop = new Map();
    const tripsData = new Map();

    for (const st of stopTimesCsv) {
        const tripId = normalizeId(st.trip_id);
        const trip = trips.get(tripId);
        if (!trip) continue;

        const isLastStop = tripMaxStopSeq.get(tripId) === Number(st.stop_sequence);
        const isNoPickup = st.pickup_type === '1';
        const isRequestStop = requestStopIds.has(st.stop_id)
            || st.pickup_type === '2' || st.pickup_type === '3'
            || st.drop_off_type === '2' || st.drop_off_type === '3';

        if (!isLastStop && !isNoPickup) {
            if (!stopRoutes.has(st.stop_id)) stopRoutes.set(st.stop_id, new Set());
            stopRoutes.get(st.stop_id).add(trip.route_id);
        }

        const activeTrip = activeTrips.get(tripId);
        if (!activeTrip || !st.departure_time) continue;

        if (!tripsData.has(tripId)) tripsData.set(tripId, []);
        tripsData.get(tripId).push({
            stop_id: st.stop_id,
            arrival_time: st.arrival_time,
            departure_time: st.departure_time,
            stop_sequence: Number(st.stop_sequence),
            is_request_stop: isRequestStop
        });

        if (isNoPickup || isLastStop) continue;

        const [hours, minutes, seconds] = st.departure_time.split(':').map(Number);
        const offsetMs = hours * 3_600_000 + minutes * 60_000 + (seconds || 0) * 1000;
        if (!departuresByStop.has(st.stop_id)) departuresByStop.set(st.stop_id, []);
        const deps = departuresByStop.get(st.stop_id);
        for (const day of activeTrip.dates) {
            // Format: [trip_id, route_id, headsign, timestamp_ms, wheelchair_accessible, is_request_stop]
            deps.push([tripId, activeTrip.route_id, activeTrip.headsign, day.midnight + offsetMs, activeTrip.wheelchair_accessible, isRequestStop ? 1 : 0]);
        }
    }

    // --- STATIONS: synthesise parents, since the feed ships platforms only ---
    const platforms = [];
    for (const s of stopsCsv) {
        if (Number(s.location_type || 0) !== 0 || !s.stop_lat || !s.stop_lon) continue;
        platforms.push({
            stop_id: s.stop_id,
            name: cleanStopName(s.stop_name),
            lat: Number(s.stop_lat),
            lon: Number(s.stop_lon),
            zone_id: s.zone_id || null
        });
    }

    const byName = new Map();
    for (const p of platforms) {
        const key = stationKey(p.name);
        if (!byName.has(key)) byName.set(key, []);
        byName.get(key).push(p);
    }

    const stations = [];
    const usedStationIds = new Set();
    for (const group of byName.values()) {
        group.sort((a, b) => a.stop_id.localeCompare(b.stop_id, undefined, { numeric: true }));
        const clusters = clusterByDistance(group);
        for (const cluster of clusters) {
            const base = `centroid-${slugify(cluster[0].name)}`;
            let id = base;
            for (let n = 2; usedStationIds.has(id); n++) id = `${base}-${n}`;
            usedStationIds.add(id);
            stations.push({ id, platforms: cluster });
        }
    }

    const round6 = (x) => Number(x.toFixed(6));
    const linesOf = (stopId) => {
        const seen = new Map();
        for (const rid of stopRoutes.get(stopId) ?? []) {
            const route = routes.get(rid);
            if (route && !seen.has(route.name)) seen.set(route.name, route);
        }
        return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    };

    const features = [];
    const parentChildMap = {};
    for (const station of stations) {
        const lat = station.platforms.reduce((sum, p) => sum + p.lat, 0) / station.platforms.length;
        const lon = station.platforms.reduce((sum, p) => sum + p.lon, 0) / station.platforms.length;
        features.push({
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [round6(lon), round6(lat)] },
            properties: {
                stop_id: station.id,
                stop_name: station.platforms[0].name,
                platform_code: null,
                location_type: 1,
                parent_station: null,
                zone_id: station.platforms[0].zone_id,
                lines: []
            }
        });
        parentChildMap[station.id] = [];
        for (const p of station.platforms) {
            const lines = linesOf(p.stop_id);
            features.push({
                type: 'Feature',
                geometry: { type: 'Point', coordinates: [p.lon, p.lat] },
                properties: {
                    stop_id: p.stop_id,
                    stop_name: p.name,
                    platform_code: null,
                    location_type: 0,
                    parent_station: station.id,
                    zone_id: p.zone_id,
                    is_drop_off_only: lines.length === 0 || undefined,
                    lines
                }
            });
            parentChildMap[station.id].push(p.stop_id);
        }
    }

    const coordGroups = new Map();
    for (const f of features) {
        if (f.properties.location_type !== 0) continue;
        const key = f.geometry.coordinates.map(c => c.toFixed(6)).join(',');
        if (!coordGroups.has(key)) coordGroups.set(key, []);
        coordGroups.get(key).push(f);
    }
    for (const group of coordGroups.values()) {
        if (group.length <= 1) continue;
        group.forEach((f, idx) => {
            const angle = (2 * Math.PI * idx) / group.length;
            const [lon, lat] = f.geometry.coordinates;
            f.geometry.coordinates = [
                round6(lon + CONFIG.COLOCATED_OFFSET_DEG * Math.cos(angle)),
                round6(lat + CONFIG.COLOCATED_OFFSET_DEG * Math.sin(angle))
            ];
        });
    }

    // --- SAFETY CHECK ---
    if (departuresByStop.size < CONFIG.MIN_DEPARTURE_STOPS || tripsData.size < CONFIG.MIN_ACTIVE_TRIPS) {
        throw new Error(`Safety Check Failed: only ${departuresByStop.size} stops and ${tripsData.size} trips (feed valid ${feedInfo?.feed_start_date ?? '?'}–${feedInfo?.feed_end_date ?? '?'}). Aborting to prevent data wipeout.`);
    }

    fs.writeFileSync(path.join(DATA_DIR, 'stops.json'), JSON.stringify(features));
    fs.writeFileSync(path.join(DATA_DIR, 'parent_child_map.json'), JSON.stringify(parentChildMap));
    fs.writeFileSync(path.join(DATA_DIR, 'routes.json'), JSON.stringify(Object.fromEntries(routes)));
    console.log(`Wrote ${stations.length} stations over ${platforms.length} platforms`);

    const tripRoutes = {};
    for (const [tripId, t] of activeTrips) tripRoutes[tripId] = t.route_id;
    fs.writeFileSync(path.join(DATA_DIR, 'trip_routes.json'), JSON.stringify(tripRoutes));

    // --- TRIP WINDOWS: Brno format plus a trailing direction_id for CSV trip matching ---
    const dayPos = new Map(days.map((d, i) => [d.str, i]));
    const tripWindows = {};
    for (const [tripId, stops] of tripsData) {
        stops.sort((a, b) => a.stop_sequence - b.stop_sequence);
        const first = stops[0];
        const last = stops[stops.length - 1];
        const start = first.departure_time || first.arrival_time;
        const end = last.arrival_time || last.departure_time || start;
        let flags = 0;
        for (const d of activeTrips.get(tripId).dates) flags |= 1 << dayPos.get(d.str);
        tripWindows[tripId] = [timeToMinutes(start), timeToMinutes(end), flags, activeTrips.get(tripId).direction_id];
    }
    const tripWindowsPayload = JSON.stringify({ days: days.map(d => d.str), trips: tripWindows });
    fs.writeFileSync(path.join(DATA_DIR, 'trip_windows.json'), tripWindowsPayload);
    console.log(`Wrote trip_windows.json: ${Object.keys(tripWindows).length} trips, ${(tripWindowsPayload.length / 1024).toFixed(0)}KB`);

    // --- DEPARTURES ---
    const departuresChunks = new Map();
    for (const [stopId, deps] of departuresByStop) {
        deps.sort((a, b) => a[3] - b[3]);
        const chunkId = stopId.substring(0, CONFIG.DEPARTURES_CHUNK_PREFIX).toUpperCase();
        if (!departuresChunks.has(chunkId)) departuresChunks.set(chunkId, {});
        departuresChunks.get(chunkId)[stopId] = deps;
    }
    writeChunks(path.join(DATA_DIR, 'departures'), departuresChunks);
    console.log(`Wrote ${departuresChunks.size} departure chunks for ${departuresByStop.size} stops`);

    // --- TRIPS ---
    const platformById = new Map(platforms.map(p => [p.stop_id, p]));
    const tripChunks = new Map();
    for (const [tripId, stops] of tripsData) {
        const stations = stops.map(s => {
            const node = platformById.get(s.stop_id);
            return {
                stop_id: s.stop_id,
                name: node?.name || s.stop_id,
                arrival_time: s.arrival_time,
                departure_time: s.departure_time,
                lat: node?.lat,
                lon: node?.lon,
                is_passed: false,
                zone_id: node?.zone_id || null,
                is_request_stop: s.is_request_stop
            };
        });
        const chunkId = tripId.substring(0, CONFIG.TRIP_CHUNK_PREFIX).toUpperCase();
        if (!tripChunks.has(chunkId)) tripChunks.set(chunkId, {});
        tripChunks.get(chunkId)[tripId] = stations;
    }
    writeChunks(path.join(DATA_DIR, 'trips'), tripChunks);
    console.log(`Wrote ${tripChunks.size} trip chunks for ${tripsData.size} trips`);

    // --- SHAPES (from shapes.txt) ---
    const tripShapes = {};
    const neededShapes = new Set();
    for (const [tripId, t] of activeTrips) {
        if (!t.shape_id) continue;
        tripShapes[tripId] = t.shape_id;
        neededShapes.add(t.shape_id);
    }

    const shapePoints = new Map();
    for (const pt of readEntry(zip, 'shapes.txt', false)) {
        if (!neededShapes.has(pt.shape_id)) continue;
        if (!shapePoints.has(pt.shape_id)) shapePoints.set(pt.shape_id, []);
        shapePoints.get(pt.shape_id).push([Number(pt.shape_pt_sequence), Number(pt.shape_pt_lon), Number(pt.shape_pt_lat)]);
    }

    const shapeChunks = new Map();
    const roundShape = (x) => Number(x.toFixed(CONFIG.SHAPE_COORD_DECIMALS));
    for (const [shapeId, pts] of shapePoints) {
        pts.sort((a, b) => a[0] - b[0]);
        const numeric = parseInt(shapeId, 10);
        const chunkId = String((Number.isNaN(numeric) ? 0 : Math.abs(numeric)) % CONFIG.SHAPE_CHUNK_COUNT);
        if (!shapeChunks.has(chunkId)) shapeChunks.set(chunkId, {});
        shapeChunks.get(chunkId)[shapeId] = [pts.map(([, lon, lat]) => [roundShape(lon), roundShape(lat)])];
    }
    writeChunks(path.join(DATA_DIR, 'shape_chunks'), shapeChunks);
    fs.writeFileSync(path.join(DATA_DIR, 'trip_shapes.json'), JSON.stringify(tripShapes));
    console.log(`Wrote ${shapePoints.size} shapes into ${shapeChunks.size} chunks`);

    if (modified) fs.writeFileSync(lastModifiedPath, modified);
    console.log('Done!');
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
