import type { ScheduleFile, TripWindowsFile } from './contract.ts';
import { HOURS_PER_DAY, SCHEDULE_MATCH_WINDOW } from './contract.ts';

/**
 * The trips a vehicle may be matched to, one file per clock hour: a fresh isolate parses the trips of
 * the hour it is serving instead of the whole day's timetable.
 */
export function buildScheduleFiles(windows: TripWindowsFile, tripRoutes: Record<string, string>): Map<string, ScheduleFile> {
    const byHour = new Map<string, ScheduleFile>();
    const routeIndexes = new Map<string, Map<string, number>>();

    for (const [tripId, window] of Object.entries(windows.trips)) {
        const [startMins, endMins] = window;
        const fromHour = Math.floor(Math.max(0, startMins - SCHEDULE_MATCH_WINDOW.BEFORE_MINS) / 60);
        const toHour = Math.floor((endMins + SCHEDULE_MATCH_WINDOW.AFTER_MINS) / 60);
        const routeId = tripRoutes[tripId];

        for (let hour = fromHour; hour <= toHour; hour++) {
            const key = String(hour % HOURS_PER_DAY).padStart(2, '0');
            let file = byHour.get(key);
            let routes = routeIndexes.get(key);
            if (!file || !routes) {
                file = { days: windows.days, routes: [], trips: {} };
                routes = new Map();
                byHour.set(key, file);
                routeIndexes.set(key, routes);
            }
            let routeIndex = -1;
            if (routeId !== undefined) {
                routeIndex = routes.get(routeId) ?? -1;
                if (routeIndex < 0) {
                    routeIndex = file.routes.push(routeId) - 1;
                    routes.set(routeId, routeIndex);
                }
            }
            file.trips[tripId] = window.length > 3
                ? [startMins, endMins, window[2], routeIndex, window[3]!]
                : [startMins, endMins, window[2], routeIndex];
        }
    }

    return byHour;
}
