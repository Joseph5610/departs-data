import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import AdmZip from 'adm-zip';
import { parse } from 'csv-parse/sync';

export type CsvRow = Record<string, string>;

export function parseCSV(buffer: Buffer): CsvRow[] {
    return parse(buffer, { columns: true, skip_empty_lines: true, bom: true, trim: false }) as CsvRow[];
}

/** A row whose declared-required columns are known present, and whose optional ones may be absent. */
export type Row<R extends string, O extends string> = Record<R, string> & Partial<Record<O, string>>;

export interface TableSpec<R extends string, O extends string> {
    /** Columns this build genuinely depends on. Their absence aborts rather than yielding `undefined`. */
    required: readonly R[];
    optional?: readonly O[];
    /** The table itself may be absent, as several GTFS files are optional. */
    fileOptional?: boolean;
}

/**
 * Reads a GTFS table and checks its header once, so a feed that drops a column fails here with the
 * column named, instead of silently producing `undefined` keys hundreds of lines downstream.
 */
export function readTable<R extends string, O extends string = never>(zip: AdmZip, name: string, spec: TableSpec<R, O>): Row<R, O>[] {
    const entry = zip.getEntry(name);
    if (!entry) {
        if (spec.fileOptional) return [];
        throw new Error(`${name} missing from GTFS zip`);
    }
    const rows = parseCSV(entry.getData());
    const first = rows[0];
    if (first) {
        const missing = spec.required.filter(c => !(c in first));
        if (missing.length > 0) {
            throw new Error(`${name} is missing required column(s): ${missing.join(', ')}. Found: ${Object.keys(first).join(', ')}`);
        }
    }
    return rows as Row<R, O>[];
}

/** Fetches JSON, or reads it from `cacheEnv`'s path when that env var is set (used by the build harness). */
export async function fetchJson<T>(url: string, cacheEnv?: string): Promise<T> {
    const cached = cacheEnv ? process.env[cacheEnv] : undefined;
    if (cached) {
        console.log(`Using cached ${url} from ${cached}`);
        return JSON.parse(fs.readFileSync(cached, 'utf8')) as T;
    }
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`Fetch failed for ${url}: ${res.status}`);
    return await res.json() as T;
}

/** Downloads a zip into memory, or opens `cacheEnv`'s path when that env var is set. */
export async function fetchZip(url: string, cacheEnv?: string): Promise<AdmZip> {
    const cached = cacheEnv ? process.env[cacheEnv] : undefined;
    if (cached) {
        console.log(`Using cached zip at ${cached}`);
        return new AdmZip(cached);
    }
    const res = await fetch(url, { redirect: 'follow' });
    if (!res.ok) throw new Error(`Download failed for ${url}: ${res.status}`);
    return new AdmZip(Buffer.from(await res.arrayBuffer()));
}

export interface LargeZipOptions {
    /** Seconds before one attempt is abandoned and resumed. */
    timeoutS: number;
    attempts: number;
    /** `JDF_CACHE_DIR`-style directory keeping the file between local rebuilds. */
    cacheDir?: string | undefined;
    cacheMaxAgeMs: number;
}

/**
 * Downloads a zip too large to hold in memory, via curl so a timed-out attempt can resume.
 * Keeps it in `cacheDir` when given, otherwise deletes it once opened.
 */
export function downloadLargeZip(url: string, name: string, opts: LargeZipOptions): AdmZip {
    const { cacheDir } = opts;
    const target = cacheDir ? path.join(cacheDir, `${name}.zip`) : path.join(os.tmpdir(), `${name}-${process.pid}.zip`);
    const isFresh = cacheDir && fs.existsSync(target) && Date.now() - fs.statSync(target).mtimeMs < opts.cacheMaxAgeMs;
    if (!isFresh) {
        fs.rmSync(target, { force: true });
        for (let attempt = 1; ; attempt++) {
            try {
                // `-C -` resumes what a timed-out attempt got.
                execFileSync('curl', ['-sSf', '-C', '-', '--max-time', String(opts.timeoutS), '-o', target, url], { stdio: 'inherit' });
                break;
            } catch (err) {
                if (attempt >= opts.attempts) throw err;
                console.warn(`Download attempt ${attempt} failed, resuming...`);
            }
        }
    }
    const zip = new AdmZip(target);
    if (!cacheDir) fs.rmSync(target, { force: true });
    return zip;
}
