import { STOPS_FILE, STOPS_FILE_VERSION, type Entrance, type Platform, type Position, type RouteInfo, type Station, type StopFeature, type StopsFile } from './contract.ts';

/** Route ids as `routes.json` keys them, with their branding. */
export type RouteLookup = ReadonlyMap<string, RouteInfo> | Readonly<Record<string, RouteInfo>>;

export function routeOf(routes: RouteLookup, id: string): RouteInfo | undefined {
    return routes instanceof Map ? routes.get(id) : (routes as Readonly<Record<string, RouteInfo>>)[id];
}

const round5 = (n: number) => Math.round(n * 1e5) / 1e5;

export const toPosition = (lon: number, lat: number): Position => [round5(lon), round5(lat)];

/** The ids `routes.json` knows, deduplicated and sorted by line name as the UI lists them. */
export function sortRouteIds(ids: Iterable<string>, routes: RouteLookup): string[] {
    const named: Array<[string, string]> = [];
    for (const id of new Set(ids)) {
        const route = routeOf(routes, id);
        if (route) named.push([id, route.name]);
    }
    return named
        .sort((a, b) => a[1].localeCompare(b[1], undefined, { numeric: true }) || a[0].localeCompare(b[0], undefined, { numeric: true }))
        .map(([id]) => id);
}

/** Drops stations no platform belongs to, and their entrances. */
function withServedStations(file: StopsFile): StopsFile {
    const served = new Set(file.platforms.map(p => p.station));
    const stations = file.stations.filter(s => served.has(s.id));
    if (stations.length < file.stations.length) console.log(`Left ${file.stations.length - stations.length} stations without platforms out of ${STOPS_FILE}`);
    return { ...file, stations, entrances: file.entrances.filter(e => served.has(e.station)) };
}

/**
 * A GTFS city's stops file from its stop features. `stopRoutes` holds each platform's boardable route ids,
 * `directions` the direction of platforms without a code (`platformDirections`).
 */
export function gtfsStopsFile(
    features: readonly StopFeature[],
    stopRoutes: ReadonlyMap<string, Iterable<string>>,
    directions: ReadonlyMap<string, string>,
    routes: RouteLookup,
): StopsFile {
    const stations: Station[] = [];
    const platforms: Platform[] = [];
    const entrances: Entrance[] = [];
    let orphans = 0;
    for (const f of features) {
        const p = f.properties;
        const pos = toPosition(...f.geometry.coordinates);
        if (p.location_type === 1) {
            stations.push({ id: p.stop_id, name: p.stop_name, pos });
        } else if (!p.parent_station) {
            orphans++;
        } else if (p.location_type === 2) {
            entrances.push({ id: p.stop_id, station: p.parent_station, name: p.stop_name, pos });
        } else {
            platforms.push({
                id: p.stop_id,
                aliases: p.aliases,
                station: p.parent_station,
                pos,
                code: p.platform_code ?? undefined,
                direction: p.platform_code ? undefined : directions.get(p.stop_id),
                zones: p.zone_id ? [p.zone_id] : undefined,
                routes: sortRouteIds(stopRoutes.get(p.stop_id) ?? [], routes),
                alightOnly: p.is_drop_off_only,
                interchanges: p.interchanges,
            });
        }
    }
    if (orphans) console.log(`Left ${orphans} stops without a station out of ${STOPS_FILE}`);
    return withServedStations({ version: STOPS_FILE_VERSION, stations, platforms, entrances });
}

const MAX_REPORTED_PROBLEMS = 10;

/** Throws when the file breaks the `StopsFile` contract, so a broken build never publishes. */
export function validateStopsFile(file: StopsFile, routes: RouteLookup): void {
    const problems: string[] = [];
    const ids = new Set<string>();
    const claim = (id: string, what: string) => {
        if (!id) problems.push(`${what} with an empty id`);
        else if (id.includes(',')) problems.push(`${what} ${id} has a comma-joined id`);
        else if (ids.has(id)) problems.push(`${what} ${id} reuses an id`);
        ids.add(id);
    };
    const checkPos = ([lon, lat]: Position, what: string) => {
        if (!Number.isFinite(lon) || !Number.isFinite(lat) || Math.abs(lon) > 180 || Math.abs(lat) > 90) problems.push(`${what} has position ${lon},${lat}`);
    };

    const stationIds = new Set(file.stations.map(s => s.id));
    const platformsPerStation = new Map<string, number>();
    for (const s of file.stations) {
        claim(s.id, 'station');
        if (!s.name) problems.push(`station ${s.id} has no name`);
        checkPos(s.pos, `station ${s.id}`);
    }
    for (const p of file.platforms) {
        claim(p.id, 'platform');
        for (const alias of p.aliases ?? []) claim(alias, `alias of platform ${p.id}`);
        if (!stationIds.has(p.station)) problems.push(`platform ${p.id} names unknown station ${p.station}`);
        platformsPerStation.set(p.station, (platformsPerStation.get(p.station) ?? 0) + 1);
        checkPos(p.pos, `platform ${p.id}`);
        for (const r of p.routes) if (!routeOf(routes, r)) problems.push(`platform ${p.id} names unknown route ${r}`);
        if (p.code && p.direction) problems.push(`platform ${p.id} has both a code and a direction`);
    }
    for (const e of file.entrances) {
        claim(e.id, 'entrance');
        if (!stationIds.has(e.station)) problems.push(`entrance ${e.id} names unknown station ${e.station}`);
        checkPos(e.pos, `entrance ${e.id}`);
    }
    for (const s of file.stations) if (!platformsPerStation.has(s.id)) problems.push(`station ${s.id} has no platform`);

    if (problems.length) {
        throw new Error(`${STOPS_FILE} breaks its contract (${problems.length} problems):\n  ${problems.slice(0, MAX_REPORTED_PROBLEMS).join('\n  ')}`);
    }
}
