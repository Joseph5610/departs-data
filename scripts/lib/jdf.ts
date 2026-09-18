/**
 * JDF (CIS JŘ) parsing primitives: the national Czech timetable export format.
 * Rows are quoted, comma-separated fields terminated by `;`, encoded windows-1250.
 */
export const JDF_ENCODING = 'windows-1250';

const decoder = new TextDecoder(JDF_ENCODING);

export function decodeJdf(data: Buffer): string {
    return decoder.decode(data);
}

export function parseRows(text: string): string[][] {
    const rows: string[][] = [];
    for (const line of text.split(/\r?\n/)) {
        if (!line.trim()) continue;
        rows.push([...line.matchAll(/"([^"]*)"/g)].map(m => m[1]!));
    }
    return rows;
}

/** `DDMMYYYY` to `YYYYMMDD`; empty stays empty. */
export const jdfDate = (d: string | undefined): string =>
    (d && d.length === 8 ? `${d.slice(4)}${d.slice(2, 4)}${d.slice(0, 2)}` : '');

/** `HHMM` to minutes; null for an empty or marker field. */
export function jdfTime(value: string | undefined): number | null {
    if (!value || !/^\d{4}$/.test(value)) return null;
    return Number(value.slice(0, 2)) * 60 + Number(value.slice(2));
}

/** Field positions per JDF version; the export mixes 1.9, 1.10 and 1.11 timetables. */
export const LAYOUTS: Record<string, {
    linky: { mode: number | null; detour: number | null; validFrom: number; validTo: number; variant: number | null };
    zasspoje: { codes: number[]; arrival: number; departure: number };
    zaslinky: { codes: number[] };
}> = {
    '1.9': {
        linky: { mode: null, detour: null, validFrom: 8, validTo: 9, variant: null },
        zasspoje: { codes: [5, 6], arrival: 8, departure: 9 },
        zaslinky: { codes: [4, 5, 6] },
    },
    '1.10': {
        linky: { mode: 4, detour: 5, validFrom: 12, validTo: 13, variant: 14 },
        zasspoje: { codes: [6, 7], arrival: 9, departure: 10 },
        zaslinky: { codes: [5, 6, 7] },
    },
    '1.11': {
        linky: { mode: 4, detour: 5, validFrom: 13, validTo: 14, variant: 15 },
        zasspoje: { codes: [6, 7, 8], arrival: 10, departure: 11 },
        zaslinky: { codes: [5, 6, 7] },
    },
};

/** Spoje.txt: pevné kódy 1–10, identical in every version. */
export const TRIP_CODE_FIELDS = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11];

/** JDF časový kód types. */
export const CALENDAR = { RUNS: '1', ALSO_RUNS: '2', ONLY_RUNS: '3', DOES_NOT_RUN: '4' } as const;
/** JDF pevný kód symbols read here. */
export const SYMBOL = { WORKDAYS: 'X', SUNDAYS_AND_HOLIDAYS: '+', REQUEST_STOP: 'x', WHEELCHAIR: '@' } as const;
export const WEEKDAY_SYMBOLS = ['7', '1', '2', '3', '4', '5', '6'];
/** Zasspoje time markers: the trip passes the stop without stopping, or does not run via it. */
export const PASSES = '<';
export const NOT_VIA = '|';
