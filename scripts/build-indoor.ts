import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { INDOOR_DIR, INDOOR_INDEX_FILE, ROUTES_FILE, STOPS_FILE, type IndoorFeature, type IndoorIndexFile, type RouteInfo, type StopsFile } from './lib/contract.ts';
import { outputDir, writeJson } from './lib/emit.ts';
import { groupStations, planBbox, planStartLevel, stationPlans, toIndoorFeature, type IndoorStation, type IndoorStationOptions, type OsmFeature } from './lib/indoor.ts';

/**
 * OpenStreetMap indoor maps near the networks' stations. Reads `osmium export -f geojsonseq` files
 * (one per country extract, given as arguments) and each city's published `stops.json`.
 */
const CONFIG = {
    CITIES: ['prague', 'brno', 'presov', 'duk'],
    /** Where the published city folders are; the data branch checkout in CI. */
    STOPS_DIR: process.env.STOPS_DIR || path.join(import.meta.dirname, '..'),
    /** Stations served by these vehicle types get floor plans; bus and tram stops do not. */
    STATION_ROUTE_TYPES: new Set(['metro', 'train']),
    PLANS: {
        /** ~360 m east-west in Czechia and Slovakia, above both distances below. */
        cellDeg: 0.005,
        radiusM: 300,
        joinM: 150,
        coreM: 150,
        minLevelFeatures: 1,
    } satisfies IndoorStationOptions,
    /** Hex digits of the station file hash published as its version. */
    VERSION_LENGTH: 10,
    MAX_LEVEL_SPAN: 10,
    /** Abort threshold guarding against an empty or truncated extract. */
    MIN_STATIONS: 10,
} as const;

const LICENSE_TEXT = `# Indoor map data

Derived from OpenStreetMap, © OpenStreetMap contributors, https://www.openstreetmap.org/copyright

This folder is made available under the Open Database License (ODbL) 1.0:
https://opendatacommons.org/licenses/odbl/1-0/

Filtered to indoor features (floors, platforms, stairs, escalators, lifts, entrances, shops) near
departs.app stations, re-tagged into a compact schema and grouped by station.
`;

/** The node of a station id: PID's `U142-301` and `U142-1` are both node `U142`. */
const stationNode = (id: string): string => id.split('-')[0]!;

/** Metro and rail stations with the points (the station and its platforms) their floor plans gather around. */
function railStations(): IndoorStation[] {
    const stations: IndoorStation[] = [];
    for (const city of CONFIG.CITIES) {
        const stopsFile = path.join(CONFIG.STOPS_DIR, city, STOPS_FILE);
        const routesFile = path.join(CONFIG.STOPS_DIR, city, ROUTES_FILE);
        if (!fs.existsSync(stopsFile) || !fs.existsSync(routesFile)) {
            console.warn(`[Indoor] ${city} has no published ${STOPS_FILE} or ${ROUTES_FILE}; it gets no indoor maps.`);
            continue;
        }
        const stops = JSON.parse(fs.readFileSync(stopsFile, 'utf8')) as StopsFile;
        const routes = JSON.parse(fs.readFileSync(routesFile, 'utf8')) as Record<string, RouteInfo>;
        const byId = new Map<string, IndoorStation>();
        for (const station of stops.stations) byId.set(station.id, { id: station.id, name: station.name, node: `${city}:${stationNode(station.id)}`, points: [station.pos] });
        const served = new Set<string>();
        for (const platform of stops.platforms) {
            if (!platform.routes.some(id => CONFIG.STATION_ROUTE_TYPES.has(routes[id]?.type ?? ''))) continue;
            byId.get(platform.station)?.points.push(platform.pos);
            served.add(platform.station);
        }
        for (const id of served) stations.push(byId.get(id)!);
        console.log(`[Indoor] ${city}: ${served.size} metro and rail stations`);
    }
    if (stations.length === 0) throw new Error('No metro or rail stations to place indoor maps around.');
    return stations;
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

    const stations = groupStations(railStations(), CONFIG.PLANS);
    const features = await readFeatures(sources);
    const plans = stationPlans(features, stations, CONFIG.PLANS);
    if (plans.size < CONFIG.MIN_STATIONS) throw new Error(`Suspiciously few station plans (${plans.size}). Aborting.`);

    const dir = outputDir(INDOOR_DIR);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });

    const names = new Map(stations.map(station => [station.id, station.name]));
    const index: IndoorIndexFile = { version: 3, stations: {} };
    let bytes = 0;
    for (const [id, { features: plan, levels }] of [...plans].sort(([a], [b]) => a.localeCompare(b))) {
        const payload = JSON.stringify({ type: 'FeatureCollection', features: plan });
        fs.writeFileSync(path.join(dir, `${id}.json`), payload);
        bytes += payload.length;
        index.stations[id] = {
            name: names.get(id) ?? id,
            levels,
            start: planStartLevel(plan, levels),
            bbox: planBbox(plan),
            v: createHash('sha1').update(payload).digest('hex').slice(0, CONFIG.VERSION_LENGTH),
        };
    }
    writeJson(dir, INDOOR_INDEX_FILE, index);
    fs.writeFileSync(path.join(dir, 'LICENSE.md'), LICENSE_TEXT);

    const kept = [...plans.values()].reduce((sum, plan) => sum + plan.features.length, 0);
    console.log(`[Indoor] Wrote ${plans.size} station plans, ${kept} of ${features.length} features, ${(bytes / 1024).toFixed(0)} kB.`);
}

main().catch((err: unknown) => {
    console.error('[Indoor] FAILED:', err);
    process.exit(1);
});
