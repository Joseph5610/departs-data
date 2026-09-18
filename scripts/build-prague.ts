import fs from 'node:fs';
import path from 'node:path';
import { outputDir } from './lib/emit.ts';

/**
 * Prague (PID) stop enrichment.
 *
 * Golemio serves excellent realtime data but no structural metadata, so this shrinks the PID open
 * data stop list into an O(1) lookup keyed by GTFS id, which the edge workers cache aggressively.
 */
const CONFIG = {
    CITY: 'prague',
    SOURCE_URL: 'https://data.pid.cz/stops/json/stops.json',
    OUTPUT_FILE: 'stops-enrichment.json',
    /** Abort threshold guarding against an empty or truncated upstream feed. */
    MIN_ENTRIES: 1000,
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

    const enrichmentMap: Record<string, unknown> = {};
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
}

main().catch((err: unknown) => {
    console.error('[SYNC] FAILED:', err);
    process.exit(1);
});
