/**
 * Rebuilds `stop_search.*` and `sitemap_stops.txt` from each city's published `map-stops.json`,
 * without redownloading any feed. Usage: `node scripts/build-stop-search.ts <city dir>...`
 */
import fs from 'node:fs';
import path from 'node:path';
import { MAP_STOPS_FILE, type MapStopCollection } from './lib/contract.ts';
import { writeStopSearch } from './lib/stop-search.ts';

for (const dir of process.argv.slice(2)) {
    const mapStops = JSON.parse(fs.readFileSync(path.join(dir, MAP_STOPS_FILE), 'utf8')) as MapStopCollection;
    writeStopSearch(dir, mapStops);
    console.log(`[SYNC] ${dir}: indexed ${mapStops.features.length} stops`);
}
