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
const DATA_DIR = path.join(__dirname, '..', CITY);

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
                res.resume();
                resolve({ changed: false, etag });
            } else {
                res.resume();
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
        console.log(`No changes detected in GTFS file (ETag/Last-Modified: ${etag}). Continuing to generate the next 48h rolling window of departures...`);
    } else {
        console.log(`Changes detected or rebuild forced. Processing new GTFS data...`);
    }

    const zipPath = path.join(__dirname, '..', 'temp.zip');
    
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
    const tripsForDepartures = new Map(); // trip_id -> { route_id, headsign, service_id, wheelchair_accessible }
    for (const t of tripsCsv) {
        trips.set(t.trip_id, t.route_id);
        tripsForDepartures.set(t.trip_id, {
            route_id: t.route_id,
            headsign: t.trip_headsign,
            service_id: t.service_id,
            wheelchair_accessible: t.wheelchair_accessible,
            direction_id: t.direction_id || '0'
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
    
    const activeTrips = new Map(); // trip_id -> { route_id, headsign, dates, wheelchair_accessible }
    for (const [tripId, t] of tripsForDepartures.entries()) {
        const datesArr = serviceDates.get(t.service_id);
        if (datesArr && datesArr.length > 0) {
            activeTrips.set(tripId, {
                route_id: t.route_id,
                headsign: t.headsign,
                dates: datesArr,
                wheelchair_accessible: Number(t.wheelchair_accessible || 0)
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

    // Pass 1: compute max stop_sequence per trip across the entire GTFS timetable
    const tripMaxStopSeq = new Map(); // trip_id -> max stop_sequence
    for (const st of stopTimesCsv) {
        const seq = Number(st.stop_sequence);
        const cur = tripMaxStopSeq.get(st.trip_id);
        if (cur === undefined || seq > cur) tripMaxStopSeq.set(st.trip_id, seq);
    }

    // Pass 2: build all indexes
    for (const st of stopTimesCsv) {
        const routeId = trips.get(st.trip_id);
        const isLastStop = tripMaxStopSeq.get(st.trip_id) === Number(st.stop_sequence);
        const isNoPickup = st.pickup_type === '1';
        const isRequestStop = st.pickup_type === '3' || st.drop_off_type === '3' || st.pickup_type === '2' || st.drop_off_type === '2';

        // Record line for this stop if passengers can actually board (not last stop, not pickup_type=1)
        // Evaluates all GTFS schedule trips so daytime, weekday, and holiday stops are preserved regardless of build time
        if (routeId && !isLastStop && !isNoPickup) {
            if (!stopRoutes.has(st.stop_id)) {
                stopRoutes.set(st.stop_id, new Set());
            }
            stopRoutes.get(st.stop_id).add(routeId);
        }

        if (!activeTrips.has(st.trip_id)) continue;
        
        // Collect trip data for vehicle details
        if (st.departure_time) {
            if (!tripsData.has(st.trip_id)) tripsData.set(st.trip_id, []);
            tripsData.get(st.trip_id).push({
                stop_id: st.stop_id,
                arrival_time: st.arrival_time,
                departure_time: st.departure_time,
                stop_sequence: Number(st.stop_sequence),
                is_request_stop: isRequestStop
            });
        }
        
        // Save departure times for active 48h trips.
        const activeTrip = activeTrips.get(st.trip_id);
        if (activeTrip && st.departure_time && !isNoPickup && !isLastStop) {
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
                
                // Format: [trip_id, route_id, headsign, timestamp_ms, wheelchair_accessible, is_request_stop]
                deps.push([st.trip_id, activeTrip.route_id, activeTrip.headsign, timestamp, activeTrip.wheelchair_accessible, isRequestStop ? 1 : 0]);
            }
        }
    }

    // Parse stops
    console.log('Parsing stops.txt...');
    const stopsEntry = zip.getEntry('stops.txt');
    const stopsCsv = parseCSV(stopsEntry.getData());
    
    // Identify physical stops (type 0) that have active boarding lines
    const validPhysicalStopIds = new Set();
    const parentToChildPhysicalMap = new Map(); // parent_station -> array of valid physical stop_ids

    for (const s of stopsCsv) {
        const type = Number(s.location_type || 0);
        if (type === 0) {
            const routeIds = stopRoutes.get(s.stop_id);
            if (routeIds && routeIds.size > 0) {
                validPhysicalStopIds.add(s.stop_id);
                if (s.parent_station) {
                    if (!parentToChildPhysicalMap.has(s.parent_station)) {
                        parentToChildPhysicalMap.set(s.parent_station, []);
                    }
                    parentToChildPhysicalMap.get(s.parent_station).push(s.stop_id);
                }
            }
        }
    }

    const features = [];
    const validStopIds = new Set();

    for (const s of stopsCsv) {
        // Skip stops without location
        if (!s.stop_lat || !s.stop_lon) continue;
        
        const type = Number(s.location_type || 0);
        // We want physical stops (0), stations (1) and entrances (2)
        if (type !== 0 && type !== 1 && type !== 2) continue;
        
        const isDropOffOnly = type === 0 && !validPhysicalStopIds.has(s.stop_id);
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
                is_drop_off_only: isDropOffOnly || undefined,
                lines: lines
            }
        };
        features.push(feature);
        validStopIds.add(s.stop_id);
    }
    
    // Radial micro-offset pass for physical platform stops sharing exact coordinates
    const physicalFeatures = features.filter(f => f.properties.location_type === 0);
    const coordMap = new Map();
    for (const f of physicalFeatures) {
        const key = `${f.geometry.coordinates[0].toFixed(6)},${f.geometry.coordinates[1].toFixed(6)}`;
        if (!coordMap.has(key)) coordMap.set(key, []);
        coordMap.get(key).push(f);
    }

    const OFFSET_DIST = 0.00012; // ~12 meters separation
    let offsetCount = 0;
    for (const group of coordMap.values()) {
        if (group.length <= 1) continue;
        offsetCount += group.length;
        const count = group.length;
        group.forEach((f, idx) => {
            const angle = (2 * Math.PI * idx) / count;
            const deltaLng = OFFSET_DIST * Math.cos(angle);
            const deltaLat = OFFSET_DIST * Math.sin(angle);
            f.geometry.coordinates = [
                Number((f.geometry.coordinates[0] + deltaLng).toFixed(6)),
                Number((f.geometry.coordinates[1] + deltaLat).toFixed(6))
            ];
        });
    }
    console.log(`Applied radial micro-offsets to ${offsetCount} co-located platform stops.`);

    console.log(`Writing ${features.length} valid stops to stops.json...`);
    fs.writeFileSync(path.join(DATA_DIR, 'stops.json'), JSON.stringify(features));

    // Build parent-to-child stops map
    const parentChildMap = {};
    for (const s of stopsCsv) {
        if (s.parent_station && validStopIds.has(s.stop_id) && validStopIds.has(s.parent_station)) {
            if (!parentChildMap[s.parent_station]) {
                parentChildMap[s.parent_station] = [];
            }
            parentChildMap[s.parent_station].push(s.stop_id);
        }
    }
    console.log(`Writing parent_child_map.json...`);
    fs.writeFileSync(path.join(DATA_DIR, 'parent_child_map.json'), JSON.stringify(parentChildMap));
    
    // Also save routes.json for later RT mapping (Phase 3)
    const routesOutput = {};
    for (const [id, r] of routes.entries()) {
        routesOutput[id] = r;
    }
    fs.writeFileSync(path.join(DATA_DIR, 'routes.json'), JSON.stringify(routesOutput));
    
    // Save trip->route mapping (reverted back to simple route_id since ArcGIS provides precise trip_ids via api.txt)
    const tripRoutesOutput = {};
    for (const [tripId, activeData] of activeTrips.entries()) {
        tripRoutesOutput[tripId] = activeData.route_id;
    }
    fs.writeFileSync(path.join(DATA_DIR, 'trip_routes.json'), JSON.stringify(tripRoutesOutput));
    
    // Parse api.txt for ArcGIS live tracking mapping
    console.log('Parsing api.txt for ArcGIS mapping...');
    let apiTxt = '';
    try {
        const apiEntry = zip.getEntry('api.txt');
        if (apiEntry) {
            const buf = apiEntry.getData();
            const isUtf16Le = (buf[0] === 0xFF && buf[1] === 0xFE) || (buf.length > 2 && buf[1] === 0 && buf[3] === 0);
            apiTxt = isUtf16Le ? buf.toString('utf16le') : buf.toString('utf8');
        }
    } catch (e) {
        console.warn('api.txt not found in GTFS zip');
    }
    
    const apiMapping = {};
    if (apiTxt) {
        const lines = apiTxt.split('\n');
        for (const line of lines) {
            // Expected format: "Linka/CVlaku = trip_id: 8/5270 = 61969"
            const match = line.match(/:\s*([^/]+)\/([^=\s]+)\s*=\s*(\d+)/);
            if (match) {
                const lineId = match[1].trim();
                const routeId = match[2].trim();
                const tripId = match[3].trim();
                
                // Only map trips that are actually active in the next 48h
                const activeData = activeTrips.get(tripId);
                if (!activeData) continue;

                const key = `${lineId}-${routeId}`;
                
                // KORDIS assigns multiple trip_ids to the same Course (LineID-RouteID)
                // We need the schedule to resolve which one is currently running
                if (!apiMapping[key]) apiMapping[key] = [];
                
                // Get the start and end time from the parsed trip stops
                const stops = tripsData.get(tripId);
                let start = "00:00:00";
                let end = "23:59:59";
                if (stops && stops.length > 0) {
                    start = stops[0].departure_time || stops[0].arrival_time;
                    const lastStop = stops[stops.length - 1];
                    end = lastStop.departure_time || lastStop.arrival_time || start;
                }

                const parseTimeToMinutes = (timeStr) => {
                    const h = parseInt(timeStr.substring(0, 2), 10);
                    const m = parseInt(timeStr.substring(3, 5), 10);
                    return h * 60 + m;
                };
                const startMins = parseTimeToMinutes(start);
                const endMins = parseTimeToMinutes(end);
                
                // Avoid duplicating the exact same trip info
                if (!apiMapping[key].some(t => t.trip_id === tripId)) {
                    apiMapping[key].push({ 
                        trip_id: tripId, 
                        start, 
                        end,
                        start_mins: startMins,
                        end_mins: endMins,
                        dates: activeData.dates.map(d => d.str)
                    });
                }
            }
        }
        
        // Sort trips for each course by start time for easier backend binary search / iteration
        for (const key of Object.keys(apiMapping)) {
            apiMapping[key].sort((a, b) => a.start.localeCompare(b.start));
        }
        
        console.log(`Extracted ${Object.keys(apiMapping).length} unique courses with ${lines.length} total mappings from api.txt`);
    }
    fs.writeFileSync(path.join(DATA_DIR, 'api.json'), JSON.stringify(apiMapping));
    
    // --- AUTOMATIC TRIP ALIAS GENERATION ---
    console.log('Generating trip signatures and checking for legacy trip_aliases...');
    const currentTripSignatures = {};
    const signatureToNewTripId = new Map();
    const currentTripRouteShort = {};
    const currentByTopology = new Map();

    for (const [tripId, stops] of tripsData.entries()) {
        if (!stops || stops.length === 0) continue;
        stops.sort((a, b) => a.stop_sequence - b.stop_sequence);
        const activeTrip = activeTrips.get(tripId);
        const routeId = activeTrip?.route_id || '';
        const route = routes.get(routeId);
        const routeShort = route?.name || routeId;
        const directionId = activeTrip?.direction_id || '0';
        const startTime = stops[0].departure_time || stops[0].arrival_time || '';
        const endTime = stops[stops.length - 1].departure_time || stops[stops.length - 1].arrival_time || startTime;
        const startStop = stops[0].stop_id || '';
        const endStop = stops[stops.length - 1].stop_id || '';

        const sig = `${routeShort}|${directionId}|${startTime}|${endTime}|${startStop}|${endStop}`;
        currentTripSignatures[tripId] = sig;
        currentTripRouteShort[tripId] = routeShort;
        if (!signatureToNewTripId.has(sig)) {
            signatureToNewTripId.set(sig, tripId);
        }

        const parseTimeToMinutes = (timeStr) => {
            if (!timeStr) return 0;
            const p = timeStr.split(':');
            return parseInt(p[0]) * 60 + parseInt(p[1]);
        };
        const topologyKey = `${routeShort}|${directionId}|${startStop}|${endStop}`;
        if (!currentByTopology.has(topologyKey)) currentByTopology.set(topologyKey, []);
        currentByTopology.get(topologyKey).push({ 
            tripId, 
            startMins: parseTimeToMinutes(startTime), 
            endMins: parseTimeToMinutes(endTime) 
        });
    }

    const previousTripsPath = path.join(DATA_DIR, 'previous_trips.json');
    const existingAliasesPath = path.join(DATA_DIR, 'trip_aliases.json');
    if (fs.existsSync(previousTripsPath)) {
        try {
            const previousTrips = JSON.parse(fs.readFileSync(previousTripsPath, 'utf8'));
            const tripAliases = {};
            const newAliasesFromPrev = {};
            let collisionCount = 0;
            let droppedCount = 0;

            let fuzzyCount = 0;

            // 1. Generate aliases from previous_trips to current GTFS
            for (const [oldTripId, oldSig] of Object.entries(previousTrips)) {
                let newTripId = signatureToNewTripId.get(oldSig);

                if (newTripId) {
                    // DO NOT alias reused trip IDs
                    if (oldTripId in currentTripSignatures && oldTripId !== newTripId) {
                        continue;
                    }

                    const currentRouteShort = currentTripRouteShort[newTripId];
                    const oldRouteShort = oldSig.split('|')[0];
                    if (currentRouteShort !== oldRouteShort) {
                        newAliasesFromPrev[oldTripId] = newTripId; // collision fix
                        collisionCount++;
                    } else if (oldTripId !== newTripId) {
                        newAliasesFromPrev[oldTripId] = newTripId; // rename
                    }
                } else {
                    newAliasesFromPrev[oldTripId] = null; // dropped
                    droppedCount++;
                }
            }

            // 2. Chain existing aliases to preserve history (important for RT feeds lagging behind)
            if (fs.existsSync(existingAliasesPath)) {
                const existingAliases = JSON.parse(fs.readFileSync(existingAliasesPath, 'utf8'));
                for (const [veryOldId, prevId] of Object.entries(existingAliases)) {
                    if (prevId === null) {
                        tripAliases[veryOldId] = null;
                        continue;
                    }
                    if (veryOldId in currentTripSignatures) {
                        continue;
                    }
                    if (prevId in newAliasesFromPrev) {
                        tripAliases[veryOldId] = newAliasesFromPrev[prevId];
                    } else if (prevId in currentTripSignatures) {
                        tripAliases[veryOldId] = prevId; // Still valid in current GTFS
                    } else {
                        tripAliases[veryOldId] = null; // Target no longer exists
                    }
                }
            }
            
            // 3. Add any new aliases that weren't covered by history chaining
            for (const [prevId, newId] of Object.entries(newAliasesFromPrev)) {
                if (!(prevId in tripAliases)) {
                    tripAliases[prevId] = newId;
                }
            }

            // Filter out self-aliases just in case
            for (const key of Object.keys(tripAliases)) {
                if (tripAliases[key] === key) delete tripAliases[key];
            }

            console.log(`Generated/Chained ${Object.keys(tripAliases).length} total trip aliases (${collisionCount} collisions fixed, ${fuzzyCount} fuzzy matched, ${droppedCount} dropped).`);
            fs.writeFileSync(existingAliasesPath, JSON.stringify(tripAliases));
        } catch (err) {
            console.error('Failed to parse previous_trips.json for alias generation:', err);
        }
    }

    // Save current trip signatures for the next timetable build
    fs.writeFileSync(previousTripsPath, JSON.stringify(currentTripSignatures));


    const publicDeparturesDir = path.join(__dirname, '..', 'brno', 'departures');
    const publicTripsDir = path.join(__dirname, '..', 'brno', 'trips');

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
    
    // Group departures by first 4 chars of stop_id to avoid generating thousands of tiny files
    const departuresChunks = new Map();
    for (const [stopId, deps] of departuresByStop.entries()) {
        deps.sort((a, b) => a[3] - b[3]);
        
        // Use first 4 chars for grouping (e.g. U012, U134)
        const chunkId = stopId.substring(0, 4).toUpperCase();
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
            lat: f.geometry.coordinates[1],
            zone_id: f.properties.zone_id || null
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
                is_passed: false,
                zone_id: node?.zone_id || null,
                is_request_stop: s.is_request_stop
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
    
    // --- SHAPE FETCHING ---
    console.log('Fetching missing GTFS shapes for Brno from external API...');
    const publicShapesDir = path.join(__dirname, '..', 'brno', 'shapes');
    if (fs.existsSync(publicShapesDir)) {
        fs.rmSync(publicShapesDir, { recursive: true, force: true });
    }
    fs.mkdirSync(publicShapesDir, { recursive: true });

    const SHAPE_TOKEN = '$LISSY_API_TOKEN';
    const fetchShapes = (from, to) => {
        return new Promise((resolve, reject) => {
            const url = `https://dexter.fit.vutbr.cz/lissy/api/shapes/getTodayShapes?gtfs_trips_from=${from}&gtfs_trips_to=${to}`;
            https.get(url, { headers: { Authorization: SHAPE_TOKEN } }, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    try { resolve(JSON.parse(data)); }
                    catch (e) { reject(e); }
                });
            }).on('error', reject);
        });
    };

    const roundShape = (shape) => {
        return shape.map(line => line.map(point => [
            Number(point[0].toFixed(5)),
            Number(point[1].toFixed(5))
        ]));
    };

    const tripShapesMap = {}; // trip_id -> shape_id
    const shapesChunks = new Map(); // chunkId -> { shape_id -> geometry }
    
    try {
        for (let i = 0; i < 25000; i += 5000) {
            console.log(`Fetching shapes from offset ${i} to ${i + 5000}...`);
            const res = await fetchShapes(i, i + 5000);
            if (!Array.isArray(res) || res.length === 0) break;
            
            for (const item of res) {
                // Save shape to chunk (group by first 2 chars of shape_id)
                const shapeIdStr = String(item.shape_id);
                const chunkId = shapeIdStr.substring(0, 2);
                if (!shapesChunks.has(chunkId)) {
                    shapesChunks.set(chunkId, {});
                }
                shapesChunks.get(chunkId)[shapeIdStr] = roundShape(item.shape);

                // Map trips to shape_id
                for (const tripId of item.gtfs_trips) {
                    const activeTrip = activeTrips.get(String(tripId));
                    if (activeTrip) {
                        tripShapesMap[tripId] = shapeIdStr;
                    }
                }
            }
        }
        
        console.log(`Writing chunked shape files for ${shapesChunks.size} chunks to external repo...`);
        for (const [chunkId, data] of shapesChunks.entries()) {
            const safeChunkId = encodeURIComponent(chunkId);
            fs.writeFileSync(path.join(publicShapesDir, `${safeChunkId}.json`), JSON.stringify(data));
        }
        
        console.log(`Writing trip_shapes.json mapping for ${Object.keys(tripShapesMap).length} trips...`);
        fs.writeFileSync(path.join(DATA_DIR, 'trip_shapes.json'), JSON.stringify(tripShapesMap));

    } catch (e) {
        console.error("Failed to fetch or process shapes, skipping shape generation.", e);
    }
    
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
