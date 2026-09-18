import type { MapStopCollection, MapStopFeature, RouteInfo, StopFeature } from './contract.ts';

/**
 * Builds the final map stop list of a GTFS city: stations (`location_type` 1) absorb their platforms'
 * lines and ids and become the centroids; platforms follow, marked as non-centroids.
 *
 * Ported from departs-app `functions/_adapters/gtfs/services/stops/StopsMapper.ts`, which did this per
 * request; the output must stay identical to what `/api/<city>/stops` returned.
 */
export function buildGtfsMapStops(stops: readonly StopFeature[]): MapStopCollection {
    const parents = new Map<string, MapStopFeature>();
    const nodes: MapStopFeature[] = [];

    for (const stop of stops) {
        const feature: MapStopFeature = structuredClone(stop);
        if (feature.properties.location_type === 1) {
            parents.set(feature.properties.stop_id, feature);
        } else {
            nodes.push(feature);
        }
    }

    for (const node of nodes) {
        const parentId = node.properties.parent_station;
        const parent = parentId ? parents.get(parentId) : undefined;
        if (!parent) continue;

        const allLines = new Map<string, RouteInfo>((parent.properties.lines ?? []).map(l => [l.name, l]));
        for (const l of node.properties.lines ?? []) {
            allLines.set(l.name, l);
        }
        parent.properties.lines = [...allLines.values()];

        if (node.properties.lines?.some(l => String(l.type) === '2' || l.type === 'train')) {
            parent.properties.is_train = 1;
        }

        (parent.properties.all_ids ??= []).push(node.properties.stop_id);
    }

    const features: MapStopFeature[] = [];
    for (const parent of parents.values()) {
        parent.properties.is_centroid = true;
        features.push(parent);
    }
    for (const node of nodes) {
        node.properties.is_centroid = false;
        features.push(node);
    }

    return { type: 'FeatureCollection', features };
}
