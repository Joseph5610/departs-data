import type AdmZip from 'adm-zip';
import { readTable } from './feed.ts';

/** `toTrip` waits at `toStop` up to `maxWaitS` for `fromTrip` arriving at `fromStop`. */
export interface Connection { fromTrip: string; fromStop: string; toTrip: string; toStop: string; minTransferS: number; maxWaitS: number }

export interface ConnectionIndex {
    /** Keyed by `tripStopKey(fromTrip, fromStop)`: the trips waiting for this arrival. */
    outgoing: Map<string, Connection[]>;
    /** Keyed by `tripStopKey(toTrip, toStop)`: the arrivals this departure waits for. */
    incoming: Map<string, Connection[]>;
}

const TRANSFERS = {
    required: ['from_stop_id', 'to_stop_id', 'from_trip_id', 'to_trip_id', 'min_transfer_time'],
    optional: ['max_waiting_time'],
    fileOptional: true,
} as const;

export const tripStopKey = (tripId: string, stopId: string): string => `${tripId}|${stopId}`;

/**
 * Reads the held trip-to-trip connections from `transfers.txt`, indexed from both ends. Rows
 * without trip ids, or held for less than `minWaitS`, are not held connections and are skipped,
 * as are rows where either trip fails `isActive`.
 */
export function readHeldConnections(zip: AdmZip, isActive: (tripId: string) => boolean, minWaitS: number): ConnectionIndex {
    const outgoing = new Map<string, Connection[]>();
    const incoming = new Map<string, Connection[]>();
    let count = 0;
    for (const r of readTable(zip, 'transfers.txt', TRANSFERS)) {
        const maxWaitS = Number(r.max_waiting_time || 0);
        if (!r.from_trip_id || !r.to_trip_id || !(maxWaitS >= minWaitS)) continue;
        if (!isActive(r.from_trip_id) || !isActive(r.to_trip_id)) continue;
        const c: Connection = {
            fromTrip: r.from_trip_id,
            fromStop: r.from_stop_id,
            toTrip: r.to_trip_id,
            toStop: r.to_stop_id,
            minTransferS: Number(r.min_transfer_time || 0),
            maxWaitS,
        };
        push(outgoing, tripStopKey(c.fromTrip, c.fromStop), c);
        push(incoming, tripStopKey(c.toTrip, c.toStop), c);
        count++;
    }
    console.log(`Read ${count} held connections between active trips`);
    return { outgoing, incoming };
}

function push(map: Map<string, Connection[]>, key: string, c: Connection): void {
    let list = map.get(key);
    if (!list) { list = []; map.set(key, list); }
    list.push(c);
}
