import type AdmZip from 'adm-zip';
import { readTable } from './feed.ts';

/** One `stops.txt` row with its numbers parsed; `lat`/`lon` are null when the feed leaves them empty. */
export interface GtfsStop {
    stop_id: string;
    stop_name: string;
    lat: number | null;
    lon: number | null;
    location_type: number;
    parent_station: string | null;
    platform_code: string | null;
    zone_id: string | null;
}

const STOPS_TABLE = {
    required: ['stop_id', 'stop_name'],
    optional: ['stop_lat', 'stop_lon', 'location_type', 'parent_station', 'platform_code', 'zone_id'],
} as const;

/** Every row of a feed's `stops.txt`, in file order. */
export function readStops(zip: AdmZip): GtfsStop[] {
    return readTable(zip, 'stops.txt', STOPS_TABLE).map(s => ({
        stop_id: s.stop_id,
        stop_name: s.stop_name,
        lat: s.stop_lat ? Number(s.stop_lat) : null,
        lon: s.stop_lon ? Number(s.stop_lon) : null,
        location_type: Number(s.location_type || 0),
        parent_station: s.parent_station || null,
        platform_code: s.platform_code || null,
        zone_id: s.zone_id || null,
    }));
}
