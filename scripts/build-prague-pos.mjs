import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const POS_URL = "https://data.pid.cz/pointsOfSale/json/pointsOfSale.json";
const CONSTS_CS_URL = "https://data.pid.cz/pointsOfSale/json/consts-cs.json";
const OUTPUT_DIR = path.join(__dirname, '..', 'prague');
const OUTPUT_FILE = path.join(OUTPUT_DIR, "points-of-sale.json");

const FETCH_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36"
};

/**
 * Maps PID service bitmasks & payment method bitmasks into semantic keys.
 */
function decodePayMethods(mask) {
    const methods = [];
    if (mask & 1) methods.push('cash');
    if (mask & 2) methods.push('card');
    if (mask & 4) methods.push('contactless');
    return methods;
}

function decodeServices(mask) {
    const services = [];
    // Bit flags mapping based on PID schema
    if (mask & 1) services.push('card_application');
    if (mask & 2) services.push('card_issuance');
    if (mask & 4) services.push('coupons');
    if (mask & 8) services.push('paper_tickets');
    if (mask & 16) services.push('penalties');
    if (mask & 32) services.push('information');
    if (mask & 64) services.push('tkt_prep');
    if (mask & 65536) services.push('paper_tickets'); // legacy flag fallback
    if (mask & 131072) services.push('coupons');     // legacy flag fallback
    
    // Deduplicate
    return Array.from(new Set(services));
}

async function buildPointsOfSale() {
    console.log(`[POS] Fetching Points of Sale from ${POS_URL}...`);

    try {
        const [posRes, constsRes] = await Promise.all([
            fetch(POS_URL, { headers: FETCH_HEADERS }),
            fetch(CONSTS_CS_URL, { headers: FETCH_HEADERS })
        ]);

        if (!posRes.ok) throw new Error(`Failed POS fetch: ${posRes.status}`);
        if (!constsRes.ok) throw new Error(`Failed Consts fetch: ${constsRes.status}`);

        const rawPosList = await posRes.json();
        console.log(`[POS] Received ${rawPosList.length} points of sale.`);

        if (!Array.isArray(rawPosList) || rawPosList.length < 50) {
            throw new Error(`Suspiciously low count (${rawPosList?.length}). Aborting.`);
        }

        const processedList = rawPosList.map(pos => {
            let address = pos.address || '';
            // Strip escaped quotes wrapping the text
            if (address.startsWith('"') && address.endsWith('"')) {
                address = address.slice(1, -1);
            }
            // Sanitize raw HTML tags from PID source (e.g. convert <a href="...">text</a> to text or URL)
            address = address.replace(/<a\s+[^>]*href=["']?([^"'>]+)["']?[^>]*>(.*?)<\/a>/gi, '$2 ($1)');
            address = address.replace(/<[^>]+>/g, '');

            return {
                id: pos.id,
                type: pos.type,
                name: pos.name,
                address: address.trim(),
                lat: pos.lat,
                lon: pos.lon,
                openingHours: pos.openingHours || [],
                services: decodeServices(pos.services || 0),
                payMethods: decodePayMethods(pos.payMethods || 0)
            };
        });

        if (!fs.existsSync(OUTPUT_DIR)) {
            fs.mkdirSync(OUTPUT_DIR, { recursive: true });
        }

        fs.writeFileSync(OUTPUT_FILE, JSON.stringify(processedList, null, 2));
        console.log(`[POS] SUCCESS: Saved ${processedList.length} items to ${OUTPUT_FILE}`);

    } catch (err) {
        console.error("[POS] FAILED:", err);
        process.exit(1);
    }
}

buildPointsOfSale();
