import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SOURCE_URL = "https://data.pid.cz/stops/json/stops.json";
const OUTPUT_DIR = path.join(__dirname, '..', 'prague');
const OUTPUT_FILE = path.join(OUTPUT_DIR, "stops-enrichment.json");

async function syncStops() {
    console.log(`[SYNC] Fetching PID stops from ${SOURCE_URL}...`);

    try {
        const res = await fetch(SOURCE_URL, {
            headers: {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36"
            }
        });

        if (!res.ok) {
            throw new Error(`Failed to fetch: ${res.status} ${res.statusText}`);
        }

        const data = await res.json();
        console.log(`[SYNC] Received ${data.stopGroups?.length || 0} stop groups.`);

        const enrichmentMap = {};

        data.stopGroups?.forEach(g => {
            g.stops?.forEach(s => {
                s.gtfsIds?.forEach(id => {
                    const lines = s.lines?.map(l => {
                        return { n: l.name, t: l.type, e: l.exitOnly ? 1 : 0 };
                    }) || [];

                    enrichmentMap[id] = {
                        l: lines,
                        n: g.fullName || g.name,
                        mtt: s.mainTrafficType || g.mainTrafficType,
                        alat: g.avgLat,
                        alon: g.avgLon
                    };
                });
            });
        });

        const count = Object.keys(enrichmentMap).length;
        console.log(`[SYNC] Processed ${count} GTFS IDs.`);

        if (count < 1000) {
            throw new Error(`Suspiciously low number of entries (${count}). Aborting save to protect existing data.`);
        }

        if (!fs.existsSync(OUTPUT_DIR)) {
            fs.mkdirSync(OUTPUT_DIR, { recursive: true });
        }

        fs.writeFileSync(OUTPUT_FILE, JSON.stringify(enrichmentMap));
        console.log(`[SYNC] SUCCESS: Saved enrichment data to ${OUTPUT_FILE}`);

    } catch (error) {
        console.error("[SYNC] FAILED:", error);
        process.exit(1);
    }
}

syncStops();
