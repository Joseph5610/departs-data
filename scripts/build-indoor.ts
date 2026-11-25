import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { INDOOR_DIR, INDOOR_INDEX_FILE, PLATFORMS_DIR, PLATFORMS_INDEX_FILE, ROUTES_FILE, STOPS_FILE, type IndoorFeature, type IndoorIndexFile, type PlatformsIndexFile, type RouteInfo, type StopsFile } from './lib/contract.ts';
import { outputDir, writeJson } from './lib/emit.ts';
import { groupStations, isStreetPlatform, planBbox, planLevels, stationPlans, toIndoorFeature, type IndoorStation, type OsmFeature } from './lib/indoor.ts';

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
    /** An object belongs to the nearest station (or, for a street-level platform, the city with a stop) within this distance; below `GRID_DEG` in lib/indoor.ts. */
    STATION_RADIUS_M: 300,
    /** Hex digits of the station file hash published as its version. */
    VERSION_LENGTH: 10,
    MAX_LEVEL_SPAN: 10,
    /** Abort threshold guarding against an empty or truncated extract. */
    MIN_STATIONS: 10,
} as const;

/** The `LICENSE.md` each published folder carries: ODbL requires the licence and the source to travel with the data. */
const licenseText = (title: string, contents: string): string => `# ${title}

Derived from OpenStreetMap, © OpenStreetMap contributors, https://www.openstreetmap.org/copyright

This folder is made available under the Open Database License (ODbL) 1.0:
https://opendatacommons.org/licenses/odbl/1-0/

${contents}
`;

const INDOOR_LICENSE = licenseText('Station floor plans', 'Objects on floors (rooms, corridors, platforms, stairs, escalators, lifts, entrances, shops) within 300 m of\ndeparts.app metro and rail stations, re-tagged into a compact schema and grouped by station.');
const PLATFORMS_LICENSE = licenseText('Street-level platforms', 'Platforms on street level (no level, or level 0) within 300 m of departs.app stops, re-tagged into a\ncompact schema and grouped by city.');

/** The node of a station id: PID's `U142-301` and `U142-1` are both node `U142`. */
const stationNode = (id: string): string => id.split('-')[0]!;

/** Every city's stops as one point set each, which street-level platforms are matched to. */
function cityStops(): IndoorStation[] {
    const cities: IndoorStation[] = [];
    for (const city of CONFIG.CITIES) {
        const stopsFile = path.join(CONFIG.STOPS_DIR, city, STOPS_FILE);
        if (!fs.existsSync(stopsFile)) continue;
        const stops = JSON.parse(fs.readFileSync(stopsFile, 'utf8')) as StopsFile;
        cities.push({ id: city, name: city, node: city, points: stops.platforms.map(platform => platform.pos) });
    }
    return cities;
}

const hashOf = (payload: string): string => createHash('sha1').update(payload).digest('hex').slice(0, CONFIG.VERSION_LENGTH);

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

    const stations = groupStations(railStations());
    const features = await readFeatures(sources);
    const plans = stationPlans(features.filter(feature => !isStreetPlatform(feature)), stations, CONFIG.STATION_RADIUS_M);
    const platforms = stationPlans(features.filter(isStreetPlatform), cityStops(), CONFIG.STATION_RADIUS_M);
    if (plans.size < CONFIG.MIN_STATIONS) throw new Error(`Suspiciously few station plans (${plans.size}). Aborting.`);

    const dir = outputDir(INDOOR_DIR);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });

    const names = new Map(stations.map(station => [station.id, station.name]));
    const index: IndoorIndexFile = { version: 4, stations: {} };
    let bytes = 0;
    for (const [id, plan] of [...plans].sort(([a], [b]) => a.localeCompare(b))) {
        const payload = JSON.stringify({ type: 'FeatureCollection', features: plan });
        fs.writeFileSync(path.join(dir, `${id}.json`), payload);
        bytes += payload.length;
        index.stations[id] = {
            name: names.get(id) ?? id,
            levels: planLevels(plan),
            bbox: planBbox(plan),
            v: hashOf(payload),
        };
    }
    writeJson(dir, INDOOR_INDEX_FILE, index);
    fs.writeFileSync(path.join(dir, 'LICENSE.md'), INDOOR_LICENSE);

    const kept = [...plans.values()].reduce((sum, plan) => sum + plan.length, 0);
    console.log(`[Indoor] Wrote ${plans.size} station plans, ${kept} of ${features.length} features, ${(bytes / 1024).toFixed(0)} kB.`);

    // Beside indoor/: out/indoor in CI gives out/platforms.
    const platformsDir = path.join(path.dirname(dir), PLATFORMS_DIR);
    fs.rmSync(platformsDir, { recursive: true, force: true });
    fs.mkdirSync(platformsDir, { recursive: true });
    const platformsIndex: PlatformsIndexFile = { version: 1, cities: {} };
    for (const [city, list] of platforms) {
        const payload = JSON.stringify({ type: 'FeatureCollection', features: list.map(({ type, geometry, properties: { k, lv, name, ref } }) => ({ type, geometry, properties: { k, lv, ...(name ? { name } : {}), ...(ref ? { ref } : {}) } })) });
        fs.writeFileSync(path.join(platformsDir, `${city}.json`), payload);
        platformsIndex.cities[city] = { v: hashOf(payload) };
        console.log(`[Platforms] ${city}: ${list.length} street-level platforms, ${(payload.length / 1024).toFixed(0)} kB.`);
    }
    writeJson(platformsDir, PLATFORMS_INDEX_FILE, platformsIndex);
    fs.writeFileSync(path.join(platformsDir, 'LICENSE.md'), PLATFORMS_LICENSE);
}

main().catch((err: unknown) => {
    console.error('[Indoor] FAILED:', err);
    process.exit(1);
});
