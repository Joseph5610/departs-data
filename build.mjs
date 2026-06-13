import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import https from 'https';
import AdmZip from 'adm-zip';
import { parse } from 'csv-parse/sync';

function getTodayAndTomorrow() {
    // Return arrays of YYYYMMDD and midnight timestamps
    const tz = 'Europe/Prague';
    const formatter = new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
    
    const formatDt = (dt) => {
        const parts = formatter.formatToParts(dt);
        const y = parts.find(p => p.type === 'year').value;
        const m = parts.find(p => p.type === 'month').value;
        const d = parts.find(p => p.type === 'day').value;
        return {
            str: `${y}${m}${d}`,
            midnight: new Date(`${y}-${m}-${d}T00:00:00+02:00`).getTime() // rough, assume summer time for now
        };
    };

    const today = new Date();
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);

    return [formatDt(today), formatDt(tomorrow)];
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function downloadFile(url, dest) {
    return new Promise((resolve, reject) => {
        const file = fs.createWriteStream(dest);
        https.get(url, (response) => {
            if (response.statusCode === 301 || response.statusCode === 302) {
                return downloadFile(response.headers.location, dest).then(resolve).catch(reject);
            }
            response.pipe(file);
            file.on('finish', () => {
                file.close(resolve);
            });
        }).on('error', (err) => {
            fs.unlink(dest, () => reject(err));
        });
    });
}

function parseCSV(buffer) {
    return parse(buffer, {
        columns: true,
        skip_empty_lines: true,
        bom: true,
    });
}

const GTFS_URL = 'https://kordis-jmk.cz/gtfs/gtfs.zip';
const CITY = 'brno';
const DATA_DIR = path.join(__dirname, CITY);

async function checkLastModified(url, lastModifiedPath) {
    return new Promise((resolve, reject) => {
        const req = https.request(url, { method: 'HEAD' }, (res) => {
            if (res.statusCode === 301 || res.statusCode === 302) {
                return checkLastModified(res.headers.location, lastModifiedPath).then(resolve).catch(reject);
            }
            const etag = res.headers.etag || res.headers['last-modified'];
            let lastEtag = '';
            try {
                if (fs.existsSync(lastModifiedPath)) {
                    lastEtag = fs.readFileSync(lastModifiedPath, 'utf8').trim();
                }
            } catch(e) {}
            
            if (etag && lastEtag === etag) {
                resolve({ changed: false, etag });
            } else {
                resolve({ changed: true, etag });
            }
        });
        req.on('error', reject);
        req.end();
    });
}

async function main() {
    console.log(`[${CITY}] Starting GTFS preprocess...`);
    fs.mkdirSync(DATA_DIR, { recursive: true });

    const lastModifiedPath = path.join(DATA_DIR, '.last_modified');

    console.log(`Checking if ${GTFS_URL} changed...`);
    const { changed, etag } = await checkLastModified(GTFS_URL, lastModifiedPath);
    if (!changed && !process.env.FORCE_REBUILD) {
        console.log(`No changes detected (ETag/Last-Modified: ${etag}). Exiting.`);
        return;
    }
    console.log(`Changes detected or rebuild forced. Processing new GTFS data...`);

    const zipPath = path.join(__dirname, 'temp.zip');
    
    console.log(`Downloading GTFS from ${GTFS_URL}...`);
    await downloadFile(GTFS_URL, zipPath);
    
    console.log('Extracting ZIP...');
    const zip = new AdmZip(zipPath);
    
    // Parse routes
    console.log('Parsing routes.txt...');
    const routesEntry = zip.getEntry('routes.txt');
    const routesCsv = parseCSV(routesEntry.getData());
    const routes = new Map();
    for (const r of routesCsv) {
        routes.set(r.route_id, {
            name: r.route_short_name,
            type: r.route_type,
            route_color: r.route_color ? `#${r.route_color}` : '#007DA8'
        });
    }

    // Parse trips
    console.log('Parsing trips.txt...');
    const tripsEntry = zip.getEntry('trips.txt');
    const tripsCsv = parseCSV(tripsEntry.getData());
    const trips = new Map();
    const tripsForDepartures = new Map(); // trip_id -> { route_id, headsign, service_id }
    for (const t of tripsCsv) {
        trips.set(t.trip_id, t.route_id);
        tripsForDepartures.set(t.trip_id, {
            route_id: t.route_id,
            headsign: t.trip_headsign,
            service_id: t.service_id
        });
    }

    // Parse calendar.txt and calendar_dates.txt for active services
    console.log('Parsing calendar for active dates...');
    const dates = getTodayAndTomorrow();
    const activeDatesStr = dates.map(d => d.str);
    
    let calendarCsv = [];
    try { calendarCsv = parseCSV(zip.getEntry('calendar.txt').getData()); } catch (e) {}
    
    let datesCsv = [];
    try { datesCsv = parseCSV(zip.getEntry('calendar_dates.txt').getData()); } catch (e) {}
    
    const serviceDates = new Map(); // service_id -> Array of valid date objects (from dates)
    for (const targetDate of dates) {
        const targetStr = targetDate.str;
        const targetDateObj = new Date(`${targetStr.substring(0,4)}-${targetStr.substring(4,6)}-${targetStr.substring(6,8)}T12:00:00Z`);
        const dayOfWeek = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'][targetDateObj.getDay()];

        for (const cal of calendarCsv) {
            if (targetStr >= cal.start_date && targetStr <= cal.end_date) {
                if (cal[dayOfWeek] === '1') {
                    if (!serviceDates.has(cal.service_id)) serviceDates.set(cal.service_id, []);
                    serviceDates.get(cal.service_id).push(targetDate);
                }
            }
        }
    }

    // Apply exceptions
    for (const ex of datesCsv) {
        const targetDate = dates.find(d => d.str === ex.date);
        if (!targetDate) continue;

        if (!serviceDates.has(ex.service_id)) serviceDates.set(ex.service_id, []);
        const datesArr = serviceDates.get(ex.service_id);

        if (ex.exception_type === '1') { // Added
            if (!datesArr.includes(targetDate)) datesArr.push(targetDate);
        } else if (ex.exception_type === '2') { // Removed
            const idx = datesArr.indexOf(targetDate);
            if (idx !== -1) datesArr.splice(idx, 1);
        }
    }
    
    const activeTrips = new Map(); // trip_id -> { route_id, headsign, dates }
    for (const [tripId, t] of tripsForDepartures.entries()) {
        const datesArr = serviceDates.get(t.service_id);
        if (datesArr && datesArr.length > 0) {
            activeTrips.set(tripId, {
                route_id: t.route_id,
                headsign: t.headsign,
                dates: datesArr
            });
        }
    }
    console.log(`Found ${activeTrips.size} active trips for next 48h`);

    // Parse stop_times to map stop_id -> Set of route_ids
    console.log('Parsing stop_times.txt (this may take a while)...');
    const stopTimesEntry = zip.getEntry('stop_times.txt');
    const stopTimesCsv = parseCSV(stopTimesEntry.getData());
    const stopRoutes = new Map();
    const departuresByStop = new Map(); // stop_id -> Array of departures
    const tripsData = new Map(); // trip_id -> Array of stops

    for (const st of stopTimesCsv) {
        if (!stopRoutes.has(st.stop_id)) {
            stopRoutes.set(st.stop_id, new Set());
        }
        const routeId = trips.get(st.trip_id);
        if (routeId) {
            stopRoutes.get(st.stop_id).add(routeId);
        }
        
        // Collect trip data for vehicle details
        if (st.departure_time) {
            if (!tripsData.has(st.trip_id)) tripsData.set(st.trip_id, []);
            tripsData.get(st.trip_id).push({
                stop_id: st.stop_id,
                arrival_time: st.arrival_time,
                departure_time: st.departure_time,
                stop_sequence: Number(st.stop_sequence)
            });
        }
        
        // Save departure times for active trips
        const activeTrip = activeTrips.get(st.trip_id);
        if (activeTrip && st.departure_time) {
            const [hours, minutes, seconds] = st.departure_time.split(':').map(Number);
            if (!departuresByStop.has(st.stop_id)) departuresByStop.set(st.stop_id, []);
            const deps = departuresByStop.get(st.stop_id);
            
            for (const d of activeTrip.dates) {
                let targetMidnight = d.midnight;
                let finalHours = hours;
                if (finalHours >= 24) {
                    finalHours -= 24;
                    targetMidnight += 24 * 60 * 60 * 1000;
                }
                const timestamp = targetMidnight + (finalHours * 3600000) + (minutes * 60000) + (seconds * 1000);
                
                // Format: [trip_id, route_id, headsign, timestamp_ms]
                deps.push([st.trip_id, activeTrip.route_id, activeTrip.headsign, timestamp]);
            }
        }
    }

    // Parse stops
    console.log('Parsing stops.txt...');
    const stopsEntry = zip.getEntry('stops.txt');
    const stopsCsv = parseCSV(stopsEntry.getData());
    
    const features = [];
    for (const s of stopsCsv) {
        // Skip stops without location
        if (!s.stop_lat || !s.stop_lon) continue;
        
        const type = Number(s.location_type || 0);
        // We want physical stops (0), stations (1) and entrances (2)
        if (type !== 0 && type !== 1 && type !== 2) continue;
        
        const routeIds = stopRoutes.get(s.stop_id) || new Set();
        const lines = [];
        
        for (const rid of routeIds) {
            const route = routes.get(rid);
            if (route) {
                // Deduplicate by name
                if (!lines.find(l => l.name === route.name)) {
                    lines.push(route);
                }
            }
        }
        
        // Sort lines alphabetically
        lines.sort((a, b) => a.name.localeCompare(b.name, undefined, {numeric: true}));
        
        const feature = {
            type: 'Feature',
            geometry: {
                type: 'Point',
                coordinates: [Number(s.stop_lon), Number(s.stop_lat)]
            },
            properties: {
                stop_id: s.stop_id,
                stop_name: s.stop_name,
                platform_code: s.platform_code || null,
                location_type: type,
                parent_station: s.parent_station || null,
                zone_id: s.zone_id || null,
                lines: lines
            }
        };
        features.push(feature);
    }
    
    console.log(`Writing ${features.length} stops to stops.json...`);
    fs.writeFileSync(path.join(DATA_DIR, 'stops.json'), JSON.stringify(features));
    
    // Also save routes.json for later RT mapping (Phase 3)
    const routesOutput = {};
    for (const [id, r] of routes.entries()) {
        routesOutput[id] = r;
    }
    fs.writeFileSync(path.join(DATA_DIR, 'routes.json'), JSON.stringify(routesOutput));
    
    // Save trip->route mapping for GTFS-RT vehicle resolving
    const tripRoutesOutput = {};
    for (const [tripId, routeId] of trips.entries()) {
        tripRoutesOutput[tripId] = routeId;
    }
    fs.writeFileSync(path.join(DATA_DIR, 'trip_routes.json'), JSON.stringify(tripRoutesOutput));
    


    const publicDeparturesDir = path.join(__dirname, 'brno', 'departures');
    const publicTripsDir = path.join(__dirname, 'brno', 'trips');

    // --- SAFETY CHECK ---
    // Prevent accidental data deletion if Kordis provides an empty or corrupted GTFS file
    if (departuresByStop.size < 1000 || tripsData.size < 5000) {
        throw new Error(`Safety Check Failed: Only found ${departuresByStop.size} stops and ${tripsData.size} trips. Aborting to prevent data wipeout.`);
    }

    if (fs.existsSync(publicDeparturesDir)) {
        fs.rmSync(publicDeparturesDir, { recursive: true, force: true });
    }
    if (fs.existsSync(publicTripsDir)) {
        fs.rmSync(publicTripsDir, { recursive: true, force: true });
    }
    fs.mkdirSync(publicDeparturesDir, { recursive: true });
    fs.mkdirSync(publicTripsDir, { recursive: true });

    console.log(`Writing chunked departure files for ${departuresByStop.size} stops to external repo...`);
    
    // Group departures by first 3 chars of stop_id to avoid generating thousands of tiny files
    const departuresChunks = new Map();
    for (const [stopId, deps] of departuresByStop.entries()) {
        deps.sort((a, b) => a[3] - b[3]);
        
        // Use first 3 chars for grouping (e.g. U01, U13)
        const chunkId = stopId.substring(0, 3).toUpperCase();
        if (!departuresChunks.has(chunkId)) {
            departuresChunks.set(chunkId, {});
        }
        departuresChunks.get(chunkId)[stopId] = deps;
    }

    for (const [chunkId, data] of departuresChunks.entries()) {
        const safeChunkId = encodeURIComponent(chunkId);
        fs.writeFileSync(path.join(publicDeparturesDir, `${safeChunkId}.json`), JSON.stringify(data));
    }
    console.log(`Successfully wrote ${departuresChunks.size} chunked departure files to external repo.`);
    
    // First map stop names and coords for trips
    const stopNodes = new Map();
    for (const f of features) {
        stopNodes.set(f.properties.stop_id, {
            name: f.properties.stop_name,
            lon: f.geometry.coordinates[0],
            lat: f.geometry.coordinates[1]
        });
    }

    // Write chunked trip files
    // Chunking reduces the file count from ~60,000 to ~150, significantly improving Git/GitHub Pages performance
    console.log(`Writing chunked trip files for ${tripsData.size} trips to external repo...`);
    const tripChunks = new Map();

    for (const [tripId, stops] of tripsData.entries()) {
        stops.sort((a, b) => a.stop_sequence - b.stop_sequence);
        const stations = stops.map(s => {
            const node = stopNodes.get(s.stop_id);
            return {
                stop_id: s.stop_id,
                name: node?.name || s.stop_id,
                arrival_time: s.arrival_time,
                departure_time: s.departure_time,
                lat: node?.lat,
                lon: node?.lon,
                is_passed: false
            };
        });
        
        // E.g. tripId="50477", chunkId="504"
        const chunkId = tripId.substring(0, 3).toUpperCase();
        if (!tripChunks.has(chunkId)) {
            tripChunks.set(chunkId, {});
        }
        tripChunks.get(chunkId)[tripId] = stations;
    }

    for (const [chunkId, data] of tripChunks.entries()) {
        const safeChunkId = encodeURIComponent(chunkId);
        fs.writeFileSync(path.join(publicTripsDir, `${safeChunkId}.json`), JSON.stringify(data));
    }
    console.log(`Successfully wrote ${tripChunks.size} chunked trip files to external repo.`);
    
    if (etag) {
        fs.writeFileSync(lastModifiedPath, etag);
    }

    // Cleanup
    fs.unlinkSync(zipPath);
    console.log('Done!');
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
