import type { TripStop, TripTracksFile, TripWindow } from './contract.ts';
import { HOURS_PER_DAY, TRACK_COORD_SCALE, TRACK_HOUR_PADDING_MINS } from './contract.ts';

/** Deltas keep the numbers short, which is most of why a track file parses in about a millisecond. */
const toDeltas = (values: number[]): number[] => values.map((value, i) => (i === 0 ? value : value - values[i - 1]!));

const toSecs = (time: string): number => {
    const [h, m, s] = time.split(':').map(Number);
    return (h || 0) * 3600 + (m || 0) * 60 + (s || 0);
};

/**
 * Where each trip should be at any minute, split into one file per hour of the operating day.
 *
 * Matching a vehicle to its trip needs the timetable positions of the trips running right now. Read
 * from the per-trip chunks that is one subrequest per candidate trip, which on a fresh isolate runs
 * past the Workers subrequest limit; an hour of trips is a single file of a few hundred kilobytes.
 *
 * A trip is written to every hour it overlaps, and hours past midnight fold onto the same clock
 * hour (25:10 lands in `01`), so a reader only ever needs the hour it is asking about.
 */
export function buildTripTracks(
    tripStops: Map<string, TripStop[]>,
    tripWindows: Record<string, TripWindow>
): Map<string, TripTracksFile> {
    const byHour = new Map<string, TripTracksFile>();
    const stopIndexes = new Map<string, Map<string, number>>();

    for (const [tripId, window] of Object.entries(tripWindows)) {
        const located = (tripStops.get(tripId) ?? []).filter((stop) => stop.lat !== undefined && stop.lon !== undefined);
        if (located.length === 0) continue;

        const last = located[located.length - 1]!;
        const [startMins, endMins] = window;

        const fromHour = Math.floor(Math.max(0, startMins - TRACK_HOUR_PADDING_MINS) / 60);
        const toHour = Math.floor((endMins + TRACK_HOUR_PADDING_MINS) / 60);
        for (let hour = fromHour; hour <= toHour; hour++) {
            const key = String(hour % HOURS_PER_DAY).padStart(2, '0');
            let file = byHour.get(key);
            let index = stopIndexes.get(key);
            if (!file || !index) {
                file = { stops: [], trips: {} };
                index = new Map();
                byHour.set(key, file);
                stopIndexes.set(key, index);
            }

            file.trips[tripId] = [
                toSecs(last.arrival_time || last.departure_time),
                located.map((stop) => intern(stop.stop_id, file!.stops, index!)),
                toDeltas(located.map((stop) => toSecs(stop.departure_time || stop.arrival_time))),
                toDeltas(located.map((stop) => Math.round(stop.lat! * TRACK_COORD_SCALE))),
                toDeltas(located.map((stop) => Math.round(stop.lon! * TRACK_COORD_SCALE))),
            ];
        }
    }

    return byHour;
}

function intern(stopId: string, stops: string[], index: Map<string, number>): number {
    const known = index.get(stopId);
    if (known !== undefined) return known;
    const position = stops.push(stopId) - 1;
    index.set(stopId, position);
    return position;
}
