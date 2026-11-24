import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { IndoorFeature, IndoorPosition } from './contract.ts';
import { indoorCells, indoorKind, parseLevels, toIndoorFeature, type OsmFeature } from './indoor.ts';

const point = (tags: Record<string, string>, coordinates: IndoorPosition = [14.4351234567, 50.0831234567]): OsmFeature =>
    ({ type: 'Feature', geometry: { type: 'Point', coordinates }, properties: tags });

const line = (tags: Record<string, string>): OsmFeature =>
    ({ type: 'Feature', geometry: { type: 'LineString', coordinates: [[14.435, 50.083], [14.436, 50.083]] }, properties: tags });

const feature = (lon: number, lat: number, lv: number[]): IndoorFeature =>
    ({ type: 'Feature', geometry: { type: 'Point', coordinates: [lon, lat] }, properties: { k: 'shop', lv } });

const CELLS = { cell: 0.005, stationReach: 1, minFeatures: 2, minLevels: 2 };

describe('parseLevels', () => {
    it('reads lists and rounds half levels to the nearest floor', () => {
        assert.deepEqual(parseLevels('-0.7;0.3', 10), [-1, 0]);
    });

    it('expands ranges, negative ones included', () => {
        assert.deepEqual(parseLevels('-3--1', 10), [-3, -2, -1]);
        assert.deepEqual(parseLevels('0-2', 10), [0, 1, 2]);
    });

    // A range like `-2-200` is a typo, not a skyscraper; it would light up every floor of the switcher.
    it('drops ranges wider than the allowed span and unreadable parts', () => {
        assert.deepEqual(parseLevels('-2-200;1;x', 10), [1]);
    });

    it('never yields negative zero', () => {
        assert.ok(Object.is(parseLevels('-0.3', 10)[0], 0));
    });
});

describe('indoorKind', () => {
    it('tells shops, toilets and ticket machines in rooms from plain rooms', () => {
        assert.equal(indoorKind({ indoor: 'room', shop: 'bakery' }, 'Polygon'), 'shop');
        assert.equal(indoorKind({ indoor: 'room', amenity: 'toilets' }, 'Polygon'), 'toilets');
        assert.equal(indoorKind({ amenity: 'vending_machine', vending: 'drinks;public_transport_tickets' }, 'Point'), 'tickets');
        assert.equal(indoorKind({ indoor: 'room' }, 'Polygon'), 'room');
    });

    it('draws moving stairs as escalators, not steps', () => {
        assert.equal(indoorKind({ highway: 'steps', conveying: 'forward' }, 'LineString'), 'escalator');
        assert.equal(indoorKind({ highway: 'steps' }, 'LineString'), 'steps');
    });

    it('keeps outdoor-tagged paths and skips objects with no indoor meaning', () => {
        assert.equal(indoorKind({ indoor: 'no', highway: 'footway' }, 'LineString'), 'footway');
        assert.equal(indoorKind({ railway: 'crossing' }, 'Point'), null);
        assert.equal(indoorKind({ public_transport: 'platform' }, 'Point'), null);
    });
});

describe('toIndoorFeature', () => {
    it('keeps the kind, floors, name and ref with coordinates rounded to 6 decimals', () => {
        assert.deepEqual(toIndoorFeature(point({ highway: 'elevator', level: '-2;0', name: 'Výtah', ref: 'V1', operator: 'DPP' }), 10), {
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [14.435123, 50.083123] },
            properties: { k: 'elevator', lv: [-2, 0], name: 'Výtah', ref: 'V1' },
        });
    });

    it('turns closed rooms into polygons but leaves closed footways as lines', () => {
        const ring: IndoorPosition[] = [[14.435, 50.083], [14.436, 50.083], [14.436, 50.084], [14.435, 50.083]];
        const closed = (tags: Record<string, string>): OsmFeature => ({ type: 'Feature', geometry: { type: 'LineString', coordinates: ring }, properties: tags });
        assert.deepEqual(toIndoorFeature(closed({ indoor: 'room', level: '0' }), 10)?.geometry, { type: 'Polygon', coordinates: [ring] });
        assert.equal(toIndoorFeature(closed({ highway: 'footway', level: '0' }), 10)?.geometry.type, 'LineString');
    });

    it('leaves business names out of shops', () => {
        assert.deepEqual(toIndoorFeature(point({ shop: 'bakery', level: '-1', name: 'Paul', brand: 'Paul' }), 10)?.properties, { k: 'shop', lv: [-1] });
    });

    it('takes repeat_on when level is missing and drops objects on no floor', () => {
        assert.deepEqual(toIndoorFeature(line({ indoor: 'wall', repeat_on: '1;2' }), 10)?.properties.lv, [1, 2]);
        assert.equal(toIndoorFeature(line({ highway: 'footway' }), 10), null);
    });
});

describe('indoorCells', () => {
    const station: IndoorPosition = [14.4352, 50.0832];

    it('keeps multi-floor cells around a station', () => {
        const cells = indoorCells([feature(14.4351, 50.0831, [0]), feature(14.4353, 50.0833, [-1])], [station], CELLS);
        assert.deepEqual([...cells.keys()], ['2887_10016']);
    });

    it('leaves out cells far from any station', () => {
        assert.equal(indoorCells([feature(14.5, 50.0831, [0]), feature(14.5, 50.0833, [-1])], [station], CELLS).size, 0);
    });

    // Street-level shops tagged level=0 are not an indoor map; only a cell spanning floors gets a level switcher.
    it('leaves out cells on a single floor or with too few features', () => {
        assert.equal(indoorCells([feature(14.4351, 50.0831, [0]), feature(14.4353, 50.0833, [0])], [station], CELLS).size, 0);
        assert.equal(indoorCells([feature(14.4351, 50.0831, [0, -1])], [station], CELLS).size, 0);
    });
});
