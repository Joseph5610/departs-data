import fs from 'node:fs';
import path from 'node:path';
import { STOP_DETAILS_BLOCK, STOP_DETAILS_DIR, STOP_SEARCH_BIN_FILE, STOP_SEARCH_TEXT_FILE, SITEMAP_STOPS_FILE, type MapStopCollection, type StopDetail } from './contract.ts';
import { writeChunks } from './emit.ts';

/** Must match `foldName` in departs-app `functions/_feeds/stop-search.ts`: the Worker folds queries the same way. */
const foldName = (value: string): string => value.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

/** Tabs and newlines delimit the text file's fields and lines, so none may appear inside one. */
const field = (value: unknown): string => String(value ?? '').replace(/[\t\n\r]/g, ' ');

/**
 * Writes the stop search index the Worker's MCP tools read instead of parsing `map-stops.json`.
 *
 * `stop_search.txt`: one line per stop, `folded name\tlowercased id`, empty for centroids.
 * `stop_search.bin`, little-endian: `N`, the UTF-16 offset of every line in the text (N + 1), then
 * Float32 longitudes, Float32 latitudes and one flag byte per stop (bit 0: centroid).
 * `stop_details/<index / STOP_DETAILS_BLOCK>.json`: `[stop_id, stop_name, platform_code, location_type,
 * lon, lat, lines]` per stop, read only for the stops a tool answers with.
 */
export function writeStopSearch(dir: string, mapStops: MapStopCollection): void {
    const features = mapStops.features;
    const count = features.length;

    const lines = features.map(({ properties: p }) =>
        p.is_centroid ? '' : `${field(foldName(p.stop_name ?? ''))}\t${field(String(p.stop_id ?? '').toLowerCase())}`);
    const offsets = new Uint32Array(count + 1);
    for (let i = 0; i < count; i++) offsets[i + 1] = offsets[i]! + lines[i]!.length + 1;

    const lon = new Float32Array(count);
    const lat = new Float32Array(count);
    const flags = new Uint8Array(count);
    const blocks = new Map<string, StopDetail[]>();
    features.forEach(({ properties: p, geometry }, i) => {
        lon[i] = geometry.coordinates[0];
        lat[i] = geometry.coordinates[1];
        flags[i] = p.is_centroid ? 1 : 0;
        const blockId = String(Math.floor(i / STOP_DETAILS_BLOCK));
        let block = blocks.get(blockId);
        if (!block) { block = []; blocks.set(blockId, block); }
        block.push([p.stop_id, p.stop_name, p.platform_code ?? null, p.location_type, geometry.coordinates[0], geometry.coordinates[1], p.lines ?? []]);
    });

    fs.writeFileSync(path.join(dir, STOP_SEARCH_TEXT_FILE), `${lines.join('\n')}\n`);
    fs.writeFileSync(path.join(dir, STOP_SEARCH_BIN_FILE), Buffer.concat([
        Buffer.from(new Uint32Array([count]).buffer),
        Buffer.from(offsets.buffer),
        Buffer.from(lon.buffer),
        Buffer.from(lat.buffer),
        Buffer.from(flags.buffer),
    ]));
    writeChunks(path.join(dir, STOP_DETAILS_DIR), blocks);
    writeSitemapStops(dir, mapStops);
}

/**
 * `sitemap_stops.txt`: one URL-encoded stop id per line, one per station, for the Worker's sitemap to
 * wrap in `<url>` elements without reading the stop list. A centroid links its bare id when a stop
 * carries it, else its first platform (synthetic centroids, e.g. Prešov).
 */
function writeSitemapStops(dir: string, mapStops: MapStopCollection): void {
    const knownIds = new Set(mapStops.features.map(f => f.properties.stop_id).filter(Boolean));
    const ids = new Set<string>();
    for (const { properties: p } of mapStops.features) {
        if (!p.stop_id || !p.is_centroid) continue;
        const bareId = p.stop_id.replace('centroid-', '');
        const cleanId = knownIds.has(bareId) ? bareId : p.all_ids?.[0];
        if (cleanId) ids.add(encodeURIComponent(cleanId));
    }
    fs.writeFileSync(path.join(dir, SITEMAP_STOPS_FILE), [...ids].join('\n'));
}
