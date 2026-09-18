import fs from 'node:fs';
import path from 'node:path';
import { outputDir } from './lib/emit.ts';

/** Prague (PID) points of sale: ticket offices and vendors, with their services decoded. */
const CONFIG = {
    CITY: 'prague',
    POS_URL: 'https://data.pid.cz/pointsOfSale/json/pointsOfSale.json',
    OUTPUT_FILE: 'points-of-sale.json',
    /** Abort threshold guarding against an empty or truncated upstream feed. */
    MIN_ENTRIES: 50,
    /** PID payment-method bitmask. */
    PAY_METHODS: [[1, 'cash'], [2, 'card'], [4, 'contactless']] as const,
    /** PID service bitmask; the two high bits are legacy duplicates of earlier flags. */
    SERVICES: [
        [1, 'card_application'], [2, 'card_issuance'], [4, 'coupons'], [8, 'paper_tickets'],
        [16, 'penalties'], [32, 'information'], [64, 'tkt_prep'],
        [65536, 'paper_tickets'], [131072, 'coupons'],
    ] as const,
} as const;

interface RawPos {
    id: string; type: string; name: string; address?: string;
    lat: number; lon: number; openingHours?: unknown[]; services?: number; payMethods?: number;
}

const decode = (mask: number, flags: readonly (readonly [number, string])[]): string[] =>
    [...new Set(flags.filter(([bit]) => mask & bit).map(([, name]) => name))];

/** PID ships the address as quoted text with raw anchor tags; keep the link text and its target. */
function cleanAddress(raw: string): string {
    let address = raw;
    if (address.startsWith('"') && address.endsWith('"')) address = address.slice(1, -1);
    address = address.replace(/<a\s+[^>]*href=["']?([^"'>]+)["']?[^>]*>(.*?)<\/a>/gi, '$2 ($1)');
    return address.replace(/<[^>]+>/g, '').trim();
}

/** PID's portal rejects default agents, so the originals sent a browser UA; keep it. */
const FETCH_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36',
};

async function main(): Promise<void> {
    const dataDir = outputDir(CONFIG.CITY);
    console.log(`[POS] Fetching Points of Sale from ${CONFIG.POS_URL}...`);

    const res = await fetch(CONFIG.POS_URL, { headers: FETCH_HEADERS });
    if (!res.ok) throw new Error(`Failed POS fetch: ${res.status}`);

    const rawPosList = await res.json() as RawPos[];
    console.log(`[POS] Received ${rawPosList.length} points of sale.`);
    if (!Array.isArray(rawPosList) || rawPosList.length < CONFIG.MIN_ENTRIES) {
        throw new Error(`Suspiciously low count (${rawPosList?.length}). Aborting.`);
    }

    const processedList = rawPosList.map(pos => ({
        id: pos.id,
        type: pos.type,
        name: pos.name,
        address: cleanAddress(pos.address || ''),
        lat: pos.lat,
        lon: pos.lon,
        openingHours: pos.openingHours || [],
        services: decode(pos.services || 0, CONFIG.SERVICES),
        payMethods: decode(pos.payMethods || 0, CONFIG.PAY_METHODS),
    }));

    fs.mkdirSync(dataDir, { recursive: true });
    const outputFile = path.join(dataDir, CONFIG.OUTPUT_FILE);
    fs.writeFileSync(outputFile, JSON.stringify(processedList, null, 2));
    console.log(`[POS] SUCCESS: Saved ${processedList.length} items to ${outputFile}`);
}

main().catch((err: unknown) => {
    console.error('[POS] FAILED:', err);
    process.exit(1);
});
