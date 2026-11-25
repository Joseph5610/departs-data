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

/** The indoor feature an exported OSM object becomes (on street level when it names no floor), or null when its floor is unreadable or it is not drawn indoors. */
export function toIndoorFeature(osm: OsmFeature, maxLevelSpan: number): IndoorFeature | null {
    const { geometry, properties: tags } = osm;
    if (!DRAWN_GEOMETRIES.has(geometry.type)) return null;
    const levelTag = tags.level ?? tags.repeat_on;
    // In OpenStreetMap an object without a level is on street level.
    const lv = levelTag === undefined ? [0] : parseLevels(levelTag, maxLevelSpan);
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

/** Stations of one node merged into one, named by the lowest id. */
export function groupStations(stations: readonly IndoorStation[]): IndoorStation[] {
    const byNode = new Map<string, IndoorStation>();
    for (const station of [...stations].sort((a, b) => a.id.localeCompare(b.id))) {
        const group = byNode.get(station.node);
        if (group) group.points.push(...station.points);
        else byNode.set(station.node, { ...station, points: [...station.points] });
    }
    return [...byNode.values()];
}

/** Grid size of the station point index in degrees (~360 m east-west here); `stationPlans` scans one cell around, so its radius must stay below it. */
const GRID_DEG = 0.005;

const gridKey = (lon: number, lat: number): string => `${Math.floor(lon / GRID_DEG)}_${Math.floor(lat / GRID_DEG)}`;

/** Each station's features: those whose nearest station point within `radiusM` is one of its own. */
export function stationPlans(features: Iterable<IndoorFeature>, stations: readonly IndoorStation[], radiusM: number): Map<string, IndoorFeature[]> {
    const grid = new Map<string, Array<{ pos: IndoorPosition; id: string }>>();
    for (const station of stations) {
        for (const pos of station.points) {
            const key = gridKey(pos[0], pos[1]);
            const list = grid.get(key);
            if (list) list.push({ pos, id: station.id });
            else grid.set(key, [{ pos, id: station.id }]);
        }
    }
    const plans = new Map<string, IndoorFeature[]>();
    for (const feature of features) {
        const [lon, lat] = anchorOf(feature.geometry);
        let nearest: string | null = null;
        let nearestM = radiusM;
        for (let dx = -1; dx <= 1; dx++) {
            for (let dy = -1; dy <= 1; dy++) {
                for (const point of grid.get(`${Math.floor(lon / GRID_DEG) + dx}_${Math.floor(lat / GRID_DEG) + dy}`) ?? []) {
                    const metres = distanceM({ lon, lat }, { lon: point.pos[0], lat: point.pos[1] });
                    if (metres <= nearestM) { nearest = point.id; nearestM = metres; }
                }
            }
        }
        if (nearest === null) continue;
        const plan = plans.get(nearest);
        if (plan) plan.push(feature);
        else plans.set(nearest, [feature]);
    }
    return plans;
}

/** Every floor a plan's features are on, ascending. */
export function planLevels(features: readonly IndoorFeature[]): number[] {
    const levels = new Set<number>();
    for (const feature of features) for (const level of feature.properties.lv) levels.add(level);
    return [...levels].sort((a, b) => a - b);
}

/** `[west, south, east, north]` of a plan. */
export function planBbox(features: readonly IndoorFeature[]): Bbox {
    const bbox: Bbox = [Infinity, Infinity, -Infinity, -Infinity];
    for (const feature of features) bboxOf(feature.geometry.coordinates, bbox);
    return bbox.map(round6) as Bbox;
}
