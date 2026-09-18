import type AdmZip from 'adm-zip';
import { readTable } from './feed.ts';
import type { ServiceDay } from './time.ts';

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'] as const;

const TABLES = {
    calendar: { required: ['service_id', 'start_date', 'end_date', ...WEEKDAYS], fileOptional: true },
    calendarDates: { required: ['service_id', 'date', 'exception_type'], fileOptional: true },
} as const;

/** The days among `days` on which each service runs, from `calendar.txt` and `calendar_dates.txt`. */
export function readServiceDates(zip: AdmZip, days: readonly ServiceDay[]): Map<string, Set<ServiceDay>> {
    const dayByStr = new Map(days.map(d => [d.str, d]));
    const serviceDates = new Map<string, Set<ServiceDay>>();
    const add = (serviceId: string, day: ServiceDay) => {
        let set = serviceDates.get(serviceId);
        if (!set) { set = new Set(); serviceDates.set(serviceId, set); }
        set.add(day);
    };

    for (const cal of readTable(zip, 'calendar.txt', TABLES.calendar)) {
        for (const day of days) {
            if (day.str < cal.start_date || day.str > cal.end_date) continue;
            if (cal[WEEKDAYS[day.weekday]!] === '1') add(cal.service_id, day);
        }
    }
    for (const ex of readTable(zip, 'calendar_dates.txt', TABLES.calendarDates)) {
        const day = dayByStr.get(ex.date);
        if (!day) continue;
        if (ex.exception_type === '1') add(ex.service_id, day);
        else if (ex.exception_type === '2') serviceDates.get(ex.service_id)?.delete(day);
    }
    return serviceDates;
}
