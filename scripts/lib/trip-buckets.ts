import type { TripBucketFile, TripStop, TripWindowsFile } from './contract.ts';
import { tripBucketId } from './contract.ts';

/**
 * `trip_buckets/` files: each trip's stops, its window, days and route, and the days each onward
 * connection runs on, so a vehicle detail reads one bucket and no whole-network table.
 */
export function buildTripBuckets(
    tripStops: Map<string, TripStop[]>,
    windows: TripWindowsFile,
    tripRoutes: Record<string, string>
): Map<string, TripBucketFile> {
    const buckets = new Map<string, TripBucketFile>();
    for (const [tripId, stops] of tripStops) {
        const bucketId = tripBucketId(tripId);
        let bucket = buckets.get(bucketId);
        if (!bucket) {
            bucket = { $days: windows.days, $trips: {} };
            buckets.set(bucketId, bucket);
        }

        bucket[tripId] = stops.map((stop): TripStop => (stop.connections
            ? { ...stop, connections: stop.connections.map(([toTripId, routeId, headsign, time, minTransfer, maxWait]) => [toTripId, routeId, headsign, time, minTransfer, maxWait, windows.trips[toTripId]?.[2] ?? 0]) }
            : stop));
        const window = windows.trips[tripId];
        if (window) bucket.$trips[tripId] = [window[0], window[1], window[2], tripRoutes[tripId] ?? ''];
    }
    return buckets;
}
