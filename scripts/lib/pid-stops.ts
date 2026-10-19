import type { StopFeature } from './contract.ts';

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

/** A GTFS stop with PID's name and whether a PID line boards there. */
interface PidStop {
    id: string;
    name: string;
    coordinates: [number, number];
    locationType: number;
    parentStation: string | null;
    platformCode: string | null;
    zoneId: string | null;
    served: boolean;
    interchanges: string[] | undefined;
}

/** A published platform or entrance: the GTFS stops merged into it, the first id leading. */
interface Grouped {
    kind: 'platform' | 'entrance';
    ids: string[];
    base: PidStop;
    coordinates: [number, number];
    interchanges: string[] | undefined;
    /** The GTFS station a structural station's platform feature stands for; its routes are all its platforms'. */
    gtfsStation?: string;
}

/** PID's documented `stop_icons` order: metro, rail, funicular, ferry, airport, tram, trolleybus, bus. */
const INTERCHANGE_ORDER = ['Ma', 'Mb', 'Mc', 'Md', 'Ra', 'Sb', 'Fu', 'Fe', 'Ap', 'Tw', 'Tb', 'Bu'];

const orderInterchanges = (codes: ReadonlySet<string>): string[] | undefined => {
    if (codes.size === 0) return undefined;
    const rank = (c: string) => { const i = INTERCHANGE_ORDER.indexOf(c); return i === -1 ? INTERCHANGE_ORDER.length : i; };
    return [...codes].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
};

/** Union of the given interchanges, in PID order. */
const mergeInterchanges = (lists: ReadonlyArray<readonly string[] | undefined>): string[] | undefined =>
    orderInterchanges(new Set(lists.flatMap(l => l ?? [])));

/** A PID pole's GTFS id, `U<node>Z<pole>` with an optional variant suffix (`U1040Z1P`). */
const POLE_ID = /^U(\d+)Z(\d+)/;

/**
 * A station's published id, after PID's own id of its lowest-numbered pole (`1040/1` -> `U1040-1`): PID
 * keeps pole ids unique and unchanged, while its stop groups have no id of their own. Undefined without a pole.
 */
function stationIdOf(platformIds: readonly string[]): string | undefined {
    let best: { node: string; pole: number } | undefined;
    for (const id of platformIds) {
        const match = POLE_ID.exec(id);
        if (!match) continue;
        const pole = Number(match[2]);
        if (!best || pole < best.pole) best = { node: match[1]!, pole };
    }
    return best && `U${best.node}-${best.pole}`;
}

const mean = (points: ReadonlyArray<readonly [number, number]>): [number, number] => {
    let sumLng = 0, sumLat = 0;
    for (const [lng, lat] of points) { sumLng += lng; sumLat += lat; }
    return [sumLng / points.length, sumLat / points.length];
};

/** Drops exit-only stops and attaches PID names and whether a line boards. */
function enrichStops(
    rawStops: readonly GtfsStopFeature[],
    enrichmentMap: Readonly<Record<string, PidEnrichment>>,
    interchanges: ReadonlyMap<string, ReadonlySet<string>>
): PidStop[] {
    const stops: PidStop[] = [];
    for (const { geometry, properties: p } of rawStops) {
        const enrichment = enrichmentMap[p.stop_id];
        if (enrichment && !enrichment.l?.some(l => l.e === 0)) continue;
        stops.push({
            id: p.stop_id,
            name: enrichment?.n || p.stop_name || '',
            coordinates: geometry.coordinates,
            locationType: Number(p.location_type),
            parentStation: p.parent_station ?? null,
            platformCode: p.platform_code ?? null,
            zoneId: p.zone_id ?? null,
            served: (enrichment?.l.length ?? 0) > 0,
            interchanges: orderInterchanges(interchanges.get(p.stop_id) ?? new Set()),
        });
    }
    return stops;
}

/**
 * Prague's stops as the shared `StopFeature`s every city's stops file is built from, with each platform's
 * `routes.json` ids (`routeIdsOf` holds each GTFS stop's).
 *
 * PID's GTFS gives only metro and rail stations a `parent_station`, so the stations here are made by
 * grouping stops of the same name and node (`U1000`). Poles sharing a name, node and platform code merge
 * into one platform, its other GTFS ids becoming aliases; a GTFS station becomes one platform of its served
 * platforms' ids, which its own children leave to it.
 */
export function buildPragueStops(
    rawStops: readonly GtfsStopFeature[],
    enrichmentMap: Readonly<Record<string, PidEnrichment>>,
    interchanges: ReadonlyMap<string, ReadonlySet<string>>,
    routeIdsOf: ReadonlyMap<string, readonly string[]>,
): { features: StopFeature[]; stopRoutes: Map<string, string[]> } {
    const stops = enrichStops(rawStops, enrichmentMap, interchanges)
        .filter(s => s.locationType === 2 || s.zoneId || s.parentStation);

    const gtfsStations = new Set<string>();
    const childrenOf = new Map<string, PidStop[]>();
    for (const s of stops) {
        if (s.locationType === 1) gtfsStations.add(s.id);
        else if (s.parentStation) {
            let children = childrenOf.get(s.parentStation);
            if (!children) { children = []; childrenOf.set(s.parentStation, children); }
            children.push(s);
        }
    }

    const grouped = new Map<string, Grouped>();
    const nameGroups = new Map<string, PidStop[]>();
    for (const s of stops) {
        const node = /^([A-Za-z]*\d+)/.exec(s.id)?.[1] ?? s.id;

        if ((s.locationType === 0 || s.locationType === 1 || isNaN(s.locationType)) && s.name) {
            const key = `${s.name}_${node}`;
            let group = nameGroups.get(key);
            if (!group) { group = []; nameGroups.set(key, group); }
            group.push(s);
        }

        if (s.locationType === 1) {
            const children = childrenOf.get(s.id) ?? [];
            // The station's departure-board ids: served platforms only, never pathway nodes or track sectors.
            const platforms = children.filter(c => c.locationType === 0);
            const served = platforms.filter(c => c.served);
            const departurePlatforms = served.length > 0 ? served : platforms;
            grouped.set(`station_${s.id}`, {
                kind: 'platform',
                ids: departurePlatforms.length > 0 ? departurePlatforms.map(c => c.id) : [s.id],
                base: s,
                coordinates: children.length > 0 ? mean(children.map(c => c.coordinates)) : s.coordinates,
                interchanges: mergeInterchanges(departurePlatforms.map(c => c.interchanges)),
                gtfsStation: s.id,
            });
        } else if (s.locationType === 2) {
            grouped.set(`entrance_${s.id}`, { kind: 'entrance', ids: [s.id], base: s, coordinates: s.coordinates, interchanges: s.interchanges });
        } else if (s.locationType === 0 || isNaN(s.locationType)) {
            if (s.parentStation && gtfsStations.has(s.parentStation)) continue;
            if (!s.name) continue;
            const key = `stop_${s.name.toLowerCase()}_${node}_${s.platformCode || ''}`;
            const existing = grouped.get(key);
            if (!existing) {
                grouped.set(key, { kind: 'platform', ids: [s.id], base: s, coordinates: s.coordinates, interchanges: s.interchanges });
            } else {
                existing.ids.push(s.id);
                existing.interchanges = mergeInterchanges([existing.interchanges, s.interchanges]);
            }
        }
    }

    // Each name group's index, until its platforms are known and give it an id.
    const groupOf = new Map<string, number>();
    const groups = [...nameGroups.values()];
    groups.forEach((group, i) => { for (const s of group) groupOf.set(s.id, i); });

    const features: StopFeature[] = [];
    const stopRoutes = new Map<string, string[]>();
    const stationGroup = new Map<StopFeature, number | undefined>();
    const platformIdsOf = groups.map((): string[] => []);
    for (const g of grouped.values()) {
        const { base } = g;
        const common = { stop_name: base.name, platform_code: base.platformCode, zone_id: base.zoneId, lines: [] };
        if (g.kind === 'entrance') {
            features.push({ type: 'Feature', geometry: { type: 'Point', coordinates: g.coordinates }, properties: { ...common, stop_id: base.id, location_type: 2, parent_station: null } });
            stationGroup.set(features.at(-1)!, base.parentStation ? groupOf.get(base.parentStation) : undefined);
            continue;
        }
        const [id, ...aliases] = g.ids as [string, ...string[]];
        // A merged pole boards its first member's routes; a GTFS station's feature the union of its platforms'.
        stopRoutes.set(id, (g.gtfsStation ? g.ids : [id]).flatMap(m => routeIdsOf.get(m) ?? []));
        features.push({
            type: 'Feature',
            geometry: { type: 'Point', coordinates: g.coordinates },
            properties: {
                ...common,
                stop_id: id,
                location_type: 0,
                parent_station: null,
                aliases: aliases.length ? aliases : undefined,
                interchanges: g.interchanges,
            },
        });
        const group = (g.gtfsStation !== undefined ? groupOf.get(g.gtfsStation) : undefined) ?? groupOf.get(id);
        stationGroup.set(features.at(-1)!, group);
        if (group !== undefined) platformIdsOf[group]!.push(...g.ids);
    }

    const stationIds = groups.map((group, i) => stationIdOf(platformIdsOf[i]!));
    for (const [feature, group] of stationGroup) feature.properties.parent_station = (group !== undefined && stationIds[group]) || null;
    // A station without platforms has no id; `gtfsStopsFile` leaves such stations out anyway.
    const stations = groups.flatMap((group, i): StopFeature[] => {
        const id = stationIds[i];
        if (!id) return [];
        const base = group.find(s => s.locationType === 1) ?? group[0]!;
        return [{
            type: 'Feature',
            geometry: { type: 'Point', coordinates: mean(group.map(s => s.coordinates)) },
            properties: { stop_id: id, stop_name: base.name, platform_code: null, location_type: 1, parent_station: null, zone_id: base.zoneId, lines: [] },
        }];
    });
    return { features: [...features, ...stations], stopRoutes };
}
