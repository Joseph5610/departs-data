import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { TripStop } from './contract.ts';
import { shapePatterns } from './pfaedle.ts';

const stop = (lat?: number, lon?: number): TripStop => ({ stop_id: '', name: '', arrival_time: '', departure_time: '', lat, lon, is_passed: false, zone_id: null, is_request_stop: false });

describe('shapePatterns', () => {
    // A shape is drawn once per run of located stops and mode, whatever the trip.
    it('shares one shape among trips of the same mode running the same located stops', () => {
        const { patterns, tripShapes } = shapePatterns(new Map([
            ['a', [stop(50.1, 14.1), stop(), stop(50.2, 14.2)]],
            ['b', [stop(50.1, 14.1), stop(50.2, 14.2)]],
            ['c', [stop(50.1, 14.1), stop(50.2, 14.2)]],
        ]), tripId => (tripId === 'c' ? '2' : '3'));
        assert.equal(tripShapes.a, tripShapes.b);
        assert.notEqual(tripShapes.a, tripShapes.c);
        assert.equal(patterns.size, 2);
        assert.deepEqual(patterns.get(tripShapes.a!)!.stops, [{ lat: 50.1, lon: 14.1 }, { lat: 50.2, lon: 14.2 }]);
    });

    it('gives a trip with fewer than two located stops no shape', () => {
        const { tripShapes } = shapePatterns(new Map([['a', [stop(50.1, 14.1), stop()]]]), () => '3');
        assert.deepEqual(tripShapes, {});
    });
});
