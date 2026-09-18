import fs from 'node:fs';
import path from 'node:path';
import { outputDir, writeJson } from './lib/emit.ts';
import { MAP_STOPS_FILE } from './lib/contract.ts';
import { buildPragueMapStops, type GolemioStopFeature, type PidEnrichment } from './lib/pid-stops.ts';

/**
 * Prague (PID) stops.
 *
 * Writes `stops-enrichment.json`, an O(1) lookup of PID lines and names keyed by GTFS id that the
 * Worker still reads for departures and vehicle detail, and `map-stops.json`, the final map stop
 * list built from Golemio's GTFS stops and that enrichment.
 */
const CONFIG = {
    CITY: 'prague',
    SOURCE_URL: 'https://data.pid.cz/stops/json/stops.json',
    OUTPUT_FILE: 'stops-enrichment.json',
    /** Abort threshold guarding against an empty or truncated upstream feed. */
    MIN_ENTRIES: 1000,
    GOLEMIO_STOPS_URL: 'https://api.golemio.cz/v2/gtfs/stops',
    GOLEMIO_PAGE_SIZE: 10000,
    /** Pages are requested up to this offset; mirrors departs-app `GOLEMIO_CONFIG.STOPS_MAX_OFFSET`. */
    GOLEMIO_MAX_OFFSET: 40000,
    /** Abort threshold for Golemio's stop list, which currently holds about 25,000 stops. */
    MIN_GOLEMIO_STOPS: 10000,
} as const;

interface PidLine { name: string; type: string; exitOnly?: boolean }
interface PidStop { gtfsIds?: string[]; lines?: PidLine[]; mainTrafficType?: string }
interface PidGroup { stops?: PidStop[]; fullName?: string; name?: string; mainTrafficType?: string; avgLat?: number; avgLon?: number }

/** PID's portal rejects default agents, so the originals sent a browser UA; keep it. */
const FETCH_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36',
};

async function main(): Promise<void> {
    const dataDir = outputDir(CONFIG.CITY);
    console.log(`[SYNC] Fetching PID stops from ${CONFIG.SOURCE_URL}...`);

    const res = await fetch(CONFIG.SOURCE_URL, { headers: FETCH_HEADERS });
    if (!res.ok) throw new Error(`Failed to fetch: ${res.status} ${res.statusText}`);

    const data = await res.json() as { stopGroups?: PidGroup[] };
    console.log(`[SYNC] Received ${data.stopGroups?.length ?? 0} stop groups.`);

    const enrichmentMap: Record<string, PidEnrichment & Record<string, unknown>> = {};
    for (const g of data.stopGroups ?? []) {
        for (const s of g.stops ?? []) {
            for (const id of s.gtfsIds ?? []) {
                enrichmentMap[id] = {
                    l: (s.lines ?? []).map(l => ({ n: l.name, t: l.type, e: l.exitOnly ? 1 : 0 })),
                    n: g.fullName || g.name,
                    mtt: s.mainTrafficType || g.mainTrafficType,
                    alat: g.avgLat,
                    alon: g.avgLon,
                };
            }
        }
    }

    const count = Object.keys(enrichmentMap).length;
    console.log(`[SYNC] Processed ${count} GTFS IDs.`);
    if (count < CONFIG.MIN_ENTRIES) {
        throw new Error(`Suspiciously low number of entries (${count}). Aborting save to protect existing data.`);
    }

    fs.mkdirSync(dataDir, { recursive: true });
    const outputFile = path.join(dataDir, CONFIG.OUTPUT_FILE);
    fs.writeFileSync(outputFile, JSON.stringify(enrichmentMap));
    console.log(`[SYNC] SUCCESS: Saved enrichment data to ${outputFile}`);

    const golemioStops = await fetchGolemioStops();
    const mapStops = buildPragueMapStops(golemioStops, enrichmentMap);
    writeJson(dataDir, MAP_STOPS_FILE, mapStops);
    console.log(`[SYNC] SUCCESS: Saved ${mapStops.features.length} map stops to ${path.join(dataDir, MAP_STOPS_FILE)}`);
}

/** Every page of Golemio's GTFS stop list, fetched in parallel. */
async function fetchGolemioStops(): Promise<GolemioStopFeature[]> {
    const apiKey = process.env.GOLEMIO_API_KEY;
    if (!apiKey) throw new Error('GOLEMIO_API_KEY is not set.');

    const offsets: number[] = [];
    for (let offset = 0; offset < CONFIG.GOLEMIO_MAX_OFFSET; offset += CONFIG.GOLEMIO_PAGE_SIZE) offsets.push(offset);

    console.log(`[SYNC] Fetching Golemio stops (${offsets.length} pages)...`);
    const pages = await Promise.all(offsets.map(async (offset) => {
        const url = `${CONFIG.GOLEMIO_STOPS_URL}?limit=${CONFIG.GOLEMIO_PAGE_SIZE}&offset=${offset}`;
        const res = await fetch(url, { headers: { 'X-Access-Token': apiKey, Accept: 'application/json' } });
        if (!res.ok) throw new Error(`Golemio stops page at offset ${offset} failed: ${res.status} ${res.statusText}`);
        const body = await res.json() as { features?: unknown };
        if (!Array.isArray(body.features)) throw new Error(`Golemio stops page at offset ${offset} has no features array.`);
        return (body.features as unknown[]).filter(isGolemioStop);
    }));

    const stops = pages.flat();
    console.log(`[SYNC] Received ${stops.length} Golemio stops.`);
    if (stops.length < CONFIG.MIN_GOLEMIO_STOPS) {
        throw new Error(`Suspiciously low number of Golemio stops (${stops.length}). Aborting save to protect existing data.`);
    }
    return stops;
}

function isGolemioStop(f: unknown): f is GolemioStopFeature {
    if (f === null || typeof f !== 'object' || !('properties' in f) || !('geometry' in f)) return false;
    const { properties, geometry } = f as { properties: unknown; geometry: unknown };
    return properties !== null && typeof properties === 'object' && typeof (properties as { stop_id?: unknown }).stop_id === 'string'
        && geometry !== null && typeof geometry === 'object' && Array.isArray((geometry as { coordinates?: unknown }).coordinates);
}

main().catch((err: unknown) => {
    console.error('[SYNC] FAILED:', err);
    process.exit(1);
});
