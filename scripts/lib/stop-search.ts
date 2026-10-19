import fs from 'node:fs';
import path from 'node:path';
import { STOP_DETAILS_BLOCK, STOP_DETAILS_DIR, STOP_SEARCH_BIN_FILE, STOP_SEARCH_TEXT_FILE, SITEMAP_STOPS_FILE, type Platform, type Position, type StopDetail, type StopsFile } from './contract.ts';
import { linesOf, writeChunks } from './emit.ts';
import type { RouteLookup } from './stops-file.ts';

/** Must match `foldName` in departs-app `functions/_feeds/stopSearch.ts`: the Worker folds queries the same way. */
const foldName = (value: string): string => value.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

/** Tabs and newlines delimit the text file's fields and lines, so none may appear inside one. */
const field = (value: unknown): string => String(value ?? '').replace(/[\t\n\r]/g, ' ');

/** A platform's ids, comma-joined as the departures API takes them: its own first, then its aliases. */
const platformIds = (p: Platform): string => (p.aliases ? [p.id, ...p.aliases] : [p.id]).join(',');

interface SearchRow {
    /** Empty for stations, which only the nearest-stop search finds. */
    line: string;
    station: boolean;
    pos: Position;
    detail: StopDetail;
}

export interface StopSearchOptions {
    /** A station's search id is its platforms' ids, comma-joined, for a departures API that knows no stations (Golemio). */
    stationsByPlatforms?: boolean;
}

/**
 * Writes the stop search index the Worker's MCP tools read instead of parsing `stops.json`, and the sitemap's stop list.
 *
 * `stop_search.txt`: one line per stop, `folded name\tlowercased id`, empty for stations.
 * `stop_search.bin`, little-endian: `N`, the UTF-16 offset of every line in the text (N + 1), then
 * Float32 longitudes, Float32 latitudes and one flag byte per stop (bit 0: station).
 * `stop_details/<index / STOP_DETAILS_BLOCK>.json`: `[stop_id, stop_name, platform_code, location_type,
 * lon, lat, lines]` per stop, a platform's followed by its station's index, read only for the stops a tool answers with.
 */
export function writeStopSearch(dir: string, file: StopsFile, routes: RouteLookup, { stationsByPlatforms = false }: StopSearchOptions = {}): void {
    const platformsOf = new Map<string, Platform[]>();
    for (const p of file.platforms) {
        let list = platformsOf.get(p.station);
        if (!list) { list = []; platformsOf.set(p.station, list); }
        list.push(p);
    }
    const nameOf = new Map(file.stations.map(s => [s.id, s.name]));

    const rows: SearchRow[] = [];
    const stationIndex = new Map(file.stations.map((s, i) => [s.id, i]));
    for (const s of file.stations) {
        const platforms = platformsOf.get(s.id) ?? [];
        const id = stationsByPlatforms ? platforms.map(platformIds).join(',') : s.id;
        const lines = linesOf(platforms.flatMap(p => p.routes), routes);
        rows.push({ line: '', station: true, pos: s.pos, detail: [id, s.name, null, 1, s.pos[0], s.pos[1], lines] });
    }
    for (const p of file.platforms) {
        const id = platformIds(p);
        const name = nameOf.get(p.station) ?? '';
        const lines = linesOf(p.routes, routes);
        const station = stationIndex.get(p.station)!;
        rows.push({ line: `${field(foldName(name))}\t${field(id.toLowerCase())}`, station: false, pos: p.pos, detail: [id, name, p.code ?? null, 0, p.pos[0], p.pos[1], lines, station] });
    }

    const count = rows.length;
    const offsets = new Uint32Array(count + 1);
    const lon = new Float32Array(count);
    const lat = new Float32Array(count);
    const flags = new Uint8Array(count);
    const blocks = new Map<string, StopDetail[]>();
    rows.forEach((row, i) => {
        offsets[i + 1] = offsets[i]! + row.line.length + 1;
        lon[i] = row.pos[0];
        lat[i] = row.pos[1];
        flags[i] = row.station ? 1 : 0;
        const blockId = String(Math.floor(i / STOP_DETAILS_BLOCK));
        let block = blocks.get(blockId);
        if (!block) { block = []; blocks.set(blockId, block); }
        block.push(row.detail);
    });

    fs.writeFileSync(path.join(dir, STOP_SEARCH_TEXT_FILE), `${rows.map(r => r.line).join('\n')}\n`);
    fs.writeFileSync(path.join(dir, STOP_SEARCH_BIN_FILE), Buffer.concat([
        Buffer.from(new Uint32Array([count]).buffer),
        Buffer.from(offsets.buffer),
        Buffer.from(lon.buffer),
        Buffer.from(lat.buffer),
        Buffer.from(flags.buffer),
    ]));
    writeChunks(path.join(dir, STOP_DETAILS_DIR), blocks);
    // The app resolves a station's own id in every city, so the sitemap links each station by it.
    fs.writeFileSync(path.join(dir, SITEMAP_STOPS_FILE), file.stations.map(s => encodeURIComponent(s.id)).join('\n'));
}
