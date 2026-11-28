import { RAIL_TRIP_LINE, RAIL_TRIP_NUMBER_SEPARATOR } from './contract.ts';
import type { ServiceDay } from './time.ts';

/** One call of a train, in service-day minutes that pass 24:00 after midnight. */
export interface TrainCall {
    /** The feed's station id, which tells two runs of one number apart. */
    stationId: string;
    arrival: number;
    departure: number;
}

/** One train of the rail feed on its service days, under all the numbers it runs as. */
export interface TrainRun<C extends TrainCall = TrainCall> {
    numbers: readonly string[];
    dates: ServiceDay[];
    calls: C[];
}

/**
 * A train's published trip id, `<numbers>-rail-<variant>`: the CIS JŘ shape `<spoj>-<line>-<timetable>`
 * with the train numbers as its spoj, so departs-app matches a realtime train number like a bus trip.
 */
export const railTripId = (numbers: readonly string[], variant: number): string =>
    `${numbers.join(RAIL_TRIP_NUMBER_SEPARATOR)}-${RAIL_TRIP_LINE}-${variant}`;

const runKey = (run: TrainRun) =>
    `${run.numbers.join(RAIL_TRIP_NUMBER_SEPARATOR)}|${run.calls.map(c => `${c.stationId}@${c.arrival}/${c.departure}`).join(',')}`;

/**
 * The runs by trip id. A merged national feed lists one train under several trips (calendar variants,
 * carriers); identical runs become one trip on all their days, and the remaining variants of the same
 * numbers are numbered by first departure, so the ids stay put while the timetable does.
 */
export function trainTrips<C extends TrainCall>(runs: Iterable<TrainRun<C>>): Map<string, TrainRun<C>> {
    const unique = new Map<string, TrainRun<C>>();
    for (const run of runs) {
        if (run.calls.length < 2 || run.numbers.length === 0) continue;
        const key = runKey(run);
        const known = unique.get(key);
        if (!known) {
            unique.set(key, { ...run, dates: [...run.dates] });
            continue;
        }
        for (const day of run.dates) if (!known.dates.some(d => d.str === day.str)) known.dates.push(day);
    }

    const byNumbers = new Map<string, TrainRun<C>[]>();
    for (const run of unique.values()) {
        run.dates.sort((a, b) => a.midnight - b.midnight);
        const numbers = run.numbers.join(RAIL_TRIP_NUMBER_SEPARATOR);
        const list = byNumbers.get(numbers);
        if (list) list.push(run);
        else byNumbers.set(numbers, [run]);
    }

    const trips = new Map<string, TrainRun<C>>();
    for (const list of byNumbers.values()) {
        list.sort((a, b) => a.calls[0]!.departure - b.calls[0]!.departure || runKey(a).localeCompare(runKey(b)));
        list.forEach((run, i) => trips.set(railTripId(run.numbers, i + 1), run));
    }
    return trips;
}

/**
 * A train's line: the first of the networks' designations Spojenka joins (`S4/U4` is S4, as Portabo's
 * traffic feed names it), without the train's name (`Ex5 Berliner` is Ex5).
 */
export function railLineName(shortName: string): string {
    return shortName.split('/').map(part => part.trim().split(/\s+/)[0]!).find(Boolean) ?? '';
}
