import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { INDOOR_CELL_DEG, INDOOR_DIR, INDOOR_INDEX_FILE, STOPS_FILE, type IndoorFeature, type IndoorIndexFile, type IndoorPosition, type StopsFile } from './lib/contract.ts';
import { outputDir, writeJson } from './lib/emit.ts';
import { indoorCells, summarizeCell, toIndoorFeature, type OsmFeature } from './lib/indoor.ts';

/**
 * OpenStreetMap indoor maps near the networks' stations. Reads `osmium export -f geojsonseq` files
 * (one per country extract, given as arguments) and each city's published `stops.json`.
 */
const CONFIG = {
    CITIES: ['prague', 'brno', 'presov', 'duk'],
    /** Where the published city folders are; the data branch checkout in CI. */
    STOPS_DIR: process.env.STOPS_DIR || path.join(import.meta.dirname, '..'),
    CELL_DEG: INDOOR_CELL_DEG,
    STATION_REACH_CELLS: 1,
    MIN_CELL_FEATURES: 15,
    MIN_CELL_LEVELS: 2,
    MIN_LEVEL_FEATURES: 2,
    MAX_LEVEL_SPAN: 10,
    /** Abort threshold guarding against an empty or truncated extract. */
    MIN_CELLS: 10,
} as const;

const LICENSE_TEXT = `# Indoor map data

Derived from OpenStreetMap, © OpenStreetMap contributors, https://www.openstreetmap.org/copyright

This folder is made available under the Open Database License (ODbL) 1.0:
https://opendatacommons.org/licenses/odbl/1-0/

Filtered to indoor features (floors, platforms, stairs, escalators, lifts, entrances, shops) near
departs.app stations, re-tagged into a compact schema and split into grid cells.
`;

function stationPositions(): IndoorPosition[] {
    const positions: IndoorPosition[] = [];
    for (const city of CONFIG.CITIES) {
        const file = path.join(CONFIG.STOPS_DIR, city, STOPS_FILE);
        if (!fs.existsSync(file)) {
            console.warn(`[Indoor] ${file} not found; ${city} gets no indoor maps.`);
            continue;
        }
        const stops = JSON.parse(fs.readFileSync(file, 'utf8')) as StopsFile;
        for (const station of stops.stations) positions.push(station.pos);
        console.log(`[Indoor] ${city}: ${stops.stations.length} stations`);
    }
    if (positions.length === 0) throw new Error('No stations to place indoor maps around.');
    return positions;
}

async function readFeatures(files: readonly string[]): Promise<IndoorFeature[]> {
    const features: IndoorFeature[] = [];
    const seen = new Set<string>();
    for (const file of files) {
        let read = 0;
        const lines = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
        for await (const line of lines) {
            const text = line.replace(/^\x1e/, '').trim();
            if (!text) continue;
            read++;
            const osm = JSON.parse(text) as OsmFeature;
            const key = `${osm.properties['@type'] ?? ''}${osm.properties['@id'] ?? ''}`;
            if (key && seen.has(key)) continue;
            if (key) seen.add(key);
            const feature = toIndoorFeature(osm, CONFIG.MAX_LEVEL_SPAN);
            if (feature) features.push(feature);
        }
        console.log(`[Indoor] ${file}: ${read} objects`);
    }
    return features;
}

async function main(): Promise<void> {
    const sources = process.argv.slice(2);
    if (sources.length === 0) throw new Error('Usage: build-indoor.ts <export.geojsonseq>...');

    const stations = stationPositions();
    const features = await readFeatures(sources);
    const cells = indoorCells(features, stations, {
        cell: CONFIG.CELL_DEG,
        stationReach: CONFIG.STATION_REACH_CELLS,
        minFeatures: CONFIG.MIN_CELL_FEATURES,
        minLevelFeatures: CONFIG.MIN_LEVEL_FEATURES,
        minLevels: CONFIG.MIN_CELL_LEVELS,
    });
    if (cells.size < CONFIG.MIN_CELLS) throw new Error(`Suspiciously few indoor cells (${cells.size}). Aborting.`);

    const dir = outputDir(INDOOR_DIR);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });

    const index: IndoorIndexFile = { version: 1, cell: CONFIG.CELL_DEG, cells: {} };
    let bytes = 0;
    for (const [id, cellFeatures] of [...cells].sort(([a], [b]) => a.localeCompare(b))) {
        index.cells[id] = summarizeCell(cellFeatures, CONFIG.MIN_LEVEL_FEATURES);
        bytes += writeJson(dir, `${id}.json`, { type: 'FeatureCollection', features: cellFeatures });
    }
    writeJson(dir, INDOOR_INDEX_FILE, index);
    fs.writeFileSync(path.join(dir, 'LICENSE.md'), LICENSE_TEXT);

    const kept = [...cells.values()].reduce((sum, list) => sum + list.length, 0);
    console.log(`[Indoor] Wrote ${cells.size} cells, ${kept} of ${features.length} features, ${(bytes / 1024).toFixed(0)} kB.`);
}

main().catch((err: unknown) => {
    console.error('[Indoor] FAILED:', err);
    process.exit(1);
});
