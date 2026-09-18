const DAY_MS = 86_400_000;

/** Pinned by `BUILD_NOW` so a build can be reproduced and diffed; otherwise the wall clock. */
export const NOW = process.env.BUILD_NOW ? Number(process.env.BUILD_NOW) : Date.now();

/** UTC offset of `timezone` at `atMs`, in milliseconds. */
export function zoneOffsetMs(timezone: string, atMs: number): number {
    const name = new Intl.DateTimeFormat('en-US', { timeZone: timezone, timeZoneName: 'longOffset' })
        .formatToParts(new Date(atMs))
        .find(p => p.type === 'timeZoneName')?.value ?? '';
    const m = /GMT([+-])(\d{2}):(\d{2})/.exec(name);
    return m ? (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 3_600_000 + Number(m[3]) * 60_000) : 0;
}

export interface ServiceDay {
    /** YYYYMMDD in the feed timezone. */
    str: string;
    /** Local midnight as epoch ms. */
    midnight: number;
    /** 0 = Sunday. */
    weekday: number;
    isHoliday: boolean;
}

/** Gregorian Easter Sunday as a UTC date. */
export function easterSunday(year: number): number {
    const a = year % 19;
    const b = Math.floor(year / 100);
    const c = year % 100;
    const d = Math.floor(b / 4);
    const e = b % 4;
    const f = Math.floor((b + 8) / 25);
    const g = Math.floor((b - f + 1) / 3);
    const h = (19 * a + b - d - g + 15) % 30;
    const i = Math.floor(c / 4);
    const k = c % 4;
    const l = (32 + 2 * e + 2 * i - h - k) % 7;
    const m = Math.floor((a + 11 * h + 22 * l) / 451);
    const month = Math.floor((h + l - 7 * m + 114) / 31);
    const day = ((h + l - 7 * m + 114) % 31) + 1;
    return Date.UTC(year, month - 1, day);
}

/** Czech public holidays of `year` as `YYYYMMDD`. */
export function czechHolidays(year: number): Set<string> {
    const fixed = ['0101', '0501', '0508', '0705', '0706', '0928', '1028', '1117', '1224', '1225', '1226'];
    const easter = easterSunday(year);
    const toStr = (ms: number) => new Date(ms).toISOString().slice(0, 10).replace(/-/g, '');
    return new Set([...fixed.map(md => `${year}${md}`), toStr(easter - 2 * DAY_MS), toStr(easter + DAY_MS)]);
}

/**
 * Service days at `dayOffsets` around now, in the feed timezone.
 *
 * Local midnight is resolved from the zone's offset at local noon, because schedule times are
 * measured from "noon minus 12h" — a fixed offset would be an hour out for half the year.
 */
export function getServiceDays(
    timezone: string,
    dayOffsets: readonly number[],
    holidaysFor?: (year: number) => Set<string>,
): ServiceDay[] {
    const days: ServiceDay[] = [];
    for (const offsetDays of dayOffsets) {
        const local = new Date(NOW + zoneOffsetMs(timezone, NOW) + offsetDays * DAY_MS);
        const y = local.getUTCFullYear();
        const m = String(local.getUTCMonth() + 1).padStart(2, '0');
        const d = String(local.getUTCDate()).padStart(2, '0');
        const str = `${y}${m}${d}`;
        const utcMidnight = Date.UTC(y, local.getUTCMonth(), local.getUTCDate());
        const midnight = utcMidnight - zoneOffsetMs(timezone, utcMidnight + 12 * 3_600_000);
        days.push({
            str,
            midnight,
            weekday: new Date(utcMidnight).getUTCDay(),
            isHoliday: holidaysFor ? holidaysFor(y).has(str) : false,
        });
    }
    return days;
}

/**
 * `H:MM:SS` or `HH:MM:SS` to minutes past midnight, keeping hours past 24.
 * Splits on `:` rather than reading fixed offsets, because feeds are inconsistent about padding.
 */
export function timeToMinutes(time: string): number {
    const [h = '0', m = '0'] = time.split(':');
    return parseInt(h, 10) * 60 + parseInt(m, 10);
}

/** Minutes past midnight to `HH:MM:SS`. */
export function formatTime(mins: number): string {
    return `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}:00`;
}

/** Milliseconds from the service day's reference midnight; hours past 24 stay past 24, as GTFS intends. */
export function timeToOffsetMs(time: string): number {
    const [h = '0', m = '0', s = '0'] = time.split(':');
    return Number(h) * 3_600_000 + Number(m) * 60_000 + Number(s) * 1000;
}
