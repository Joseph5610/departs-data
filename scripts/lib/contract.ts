/**
 * The chunk-addressing and output-format contract with departs-app.
 *
 * Every constant and type here has a counterpart in departs-app
 * `functions/_adapters/gtfs/core/`. Changing one side without the other makes the Worker request
 * files that do not exist, or read fields that are no longer there.
 */

/** Mirrors GTFS_CONFIG in departs-app `functions/_adapters/gtfs/core/config.ts`. */
export const CHUNKING = {
    /** Shapes bucket numerically, so no index file is needed on either side. */
    SHAPE_CHUNK_COUNT: 512,
    /** Leading characters of a stop_id that name its departures chunk. */
    DEPARTURES_CHUNK_PREFIX: 4,
    /** Leading characters of a trip_id that name its trips chunk. */
    TRIP_CHUNK_PREFIX: 3,
} as const;

/** departures/<prefix>.json */
export function departuresChunkId(stopId: string): string {
    return stopId.substring(0, CHUNKING.DEPARTURES_CHUNK_PREFIX).toUpperCase();
}

/** trips/<prefix>.json */
export function tripChunkId(tripId: string): string {
    return tripId.substring(0, CHUNKING.TRIP_CHUNK_PREFIX).toUpperCase();
}

/** shape_chunks/<bucket>.json */
export function shapeChunkId(shapeId: string): string {
    const numeric = parseInt(shapeId, 10);
    return String((Number.isNaN(numeric) ? 0 : Math.abs(numeric)) % CHUNKING.SHAPE_CHUNK_COUNT);
}

/**
 * A trip that this departure waits for: `[feeder_trip_id, feeder_route_id, feeder_arrival_ms,
 * min_transfer_s, max_wait_s]`. The variant running on the departure's day is resolved at build time.
 */
export type FeederRow = [string, string, number, number, number];

/**
 * The trip the same vehicle continues as after this one: `[trip_id | null, route_id | null, line,
 * headsign, departure_time | null]`. Ids are null when the feed names the line but no trip matches.
 */
export type ContinuationRow = [string | null, string | null, string, string, string | null];

/** Optional per-departure data; absent keys are omitted to keep chunks small. */
export interface DepartureExtras {
    feeders?: FeederRow[];
    continues?: ContinuationRow;
}

/**
 * One row of a departures chunk: `[trip_id, route_id, headsign, timestamp_ms, wheelchair, is_request_stop, extras?]`.
 * `extras` is only present when at least one of its keys is set.
 */
export type DepartureRow = [string, string, string, number, number, 0 | 1] | [string, string, string, number, number, 0 | 1, DepartureExtras];

/**
 * An onward trip that waits for this trip at this stop: `[to_trip_id, to_route_id, headsign,
 * departure_time, min_transfer_s, max_wait_s]`. Every calendar variant is listed; readers keep the
 * one operating on the viewed trip's service day.
 */
export type TripConnection = [string, string, string, string, number, number];

/**
 * `[start_mins, end_mins, dayFlags]`, plus `direction_id` for networks whose realtime feed is
 * matched to trips by schedule (Prešov). `dayFlags` is a bitmask over `TripWindowsFile.days`.
 */
export type TripWindow = [number, number, number] | [number, number, number, number];

export interface TripWindowsFile {
    days: string[];
    trips: Record<string, TripWindow>;
}

export interface RouteInfo {
    name: string;
    type: string;
    route_color: string;
}

/** A stop entry inside a trips chunk. */
export interface TripStop {
    stop_id: string;
    name: string;
    arrival_time: string;
    departure_time: string;
    lat?: number;
    lon?: number;
    is_passed: false;
    zone_id: string | null;
    is_request_stop: boolean;
    connections?: TripConnection[];
    /** Set on the last stop when the vehicle continues as another trip. */
    continues_as?: ContinuationRow;
}

export interface StopFeature {
    type: 'Feature';
    geometry: { type: 'Point'; coordinates: [number, number] };
    properties: {
        stop_id: string;
        stop_name: string;
        platform_code: string | null;
        location_type: 0 | 1 | 2;
        parent_station: string | null;
        zone_id: string | null;
        is_drop_off_only?: true | undefined;
        lines: RouteInfo[];
    };
}

export type ParentChildMap = Record<string, string[]>;

/** Mirrors `AppStopProperties` in departs-app `functions/_core/types.ts`: one stop as the map renders it. */
export interface MapStopProperties {
    stop_id: string;
    stop_name: string;
    platform_code?: string | null;
    location_type: number;
    parent_station: string | null;
    zone_id: string | null;
    is_centroid?: boolean;
    is_drop_off_only?: true | undefined;
    is_train?: 0 | 1;
    metro_a?: 0 | 1;
    metro_b?: 0 | 1;
    metro_c?: 0 | 1;
    metro_lines?: Array<{ name: string; route_color: string }> | undefined;
    metro_color?: string | undefined;
    metro_color_2?: string | undefined;
    all_ids?: string[];
    lines?: RouteInfo[];
}

export interface MapStopFeature {
    type: 'Feature';
    id?: string;
    geometry: { type: 'Point'; coordinates: [number, number] };
    properties: MapStopProperties;
}

/** `<city>/map-stops.json`: the final stop list, served unchanged by departs-app's `/api/<city>/stops`. */
export interface MapStopCollection {
    type: 'FeatureCollection';
    features: MapStopFeature[];
}

export const MAP_STOPS_FILE = 'map-stops.json';

/**
 * `prague/connections.json`: held connections and through-running for a network whose timetable is
 * served live by another API, so there are no trip or departure chunks to embed them in. Small
 * enough to be read whole, which keeps a departure board at one static fetch.
 */
export interface LiveConnectionsFile {
    /** YYYYMMDD service days the `dayFlags` bitmasks refer to. */
    days: string[];
    trips: Record<string, LiveTripConnections>;
}

export interface LiveTripConnections {
    /** Days this trip runs, as a bitmask over `days`. */
    d: number;
    /** Trips waiting for this one, by the `stop_sequence` it arrives at (live trip detail carries no stop ids). */
    out?: Record<string, LiveOnwardRow[]>;
    /** Trips this one waits for, by the stop it departs from. */
    in?: Record<string, LiveFeederRow[]>;
    /** The trip the same vehicle continues as. */
    continues?: LiveContinuationRow;
}

/** `[to_trip_id, line, route_type, headsign, departure_time, min_transfer_s, max_wait_s, dayFlags]` */
export type LiveOnwardRow = [string, string, string, string, string, number, number, number];
/** `[from_trip_id, line, route_type, arrival_time, min_transfer_s, max_wait_s, dayFlags]` */
export type LiveFeederRow = [string, string, string, string, number, number, number];
/** `[trip_id, line, route_type, headsign, departure_time]` */
export type LiveContinuationRow = [string, string, string, string, string];

/**
 * `prague/metro-exits.json`: the metro car nearest to the way out at each platform. `keys` finds the
 * platform from line, station and a neighbouring station (see `metroKey`), because live trip detail
 * names stations but not platforms.
 */
export interface MetroExitsFile {
    keys: Record<string, string>;
    platforms: Record<string, MetroPlatformExits>;
}

export interface MetroPlatformExits {
    /** `[exit name, signposted destination | null, cars for which it is the nearest exit]` */
    exits: Array<[string, string | null, number[]]>;
    /** `[exit name, cars]` with the shortest way out avoiding stairs and escalators. */
    stepFree?: [string, number[]];
}
