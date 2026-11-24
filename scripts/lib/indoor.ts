import { indoorCellId, type IndoorCellSummary, type IndoorFeature, type IndoorGeometry, type IndoorKind, type IndoorPosition } from './contract.ts';
import { round6 } from './geo.ts';

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

/** The centre of a geometry's bounding box, which decides the cell it is published in. */
export function anchorOf(geometry: IndoorGeometry): IndoorPosition {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const visit = (value: unknown): void => {
        if (!Array.isArray(value)) return;
        if (typeof value[0] === 'number') {
            const [x, y] = value as IndoorPosition;
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
            return;
        }
        for (const child of value) visit(child);
    };
    visit(geometry.coordinates);
    return [(minX + maxX) / 2, (minY + maxY) / 2];
}

export interface IndoorCellOptions {
    cell: number;
    /** Cells this many steps around a station's cell are kept too. */
    stationReach: number;
    minFeatures: number;
    /** A cell on fewer floors is plain street-level tagging, not an indoor map. */
    minLevels: number;
}

/** The cells worth publishing: near a station, with enough features on enough floors. */
export function indoorCells(
    features: Iterable<IndoorFeature>,
    stations: Iterable<IndoorPosition>,
    options: IndoorCellOptions,
): Map<string, IndoorFeature[]> {
    const near = new Set<string>();
    for (const [lon, lat] of stations) {
        const x = Math.floor(lon / options.cell);
        const y = Math.floor(lat / options.cell);
        for (let dx = -options.stationReach; dx <= options.stationReach; dx++) {
            for (let dy = -options.stationReach; dy <= options.stationReach; dy++) near.add(`${x + dx}_${y + dy}`);
        }
    }
    const byCell = new Map<string, IndoorFeature[]>();
    for (const feature of features) {
        const [lon, lat] = anchorOf(feature.geometry);
        const id = indoorCellId(lon, lat, options.cell);
        if (!near.has(id)) continue;
        const cell = byCell.get(id);
        if (cell) cell.push(feature);
        else byCell.set(id, [feature]);
    }
    for (const [id, cellFeatures] of byCell) {
        if (cellFeatures.length < options.minFeatures || summarizeCell(cellFeatures).levels.length < options.minLevels) byCell.delete(id);
    }
    return byCell;
}

export function summarizeCell(features: readonly IndoorFeature[]): IndoorCellSummary {
    const levels = new Set<number>();
    for (const feature of features) for (const level of feature.properties.lv) levels.add(level);
    return { levels: [...levels].sort((a, b) => a - b), n: features.length };
}
