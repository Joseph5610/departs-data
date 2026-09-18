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

/** One row of a departures chunk: `[trip_id, route_id, headsign, timestamp_ms, wheelchair, is_request_stop]`. */
export type DepartureRow = [string, string, string, number, number, 0 | 1];

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
