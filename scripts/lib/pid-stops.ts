import type { MapStopCollection, MapStopFeature, MapStopProperties } from './contract.ts';
import { getVehicleColor } from './pid-colors.ts';

/** One PID GTFS `stops.txt` row as a point feature, as far as the build reads it. */
export interface GtfsStopFeature {
    type: 'Feature';
    geometry: { type: 'Point'; coordinates: [number, number] };
    properties: {
        stop_id: string;
        stop_name: string | null;
        location_type: number;
        parent_station?: string | null;
        platform_code?: string | null;
        zone_id?: string | null;
    };
}

/** One PID enrichment entry: the PID lines (`e` = exit only) and full name of a GTFS stop. */
export interface PidEnrichment {
    l: Array<{ n: string; t: string; e: number }>;
    n: string | undefined;
}

/**
 * Builds Prague's final map stop list from the PID GTFS stops and the PID enrichment.
 *
 * Ported from departs-app `functions/_adapters/golemio/services/stops/` (`StopsMapper.map` and
 * `grouping.ts`), which did this per request; the output must stay identical to what
 * `/api/prague/stops` returned.
 */
export function buildPragueMapStops(
    rawStops: readonly GtfsStopFeature[],
    enrichmentMap: Readonly<Record<string, PidEnrichment>>,
    interchanges: ReadonlyMap<string, ReadonlySet<string>>
): MapStopCollection {
    return { type: 'FeatureCollection', features: processStops(enrichStops(rawStops, enrichmentMap, interchanges)) };
}

/** PID's documented `stop_icons` order: metro, rail, funicular, ferry, airport, tram, trolleybus, bus. */
const INTERCHANGE_ORDER = ['Ma', 'Mb', 'Mc', 'Md', 'Ra', 'Sb', 'Fu', 'Fe', 'Ap', 'Tw', 'Tb', 'Bu'];

const orderInterchanges = (codes: ReadonlySet<string>): string[] | undefined => {
    if (codes.size === 0) return undefined;
    const rank = (c: string) => { const i = INTERCHANGE_ORDER.indexOf(c); return i === -1 ? INTERCHANGE_ORDER.length : i; };
    return [...codes].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
};

/** Union of the features' interchanges, in PID order. */
const mergeInterchanges = (features: readonly MapStopFeature[]): string[] | undefined =>
    orderInterchanges(new Set(features.flatMap(f => f.properties.interchanges ?? [])));

/** Drops exit-only stops and attaches PID lines and names. */
function enrichStops(
    rawStops: readonly GtfsStopFeature[],
    enrichmentMap: Readonly<Record<string, PidEnrichment>>,
    interchanges: ReadonlyMap<string, ReadonlySet<string>>
): MapStopFeature[] {
    return rawStops
        .filter(f => {
            const enrichment = enrichmentMap[f.properties.stop_id];
            if (!enrichment) return true;
            return enrichment.l && enrichment.l.some(l => l.e === 0);
        })
        .map(f => {
            const enrichment = enrichmentMap[f.properties.stop_id];
            const lines: NonNullable<MapStopProperties['lines']> = enrichment
                ? enrichment.l.map(l => ({ name: l.n, type: l.t, route_color: getVehicleColor(l.t, l.n) }))
                : [];
            return {
                type: 'Feature' as const,
                geometry: f.geometry,
                properties: {
                    stop_id: f.properties.stop_id,
                    stop_name: enrichment?.n || f.properties.stop_name || '',
                    location_type: f.properties.location_type,
                    parent_station: f.properties.parent_station ?? null,
                    platform_code: f.properties.platform_code ?? null,
                    zone_id: f.properties.zone_id ?? null,
                    lines,
                    interchanges: orderInterchanges(interchanges.get(f.properties.stop_id) ?? new Set())
                }
            };
        });
}

interface HierarchyContext {
    stationAnchors: Map<string, MapStopFeature>;
    stationChildrenFeatures: Map<string, MapStopFeature[]>;
    publicStops: MapStopFeature[];
}

function buildStructuralHierarchy(allStops: MapStopFeature[]): HierarchyContext {
    const ctx: HierarchyContext = {
        stationAnchors: new Map(),
        stationChildrenFeatures: new Map(),
        publicStops: []
    };
    
    for (const f of allStops) {
        const p = f.properties;
        const type = Number(p.location_type);
        if (type !== 2 && !p.zone_id && !p.parent_station) continue;
        
        ctx.publicStops.push(f);
        
        if (type === 1) {
            ctx.stationAnchors.set(p.stop_id, f);
        } else if (p.parent_station) {
            let features = ctx.stationChildrenFeatures.get(p.parent_station);
            if (!features) {
                features = [];
                ctx.stationChildrenFeatures.set(p.parent_station, features);
            }
            features.push(f);
        }
    }
    return ctx;
}

interface EnrichmentContext {
    groups: Map<string, MapStopFeature>;
    nameGroups: Map<string, MapStopFeature[]>;
}

function enrichPublicStops(ctx: HierarchyContext): EnrichmentContext {
    const groups = new Map<string, MapStopFeature>();
    const nameGroups = new Map<string, MapStopFeature[]>();

    for (const f of ctx.publicStops) {
        const p = f.properties;
        const type = Number(p.location_type);
        const stopId = p.stop_id;
        const lines: NonNullable<MapStopProperties['lines']> = p.lines ?? [];
        
        let isTrain = 0;
        const metroSet = new Set<string>();
        
        for (const l of lines) {
            const t = String(l.type);
            if (t === 'metro') {
                metroSet.add(l.name);
            } else if (t === 'train' || t === 'rail') {
                isTrain = 1;
            }
        }
        
        const metroLines = Array.from(metroSet).sort();
        const stopName = p.stop_name;

        const enrichedProperties: MapStopProperties = {
            stop_id: stopId,
            stop_name: stopName,
            platform_code: p.platform_code ?? null,
            location_type: type,
            parent_station: p.parent_station ?? null,
            zone_id: p.zone_id ?? null,
            is_train: isTrain as 0 | 1,
            metro_lines: metroLines.length > 0 ? metroLines.map(name => ({ name, route_color: getVehicleColor('metro', name) })) : undefined,
            lines: lines.map(l => ({ name: l.name, type: l.type, route_color: getVehicleColor(String(l.type), l.name) })),
            interchanges: p.interchanges
        };

        const nodeIdMatch = stopId.match(/^([A-Za-z]*\d+)/);
        const nodeId = nodeIdMatch ? nodeIdMatch[1] : stopId;
        const enrichedFeature: MapStopFeature = { type: 'Feature', geometry: f.geometry, properties: enrichedProperties };

        // Group non-station stops with same name/node into a centroid cluster
        if ((type === 0 || type === 1 || isNaN(type)) && p.stop_name) {
            const centroidKey = `${stopName}_${nodeId}`;
            let ng = nameGroups.get(centroidKey);
            if (!ng) {
                ng = [];
                nameGroups.set(centroidKey, ng);
            }
            ng.push(enrichedFeature);
        }

        // Structural Station (Type 1): Merge all child lines/colors into the parent node
        if (type === 1) {
            const childFeatures = ctx.stationChildrenFeatures.get(stopId) || [];
            // The station id is its departure-board id: served platforms only, never pathway nodes or track sectors.
            const platforms: MapStopFeature[] = [];
            const served: MapStopFeature[] = [];
            for (const c of childFeatures) {
                if (Number(c.properties.location_type) !== 0) continue;
                platforms.push(c);
                if ((c.properties.lines?.length ?? 0) > 0) served.push(c);
            }
            const departurePlatforms = served.length > 0 ? served : platforms;
            const childrenList = departurePlatforms.map(c => c.properties.stop_id);
            
            const uniqueLinesMap = new Map<string, { name: string, type: string, route_color: string }>();
            let aggIsTrain = 0;
            const aggMetroSet = new Set<string>();

            for (const cf of childFeatures) {
                for (const l of (cf.properties.lines ?? [])) {
                    const key = `${l.name}_${l.type}`;
                    if (!uniqueLinesMap.has(key)) {
                        uniqueLinesMap.set(key, { name: l.name, type: l.type, route_color: getVehicleColor(String(l.type), l.name) });
                    }
                    const t = String(l.type);
                    if (t === 'metro') {
                        aggMetroSet.add(l.name);
                    } else if (t === 'train' || t === 'rail') {
                        aggIsTrain = 1;
                    }
                }
            }
            
            const aggregatedMetroLines = Array.from(aggMetroSet).sort();

            let finalGeometry = enrichedFeature.geometry;
            if (childFeatures.length > 0) {
                let sumLng = 0, sumLat = 0;
                for (const child of childFeatures) { sumLng += child.geometry.coordinates[0]; sumLat += child.geometry.coordinates[1]; }
                finalGeometry = { type: "Point", coordinates: [sumLng / childFeatures.length, sumLat / childFeatures.length] };
            }

            groups.set(`metro_station_${stopId}`, {
                type: 'Feature', geometry: finalGeometry,
                properties: {
                    ...enrichedProperties,
                    lines: Array.from(uniqueLinesMap.values()),
                    metro_lines: aggregatedMetroLines.map(name => ({ name, route_color: getVehicleColor('metro', name) })),
                    is_train: (aggIsTrain || isTrain) as 0 | 1,
                    interchanges: mergeInterchanges(departurePlatforms),
                    location_type: 1,
                    stop_id: childrenList.length > 0 ? childrenList.join(',') : stopId
                }
            });
            continue;
        }

        if (type === 2) {
            groups.set(`entrance_${stopId}`, { type: 'Feature', geometry: f.geometry, properties: { ...enrichedProperties, location_type: 2 } });
            continue;
        }

        if (type === 0 || isNaN(type)) {
            if (p.parent_station && ctx.stationAnchors.has(p.parent_station)) continue;
            if (!p.stop_name) continue;
            const key = `stop_${stopName.toLowerCase()}_${nodeId}_${p.platform_code || ''}`;
            const existing = groups.get(key);
            if (!existing) {
                groups.set(key, { type: 'Feature', geometry: f.geometry, properties: { ...enrichedProperties, all_ids: [stopId] } });
            } else {
                existing.properties.all_ids = [...(existing.properties.all_ids || []), stopId];
                existing.properties.interchanges = mergeInterchanges([existing, enrichedFeature]);
            }
        }
    }

    return { groups, nameGroups };
}

function generateVirtualCentroids(ctx: EnrichmentContext): MapStopFeature[] {
    const features: MapStopFeature[] = [];

    for (const f of ctx.groups.values()) {
        const allIds = f.properties.all_ids;
        const finalId = allIds && allIds.length > 0 ? allIds.join(',') : f.properties.stop_id;
        features.push({ ...f, properties: { ...f.properties, stop_id: finalId } });
    }

    for (const groupFeatures of ctx.nameGroups.values()) {
        const station = groupFeatures.find(f => Number(f.properties.location_type) === 1);
        const baseFeature = station ?? groupFeatures[0];
        if (!baseFeature) continue;
        let sumLng = 0, sumLat = 0;
        let aggIsTrain = 0;
        const aggMetroSet = new Set<string>();
        
        for (const f of groupFeatures) { 
            sumLng += f.geometry.coordinates[0]; 
            sumLat += f.geometry.coordinates[1];
            if (f.properties.is_train === 1) aggIsTrain = 1;
            for (const m of (f.properties.metro_lines || [])) {
                aggMetroSet.add(m.name);
            }
        }
        
        const allMetroNames = Array.from(aggMetroSet).sort();
        const centroidId = `centroid-${baseFeature.properties.stop_id}`;

        features.push({
            type: "Feature", id: centroidId,
            geometry: { type: "Point", coordinates: [sumLng / groupFeatures.length, sumLat / groupFeatures.length] },
            properties: {
                ...baseFeature.properties,
                metro_lines: allMetroNames.map(name => ({ name, route_color: getVehicleColor('metro', name) })),
                is_train: aggIsTrain as 0 | 1,
                interchanges: undefined,
                is_centroid: true,
                stop_id: centroidId
            }
        });
    }

    return features;
}

/**
 * Processes and groups raw GTFS stop features into structural parent stations and logical centroids.
 * 
 * GTFS Location Types:
 * - 0: Stop/Platform
 * - 1: Station
 * - 2: Entrance/Exit
 *
 * Algorithm:
 * 1. Two-phase structural grouping (identifying Type 1 parents and Type 2 entrances).
 * 2. Logical enrichment (computing aggregated lines, colors, train presence).
 * 3. Centroid generation (creating virtual `is_centroid` nodes for UI map labels).
 *
 * @param allStops Raw GTFS stop features
 * @returns Grouped, enriched, and centroid-injected features
 */
function processStops(allStops: MapStopFeature[]): MapStopFeature[] {
    const hierarchyCtx = buildStructuralHierarchy(allStops);
    const enrichmentCtx = enrichPublicStops(hierarchyCtx);
    return generateVirtualCentroids(enrichmentCtx);
}
