import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { IndoorFeature, IndoorPosition } from './contract.ts';
import { groupStations, indoorKind, isStreetPlatform, parseLevels, planLevels, stationPlans, toIndoorFeature, type IndoorStation, type OsmFeature } from './indoor.ts';

const point = (tags: Record<string, string>, coordinates: IndoorPosition = [14.4351234567, 50.0831234567]): OsmFeature =>
    ({ type: 'Feature', geometry: { type: 'Point', coordinates }, properties: tags });

const line = (tags: Record<string, string>): OsmFeature =>
    ({ type: 'Feature', geometry: { type: 'LineString', coordinates: [[14.435, 50.083], [14.436, 50.083]] }, properties: tags });

const feature = (lon: number, lat: number, lv: number[]): IndoorFeature => ({
    type: 'Feature',
    geometry: { type: 'Polygon', coordinates: [[[lon, lat], [lon + 0.0001, lat], [lon, lat + 0.0001], [lon, lat]]] },
    properties: { k: 'room', lv },
});

const stairs = (lon: number, lat: number, lv: number[]): IndoorFeature =>
    ({ type: 'Feature', geometry: { type: 'LineString', coordinates: [[lon, lat], [lon + 0.0001, lat]] }, properties: { k: 'steps', lv } });


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
        assert.deepEqual(toIndoorFeature(point({ entrance: 'main', level: '-2;0', name: 'Vstup Wilsonova', ref: 'E1', operator: 'DPP' }), 10), {
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [14.435123, 50.083123] },
            properties: { k: 'entrance', lv: [-2, 0], name: 'Vstup Wilsonova', ref: 'E1' },
        });
    });

    it('turns closed rooms into polygons but leaves closed footways as lines', () => {
        const ring: IndoorPosition[] = [[14.435, 50.083], [14.436, 50.083], [14.436, 50.084], [14.435, 50.083]];
        const closed = (tags: Record<string, string>): OsmFeature => ({ type: 'Feature', geometry: { type: 'LineString', coordinates: ring }, properties: tags });
        assert.deepEqual(toIndoorFeature(closed({ indoor: 'room', level: '0' }), 10)?.geometry, { type: 'Polygon', coordinates: [ring] });
        assert.equal(toIndoorFeature(closed({ highway: 'footway', level: '0' }), 10)?.geometry.type, 'LineString');
    });

    it('keeps shop names', () => {
        assert.deepEqual(toIndoorFeature(point({ shop: 'bakery', level: '-1', name: 'Paul', brand: 'Paul' }), 10)?.properties, { k: 'shop', lv: [-1], name: 'Paul' });
    });

    it('takes repeat_on when level is missing', () => {
        assert.deepEqual(toIndoorFeature(line({ indoor: 'wall', repeat_on: '1;2' }), 10)?.properties.lv, [1, 2]);
    });

    // Most stairs and tram platforms in OSM name no level; they are on street level.
    it('puts an object without a level on street level, and drops an unreadable level', () => {
        assert.deepEqual(toIndoorFeature(line({ railway: 'platform' }), 10)?.properties.lv, [0]);
        assert.equal(toIndoorFeature(line({ highway: 'steps', level: 'x' }), 10), null);
    });
});

describe('groupStations', () => {
    // PID's Hlavní nádraží metro (U142-1) and trains (U142-301) are one node and get one plan.
    it('merges the stations of one node under the lowest id', () => {
        const stations: IndoorStation[] = [
            { id: 'U142-301', name: 'Praha hlavní nádraží', node: 'U142', points: [[14.4380, 50.0830]] },
            { id: 'U142-1', name: 'Hlavní nádraží', node: 'U142', points: [[14.4352, 50.0832]] },
            { id: 'U1072-101', name: 'Můstek', node: 'U1072', points: [[14.4243, 50.0835]] },
        ];
        assert.deepEqual(groupStations(stations).map(g => [g.id, g.points.length]).sort(), [['U1072-101', 1], ['U142-1', 2]]);
    });
});

describe('stationPlans', () => {
    const mustek: IndoorStation = { id: 'mustek', name: 'Můstek', node: 'mustek', points: [[14.4243, 50.0835]] };
    const other: IndoorStation = { id: 'other', name: 'Other', node: 'other', points: [[14.4285, 50.0835]] };

    it('gives each object to the nearest station', () => {
        const plans = stationPlans([feature(14.4255, 50.0835, [-3]), stairs(14.4274, 50.0835, [-2])], [mustek, other], 300);
        assert.deepEqual(plans.get('mustek')?.map(f => f.properties.lv), [[-3]]);
        assert.deepEqual(plans.get('other')?.map(f => f.properties.lv), [[-2]]);
    });

    it('leaves out objects beyond the radius', () => {
        assert.equal(stationPlans([feature(14.4300, 50.0900, [0])], [mustek], 300).size, 0);
    });
});

describe('planLevels', () => {
    it('lists every floor of the plan, ascending', () => {
        assert.deepEqual(planLevels([feature(14.4351, 50.0831, [0]), stairs(14.4353, 50.0831, [-2, -1])]), [-2, -1, 0]);
    });
});

describe('isStreetPlatform', () => {
    const platform = (lv: number[], type: 'LineString' | 'Point' = 'LineString'): IndoorFeature => ({
        type: 'Feature',
        geometry: type === 'Point' ? { type, coordinates: [14.43, 50.08] } : { type, coordinates: [[14.43, 50.08], [14.44, 50.08]] },
        properties: { k: 'platform', lv },
    });

    // Tram and train platforms on the street go to the platforms layer, metro platforms stay in floor plans: drawn once.
    it('takes platforms on street level only', () => {
        assert.equal(isStreetPlatform(platform([0])), true);
        assert.equal(isStreetPlatform(platform([-2])), false);
        assert.equal(isStreetPlatform(platform([0, 1])), false);
        assert.equal(isStreetPlatform(platform([0], 'Point')), false);
        assert.equal(isStreetPlatform(stairs(14.43, 50.08, [0])), false);
    });
});
