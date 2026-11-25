import type { IndoorFeature, IndoorGeometry, IndoorKind, IndoorPosition } from './contract.ts';
import { distanceM, round6 } from './geo.ts';

/** OSM tags of one exported object. */
export type OsmTags = Readonly<Record<string, string | undefined>>;

/** A feature as `osmium export -f geojsonseq` writes it. */
export interface OsmFeature {
    type: 'Feature';
    geometry: { type: string; coordinates: unknown };
    properties: OsmTags;
}

/** Amenities drawn as a shop-like unit (a place to buy or use something), not as plain floor. */
const SHOP_AMENITIES = new Set([
    'atm', 'bank', 'bar', 'bureau_de_change', 'cafe', 'fast_food', 'ice_cream', 'luggage_locker',
    'pharmacy', 'post_office', 'pub', 'restaurant', 'ticket_office',
]);

const FOOTWAYS = new Set(['footway', 'corridor', 'pedestrian', 'path']);

const RANGE = /^(-?\d+(?:\.\d+)?)-(-?\d+(?:\.\d+)?)$/;

const toFloor = (level: number): number => Math.round(level) || 0;

/**
 * The whole floors an OSM `level` / `repeat_on` value names: `;`-separated levels and `a-b` ranges,
 * half levels rounded to the nearest floor. Ranges spanning more than `maxSpan` floors are dropped as mistagged.
 */
export function parseLevels(value: string | undefined, maxSpan: number): number[] {
    if (!value) return [];
    const floors = new Set<number>();
    for (const raw of value.split(';')) {
        const part = raw.trim();
        const range = RANGE.exec(part);
        if (range) {
            const from = toFloor(Number(range[1]));
            const to = toFloor(Number(range[2]));
            const [low, high] = from <= to ? [from, to] : [to, from];
            if (high - low > maxSpan) continue;
            for (let floor = low; floor <= high; floor++) floors.add(floor);
            continue;
        }
        if (part === '') continue;
        const level = Number(part);
        if (Number.isFinite(level)) floors.add(toFloor(level));
    }
    return [...floors].sort((a, b) => a - b);
}

function isTicketMachine(tags: OsmTags): boolean {
    return tags.vending?.split(';').includes('public_transport_tickets') === true;
}

function unitKind(tags: OsmTags): IndoorKind | null {
    if (tags.amenity === 'toilets') return 'toilets';
    if (isTicketMachine(tags)) return 'tickets';
    if (tags.shop || (tags.amenity && SHOP_AMENITIES.has(tags.amenity))) return 'shop';
    return null;
}

/** What an OSM object is on an indoor map, or null when it is not drawn there. */
export function indoorKind(tags: OsmTags, geometryType: string): IndoorKind | null {
    const isPoint = geometryType === 'Point';
    switch (tags.indoor) {
        case 'wall': return isPoint ? null : 'wall';
        case 'room': return unitKind(tags) ?? 'room';
        case 'area': return unitKind(tags) ?? 'area';
        case 'corridor': return 'corridor';
        case 'yes': if (!isPoint) return 'area';
    }
    if (tags.highway === 'elevator' || tags.highway === 'lift') return 'elevator';
    if (tags.railway === 'subway_entrance' || tags.railway === 'train_station_entrance' || tags.entrance) return isPoint ? 'entrance' : null;
    if (!isPoint && (tags.railway === 'platform' || tags.public_transport === 'platform')) return 'platform';
    if (tags.conveying && (tags.highway === 'steps' || (tags.highway && FOOTWAYS.has(tags.highway)))) return 'escalator';
    if (tags.highway === 'steps') return 'steps';
    if (tags.highway && FOOTWAYS.has(tags.highway)) return 'footway';
    return unitKind(tags);
}

function roundPositions(value: unknown): unknown {
    if (!Array.isArray(value)) return value;
    if (typeof value[0] === 'number') return [round6(value[0]), round6(value[1] as number)];
    return value.map(roundPositions);
}

const DRAWN_GEOMETRIES = new Set(['Point', 'LineString', 'Polygon', 'MultiPolygon']);

/** Kinds drawn as floor space; osmium exports their closed ways as lines unless the tags it knows mark an area. */
const SPACE_KINDS = new Set<IndoorKind>(['area', 'room', 'corridor', 'platform', 'shop', 'toilets']);

function isClosedRing(coordinates: unknown): coordinates is IndoorPosition[] {
    if (!Array.isArray(coordinates) || coordinates.length < 4) return false;
    const first = coordinates[0] as IndoorPosition;
    const last = coordinates[coordinates.length - 1] as IndoorPosition;
    return first[0] === last[0] && first[1] === last[1];
}

function drawnGeometry(kind: IndoorKind, type: string, coordinates: unknown): IndoorGeometry {
    const rounded = roundPositions(coordinates);
    if (type === 'LineString' && SPACE_KINDS.has(kind) && isClosedRing(coordinates)) return { type: 'Polygon', coordinates: [rounded as IndoorPosition[]] };
    return { type, coordinates: rounded } as IndoorGeometry;
}

/** The indoor feature an exported OSM object becomes, or null when it has no floor or is not drawn indoors. */
export function toIndoorFeature(osm: OsmFeature, maxLevelSpan: number): IndoorFeature | null {
    const { geometry, properties: tags } = osm;
    if (!DRAWN_GEOMETRIES.has(geometry.type)) return null;
    const lv = parseLevels(tags.level ?? tags.repeat_on, maxLevelSpan);
    if (lv.length === 0) return null;
    const k = indoorKind(tags, geometry.type);
    if (!k) return null;
    const feature: IndoorFeature = {
        type: 'Feature',
        geometry: drawnGeometry(k, geometry.type, geometry.coordinates),
        properties: { k, lv },
    };
    if (tags.name) feature.properties.name = tags.name;
    if (tags.ref) feature.properties.ref = tags.ref;
    return feature;
}

type Bbox = [number, number, number, number];

/** `[west, south, east, north]` of any nested coordinate array. */
function bboxOf(coordinates: unknown, into: Bbox = [Infinity, Infinity, -Infinity, -Infinity]): Bbox {
    if (!Array.isArray(coordinates)) return into;
    if (typeof coordinates[0] === 'number') {
        const [x, y] = coordinates as IndoorPosition;
        if (x < into[0]) into[0] = x;
        if (y < into[1]) into[1] = y;
        if (x > into[2]) into[2] = x;
        if (y > into[3]) into[3] = y;
        return into;
    }
    for (const child of coordinates) bboxOf(child, into);
    return into;
}

/** The centre of a geometry's bounding box, which decides the station it belongs to. */
export function anchorOf(geometry: IndoorGeometry): IndoorPosition {
    const [west, south, east, north] = bboxOf(geometry.coordinates);
    return [(west + east) / 2, (south + north) / 2];
}

/** A metro or rail station: the points (the station and its platforms) its floor plan gathers around. */
export interface IndoorStation {
    id: string;
    name: string;
    /** The network's node; stations of one node (PID's `U142-1` metro and `U142-301` trains) share one plan. */
    node: string;
    points: IndoorPosition[];
}

export interface IndoorStationOptions {
    /** Grid size of the point index in degrees; must exceed `radiusM` and `joinM`, as a lookup scans one cell around. */
    cellDeg: number;
    /** A feature belongs to the nearest station point within this distance. */
    radiusM: number;
    /** Stations with points this close share one building and one plan (Hlavní nádraží's metro and trains). */
    joinM: number;
    /** Only areas this close to a station point make its floors; farther ones (a university hall above Můstek) are drawn but add none. */
    coreM: number;
    /** A floor needs this many floor-space areas (rooms, corridors, platforms, shops). */
    minLevelFeatures: number;
}

interface IndexedPoint {
    pos: IndoorPosition;
    station: number;
}

const gridKey = (lon: number, lat: number, cellDeg: number): string => `${Math.floor(lon / cellDeg)}_${Math.floor(lat / cellDeg)}`;

function pointGrid(stations: readonly IndoorStation[], cellDeg: number): Map<string, IndexedPoint[]> {
    const grid = new Map<string, IndexedPoint[]>();
    stations.forEach((station, index) => {
        for (const pos of station.points) {
            const key = gridKey(pos[0], pos[1], cellDeg);
            const list = grid.get(key);
            if (list) list.push({ pos, station: index });
            else grid.set(key, [{ pos, station: index }]);
        }
    });
    return grid;
}

function* pointsAround([lon, lat]: IndoorPosition, grid: ReadonlyMap<string, IndexedPoint[]>, cellDeg: number): Generator<IndexedPoint> {
    const x = Math.floor(lon / cellDeg);
    const y = Math.floor(lat / cellDeg);
    for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) yield* grid.get(`${x + dx}_${y + dy}`) ?? [];
    }
}

const metresBetween = ([lon1, lat1]: IndoorPosition, [lon2, lat2]: IndoorPosition): number =>
    distanceM({ lon: lon1, lat: lat1 }, { lon: lon2, lat: lat2 });

/**
 * Stations sharing a building, merged into one: those of one node or with points within `joinM`. The
 * lowest id names the group; its points are all of theirs.
 */
export function groupStations(stations: readonly IndoorStation[], options: IndoorStationOptions): IndoorStation[] {
    const sorted = [...stations].sort((a, b) => a.id.localeCompare(b.id));
    const parent = sorted.map((_, i) => i);
    const root = (i: number): number => (parent[i] === i ? i : (parent[i] = root(parent[i]!)));
    const join = (i: number, j: number): void => {
        const [a, b] = [root(i), root(j)];
        if (a !== b) parent[Math.max(a, b)] = Math.min(a, b);
    };
    const firstOfNode = new Map<string, number>();
    sorted.forEach((station, i) => {
        const first = firstOfNode.get(station.node);
        if (first === undefined) firstOfNode.set(station.node, i);
        else join(first, i);
    });
    const grid = pointGrid(sorted, options.cellDeg);
    sorted.forEach((station, i) => {
        for (const pos of station.points) {
            for (const other of pointsAround(pos, grid, options.cellDeg)) {
                if (other.station !== i && metresBetween(pos, other.pos) <= options.joinM) join(i, other.station);
            }
        }
    });
    const groups = new Map<number, IndoorStation>();
    sorted.forEach((station, i) => {
        const group = groups.get(root(i));
        if (group) group.points.push(...station.points);
        else groups.set(root(i), { id: station.id, name: station.name, node: station.node, points: [...station.points] });
    });
    return [...groups.values()];
}

/** A station's floor plan: its features and its floors. */
export interface StationPlan {
    features: IndoorFeature[];
    /** Floors with areas near the station, ascending. */
    levels: number[];
}

/**
 * Each station's plan: the features whose nearest station point within `radiusM` is one of its own. Its
 * floors come from the areas within `coreM`; stations without one are left out.
 */
export function stationPlans(
    features: Iterable<IndoorFeature>,
    stations: readonly IndoorStation[],
    options: IndoorStationOptions,
): Map<string, StationPlan> {
    const grid = pointGrid(stations, options.cellDeg);
    const all = new Map<string, IndoorFeature[]>();
    const core = new Map<string, IndoorFeature[]>();
    const add = (map: Map<string, IndoorFeature[]>, id: string, feature: IndoorFeature): void => {
        const list = map.get(id);
        if (list) list.push(feature);
        else map.set(id, [feature]);
    };
    for (const feature of features) {
        const anchor = anchorOf(feature.geometry);
        let nearest: number | null = null;
        let nearestM = options.radiusM;
        for (const point of pointsAround(anchor, grid, options.cellDeg)) {
            const metres = metresBetween(anchor, point.pos);
            if (metres <= nearestM) { nearest = point.station; nearestM = metres; }
        }
        if (nearest === null) continue;
        const id = stations[nearest]!.id;
        add(all, id, feature);
        if (nearestM <= options.coreM) add(core, id, feature);
    }
    const plans = new Map<string, StationPlan>();
    for (const [id, planFeatures] of all) {
        const levels = planLevels(core.get(id) ?? [], options.minLevelFeatures);
        if (levels.length > 0) plans.set(id, { features: planFeatures, levels });
    }
    return plans;
}

/** Kinds whose areas make a floor: floor space and pedestrian areas (a vestibule mapped as `highway=pedestrian, area=yes`). */
const FLOOR_KINDS = new Set<IndoorKind>([...SPACE_KINDS, 'footway']);

const isArea = ({ geometry }: IndoorFeature): boolean => geometry.type === 'Polygon' || geometry.type === 'MultiPolygon';

/** Floors with at least `minLevelFeatures` areas each, ascending. Stairs and lines alone make no floor. */
export function planLevels(features: readonly IndoorFeature[], minLevelFeatures: number): number[] {
    const counts = new Map<number, number>();
    for (const feature of features) {
        if (!isArea(feature) || !FLOOR_KINDS.has(feature.properties.k)) continue;
        for (const level of feature.properties.lv) counts.set(level, (counts.get(level) ?? 0) + 1);
    }
    return [...counts].filter(([, count]) => count >= minLevelFeatures).map(([level]) => level).sort((a, b) => a - b);
}

/** The floor a plan opens on: its platforms' floor nearest the surface, else street level, else the floor nearest to it. */
export function planStartLevel(features: readonly IndoorFeature[], levels: readonly number[]): number {
    let platformLevel: number | null = null;
    for (const feature of features) {
        if (feature.properties.k !== 'platform' || !isArea(feature)) continue;
        for (const level of feature.properties.lv) {
            if (levels.includes(level) && (platformLevel === null || Math.abs(level) < Math.abs(platformLevel))) platformLevel = level;
        }
    }
    if (platformLevel !== null) return platformLevel;
    return levels.reduce((best, level) => (Math.abs(level) < Math.abs(best) ? level : best), levels[0] ?? 0);
}

/** `[west, south, east, north]` of a plan. */
export function planBbox(features: readonly IndoorFeature[]): Bbox {
    const bbox: Bbox = [Infinity, Infinity, -Infinity, -Infinity];
    for (const feature of features) bboxOf(feature.geometry.coordinates, bbox);
    return bbox.map(round6) as Bbox;
}
