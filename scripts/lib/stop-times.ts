import type { StopTimeSliceFile, TripStop, TripWindowsFile } from './contract.ts';
import { HOURS_PER_DAY, STOP_TIMES_WINDOW } from './contract.ts';
import { timeToMinutes } from './time.ts';

const COORD_DECIMALS = 5;

/**
 * `stop_times/<HH>.json` files: every trip running on one of the published service days, written to each hour
 * from `EARLY_MINS` before its start until `LATE_MINS` after its end, with its calls and stop positions.
 */
export function buildStopTimeSlices(tripStops: Map<string, TripStop[]>, windows: TripWindowsFile): Map<string, StopTimeSliceFile> {
    const slices = new Map<string, { file: StopTimeSliceFile; stopIndex: Map<string, number> }>();
    const sliceOf = (hour: number) => {
        const key = String(hour % HOURS_PER_DAY).padStart(2, '0');
        let slice = slices.get(key);
        if (!slice) {
            slice = { file: { stops: [], coords: [], trips: {} }, stopIndex: new Map() };
            slices.set(key, slice);
        }
        return slice;
    };

    for (const [tripId, stops] of tripStops) {
        const window = windows.trips[tripId];
        if (!window || window[2] === 0 || stops.length < 2) continue;
        const fromHour = Math.floor(Math.max(0, window[0] - STOP_TIMES_WINDOW.EARLY_MINS) / 60);
        const toHour = Math.floor((window[1] + STOP_TIMES_WINDOW.LATE_MINS) / 60);

        for (let hour = fromHour; hour <= toHour; hour++) {
            const { file, stopIndex } = sliceOf(hour);
            const row: number[] = [];
            let previousDeparture = 0;
            for (const stop of stops) {
                let index = stopIndex.get(stop.stop_id);
                if (index === undefined) {
                    index = file.stops.push(stop.stop_id) - 1;
                    stopIndex.set(stop.stop_id, index);
                    file.coords.push([Number((stop.lon ?? 0).toFixed(COORD_DECIMALS)), Number((stop.lat ?? 0).toFixed(COORD_DECIMALS))]);
                }
                const arrival = timeToMinutes(stop.arrival_time || stop.departure_time);
                const departure = timeToMinutes(stop.departure_time || stop.arrival_time);
                row.push(index, row.length ? arrival - previousDeparture : arrival, departure - arrival);
                previousDeparture = departure;
            }
            file.trips[tripId] = row;
        }
    }
    return new Map([...slices].map(([key, { file }]) => [key, file]));
}
