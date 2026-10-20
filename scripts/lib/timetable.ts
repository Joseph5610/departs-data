import path from 'node:path';
import type AdmZip from 'adm-zip';
import type { DepartureBucketFile, DepartureExtras, DepartureRow, ParentChildMap, TripStop, TripWindow, TripWindowsFile } from './contract.ts';
import { BUCKET_STATIONS_KEY, DEPARTURE_BUCKETS_DIR, departuresBucketId, parentIndex, TRIP_BUCKETS_DIR } from './contract.ts';
import { readTable } from './feed.ts';
import { readServiceDates } from './calendar.ts';
import { timeToMinutes, timeToOffsetMs, type ServiceDay } from './time.ts';
import { buildTripBuckets } from './trip-buckets.ts';
import { chunkBy, sortDepartures, writeChunks } from './emit.ts';

/*
 * One timetable pipeline for every city that publishes departures and trips (Brno, Prešov, DÚK):
 * a GTFS feed is read by `readGtfsTimetable`; any source then feeds `buildDepartures`, `tripWindows`,
 * `writeDepartures` and `writeTrips`, so each rule (who boards, when a trip ends, how rows are bucketed)
 * lives here once.
 */

const TABLES = {
    trips: { required: ['trip_id', 'route_id', 'service_id', 'trip_headsign'], optional: ['direction_id', 'wheelchair_accessible', 'shape_id'] },
    stopTimes: { required: ['trip_id', 'stop_id', 'stop_sequence', 'arrival_time', 'departure_time'], optional: ['pickup_type', 'drop_off_type', 'stop_headsign'] },
} as const;

export interface GtfsTrip {
    routeId: string;
    headsign: string;
    serviceId: string;
    wheelchair: number;
    directionId: number;
    shapeId: string | null;
}

/** A trip running on at least one of the published service days. */
export interface ActiveTrip extends GtfsTrip {
    dates: ServiceDay[];
}

/** One stop of an active trip, as the feed lists it. */
export interface Call {
    tripId: string;
    stopId: string;
    arrival: string;
    departure: string;
    sequence: number;
    isRequestStop: boolean;
    /** Riders can board here: not the trip's last stop and not set out of pickup. */
    boards: boolean;
    /** The feed's `stop_headsign`, empty when absent. */
    stopHeadsign: string;
}

export interface GtfsTimetable {
    trips: Map<string, GtfsTrip>;
    activeTrips: Map<string, ActiveTrip>;
    /** Each active trip's calls in stop order, calls without a departure time left out. */
    calls: Map<string, Call[]>;
    /** Every call of `calls`, in feed order, which keeps the order of same-minute departures stable. */
    callsInFeedOrder: Call[];
    /** The routes boarding at each stop, over the whole timetable, so a stop keeps lines that do not run today. */
    stopRoutes: Map<string, Set<string>>;
}

export interface GtfsTimetableOptions {
    /** Maps the feed's trip and service ids to the published ones (Prešov drops a feed-version prefix). */
    normalizeId?: (id: string) => string;
    /** A request stop the feed marks outside `pickup_type`/`drop_off_type` (Prešov: in the stop name). */
    isRequestStop?: (stopId: string) => boolean;
    /** Runs once the active trips are known, before `stop_times.txt` is read (Brno: held connections). */
    beforeStopTimes?: (activeTrips: ReadonlyMap<string, ActiveTrip>) => void;
    /** Sees every `stop_times.txt` row, active trip or not (Brno: connection times). */
    onStopTime?: (tripId: string, row: { stop_id: string; arrival_time: string; departure_time: string }) => void;
}

const sameId = (id: string) => id;

/** `trips.txt`, `calendar*.txt` and `stop_times.txt` read once, for `days`. */
export function readGtfsTimetable(zip: AdmZip, days: readonly ServiceDay[], opts: GtfsTimetableOptions = {}): GtfsTimetable {
    const normalizeId = opts.normalizeId ?? sameId;

    const trips = new Map<string, GtfsTrip>();
    for (const t of readTable(zip, 'trips.txt', TABLES.trips)) {
        trips.set(normalizeId(t.trip_id), {
            routeId: t.route_id,
            headsign: t.trip_headsign,
            serviceId: normalizeId(t.service_id),
            wheelchair: Number(t.wheelchair_accessible || 0),
            directionId: Number(t.direction_id || 0),
            shapeId: t.shape_id || null,
        });
    }

    const serviceDates = new Map<string, Set<ServiceDay>>();
    for (const [rawId, dates] of readServiceDates(zip, days)) serviceDates.set(normalizeId(rawId), dates);
    const activeTrips = new Map<string, ActiveTrip>();
    for (const [tripId, t] of trips) {
        const dates = serviceDates.get(t.serviceId);
        if (dates && dates.size > 0) activeTrips.set(tripId, { ...t, dates: [...dates].sort((a, b) => a.midnight - b.midnight) });
    }

    opts.beforeStopTimes?.(activeTrips);
    const rows = readTable(zip, 'stop_times.txt', TABLES.stopTimes);
    // The last stop is known over the whole timetable, so a trip's end is right even outside the window.
    const lastSequence = new Map<string, number>();
    for (const st of rows) {
        const tripId = normalizeId(st.trip_id);
        const seq = Number(st.stop_sequence);
        if (!(lastSequence.get(tripId)! >= seq)) lastSequence.set(tripId, seq);
    }

    const stopRoutes = new Map<string, Set<string>>();
    const calls = new Map<string, Call[]>();
    const callsInFeedOrder: Call[] = [];
    for (const st of rows) {
        const tripId = normalizeId(st.trip_id);
        opts.onStopTime?.(tripId, st);
        const trip = trips.get(tripId);
        if (!trip) continue;

        const boards = lastSequence.get(tripId) !== Number(st.stop_sequence) && st.pickup_type !== '1';
        if (boards) {
            let set = stopRoutes.get(st.stop_id);
            if (!set) { set = new Set(); stopRoutes.set(st.stop_id, set); }
            set.add(trip.routeId);
        }
        if (!activeTrips.has(tripId) || !st.departure_time) continue;

        const call: Call = {
            tripId,
            stopId: st.stop_id,
            arrival: st.arrival_time,
            departure: st.departure_time,
            sequence: Number(st.stop_sequence),
            isRequestStop: !!opts.isRequestStop?.(st.stop_id)
                || st.pickup_type === '2' || st.pickup_type === '3' || st.drop_off_type === '2' || st.drop_off_type === '3',
            boards,
            stopHeadsign: st.stop_headsign ?? '',
        };
        let list = calls.get(tripId);
        if (!list) { list = []; calls.set(tripId, list); }
        list.push(call);
        callsInFeedOrder.push(call);
    }
    for (const list of calls.values()) list.sort((a, b) => a.sequence - b.sequence);

    return { trips, activeTrips, calls, callsInFeedOrder, stopRoutes };
}

/** A boarding at one stop, as `buildDepartures` turns it into one row per service day. */
export interface Boarding {
    tripId: string;
    stopId: string;
    /** Departure time as an offset from the service day's midnight. */
    offsetMs: number;
    isRequestStop: boolean;
    /** Overrides the trip's headsign at this stop. */
    headsign?: string | null;
    /** The feed's call it came from, for `extrasOf`. */
    call?: Call;
}

/** What a departure row needs of its trip. */
export interface DepartingTrip {
    routeId: string;
    headsign: string;
    wheelchair: number;
    dates: readonly ServiceDay[];
}

/**
 * Each stop's departure rows, one per boarding and service day, in the order given. `extrasOf` adds a row's
 * optional data (held connections, continuations) for its day.
 */
export function buildDepartures(
    boardings: Iterable<Boarding>,
    tripOf: (tripId: string) => DepartingTrip,
    extrasOf?: (boarding: Boarding, day: ServiceDay) => DepartureExtras | undefined,
): Map<string, DepartureRow[]> {
    const departuresByStop = new Map<string, DepartureRow[]>();
    for (const b of boardings) {
        const trip = tripOf(b.tripId);
        let deps = departuresByStop.get(b.stopId);
        if (!deps) { deps = []; departuresByStop.set(b.stopId, deps); }
        for (const day of trip.dates) {
            const row: DepartureRow = [b.tripId, trip.routeId, b.headsign ?? trip.headsign, day.midnight + b.offsetMs, trip.wheelchair, b.isRequestStop ? 1 : 0];
            const extras = extrasOf?.(b, day);
            deps.push(extras ? [...row, extras] : row);
        }
    }
    return departuresByStop;
}

/** The boardings of a GTFS timetable, in feed order. */
export function* gtfsBoardings(timetable: GtfsTimetable, headsignOf?: (call: Call) => string | null): Generator<Boarding> {
    for (const call of timetable.callsInFeedOrder) {
        if (!call.boards) continue;
        yield {
            tripId: call.tripId,
            stopId: call.stopId,
            offsetMs: timeToOffsetMs(call.departure),
            isRequestStop: call.isRequestStop,
            headsign: headsignOf?.(call) ?? null,
            call,
        };
    }
}

/** What a trip window needs of a trip: its days and its first and last call in service-day minutes. */
export interface WindowedTrip {
    dates: readonly ServiceDay[];
    startMin: number;
    endMin: number;
}

/**
 * Each trip's `[startMin, endMin, dayFlags]`, `dayFlags` a bitmask over `days`; `extraOf` appends a
 * network-specific column (Prešov: `direction_id`, for matching its CSV vehicles).
 */
export function tripWindows(trips: Iterable<[string, WindowedTrip]>, days: readonly ServiceDay[], extraOf?: (tripId: string) => number): TripWindowsFile {
    const dayPos = new Map(days.map((d, i) => [d.str, i]));
    const windows: Record<string, TripWindow> = {};
    for (const [tripId, t] of trips) {
        let flags = 0;
        for (const d of t.dates) flags |= 1 << dayPos.get(d.str)!;
        windows[tripId] = extraOf ? [t.startMin, t.endMin, flags, extraOf(tripId)] : [t.startMin, t.endMin, flags];
    }
    return { days: days.map(d => d.str), trips: windows };
}

/**
 * A GTFS trip's window: from leaving its first stop until leaving its last, so a vehicle laying over at the
 * terminus (KORDIS times the layover as the last stop's departure) still matches the trip it arrived on.
 */
export function gtfsWindow(trip: ActiveTrip, calls: readonly Call[]): WindowedTrip {
    return { dates: trip.dates, startMin: timeToMinutes(calls[0]!.departure), endMin: timeToMinutes(calls[calls.length - 1]!.departure) };
}

/**
 * Writes `departure_buckets/`: each stop's rows in time order, a station's platforms in their station's bucket,
 * and in each bucket the platforms of its stations (`$stations`).
 */
export function writeDepartures(dir: string, departuresByStop: Map<string, DepartureRow[]>, parentChildMap: ParentChildMap): void {
    sortDepartures(departuresByStop);
    const parentOf = parentIndex(parentChildMap);
    const buckets: Map<string, DepartureBucketFile> = chunkBy(departuresByStop, (id) => departuresBucketId(id, parentOf));
    for (const [station, platforms] of Object.entries(parentChildMap)) {
        const bucketId = departuresBucketId(station, parentOf);
        let bucket = buckets.get(bucketId);
        if (!bucket) { bucket = {}; buckets.set(bucketId, bucket); }
        (bucket[BUCKET_STATIONS_KEY] ??= {})[station] = platforms;
    }
    writeChunks(path.join(dir, DEPARTURE_BUCKETS_DIR), buckets);
    console.log(`Wrote ${buckets.size} departure buckets for ${departuresByStop.size} stops`);
}

/** Writes `trip_buckets/`: each trip's stops with its window, days and route. */
export function writeTrips(dir: string, tripStops: Map<string, TripStop[]>, windows: TripWindowsFile, tripRoutes: Record<string, string>): void {
    const buckets = buildTripBuckets(tripStops, windows, tripRoutes);
    writeChunks(path.join(dir, TRIP_BUCKETS_DIR), buckets);
    console.log(`Wrote ${buckets.size} trip buckets for ${tripStops.size} trips`);
}

/** Where a trip's stop is and what it is called, for its `TripStop`. */
export interface StopPlace {
    name: string;
    lat?: number;
    lon?: number;
    zone_id: string | null;
}

/** A GTFS call as a published trip stop, at `place` when the stop list knows it. */
export const gtfsTripStop = (call: Call, place: StopPlace | undefined, extra: Partial<TripStop> = {}): TripStop => ({
    stop_id: call.stopId,
    name: place?.name || call.stopId,
    arrival_time: call.arrival,
    departure_time: call.departure,
    lat: place?.lat,
    lon: place?.lon,
    is_passed: false,
    zone_id: place?.zone_id || null,
    is_request_stop: call.isRequestStop,
    ...extra,
});
