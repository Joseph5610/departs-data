import type { StopFeature } from './contract.ts';

/**
 * Each platform's direction, for platforms the feed gives no code: the name of the stop most of its trips
 * call at next, as riders read it on the stop sign ("směr Grohova"). A next call at a stop of the same name
 * (the same station's other side) is skipped, and a platform no trip leaves from gets none.
 * `trips` are each trip's calls in stop order.
 */
export function platformDirections(features: readonly StopFeature[], trips: Iterable<readonly string[]>): Map<string, string> {
    const nameOf = new Map(features.map(f => [f.properties.stop_id, f.properties.stop_name]));
    const needsDirection = new Set(features
        .filter(f => f.properties.location_type === 0 && !f.properties.platform_code && f.properties.parent_station)
        .map(f => f.properties.stop_id));

    const counts = new Map<string, Map<string, number>>();
    for (const calls of trips) {
        for (let i = 0; i < calls.length - 1; i++) {
            const stopId = calls[i]!;
            if (!needsDirection.has(stopId)) continue;
            const here = nameOf.get(stopId);
            let next: string | undefined;
            for (let j = i + 1; j < calls.length && !next; j++) {
                const name = nameOf.get(calls[j]!);
                if (name && name !== here) next = name;
            }
            if (!next) continue;
            let perStop = counts.get(stopId);
            if (!perStop) { perStop = new Map(); counts.set(stopId, perStop); }
            perStop.set(next, (perStop.get(next) ?? 0) + 1);
        }
    }

    const directions = new Map<string, string>();
    for (const [stopId, perStop] of counts) {
        let best = '';
        let bestCount = 0;
        for (const [name, count] of perStop) {
            if (count > bestCount || (count === bestCount && name < best)) { best = name; bestCount = count; }
        }
        directions.set(stopId, best);
    }
    return directions;
}
