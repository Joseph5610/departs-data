import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { railLineName, railTripId, trainTrips, type TrainRun } from './rail.ts';
import type { ServiceDay } from './time.ts';

const day = (str: string, midnight: number): ServiceDay => ({ str, midnight, weekday: 4, isHoliday: false });
const MON = day('20261123', 1);
const TUE = day('20261124', 2);

const run = (numbers: string[], dates: ServiceDay[], times: [string, number][]): TrainRun => ({
    numbers,
    dates,
    calls: times.map(([stationId, at]) => ({ stationId, arrival: at, departure: at })),
});

describe('railTripId', () => {
    it('puts the train numbers where a CIS JŘ trip id has its spoj', () => {
        assert.equal(railTripId(['6414'], 1), '6414-rail-1');
        assert.equal(railTripId(['6414', '16414'], 2), '6414_16414-rail-2');
    });
});

describe('trainTrips', () => {
    it('merges identical runs of one train into one trip on all their days', () => {
        const trips = trainTrips([
            run(['6414'], [MON], [['A', 600], ['B', 630]]),
            run(['6414'], [TUE], [['A', 600], ['B', 630]]),
        ]);
        assert.deepEqual([...trips.keys()], ['6414-rail-1']);
        assert.deepEqual(trips.get('6414-rail-1')!.dates.map(d => d.str), ['20261123', '20261124']);
    });

    it('numbers the different runs of one train by first departure', () => {
        const trips = trainTrips([
            run(['6414'], [TUE], [['A', 700], ['B', 730]]),
            run(['6414'], [MON], [['A', 600], ['B', 630]]),
        ]);
        assert.equal(trips.get('6414-rail-1')!.calls[0]!.departure, 600);
        assert.equal(trips.get('6414-rail-2')!.calls[0]!.departure, 700);
    });

    it('leaves out runs with fewer than two calls', () => {
        assert.equal(trainTrips([run(['1'], [MON], [['A', 600]])]).size, 0);
    });
});

describe('railLineName', () => {
    it('prefers the DÚK line of several networks', () => {
        assert.equal(railLineName('S4/S43/U4'), 'U4');
        assert.equal(railLineName('S32/U32'), 'U32');
    });

    it('keeps the first line, without the train name, where none is DÚK\'s', () => {
        assert.equal(railLineName('Ex5/Ex3 Hungaria'), 'Ex5');
        assert.equal(railLineName('R15 Krušnohor'), 'R15');
        assert.equal(railLineName('R45/S50/S57'), 'R45');
    });
});
