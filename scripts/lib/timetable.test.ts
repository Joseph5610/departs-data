import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { ServiceDay } from './time.ts';
import { buildDepartures, gtfsWindow, tripWindows, type ActiveTrip, type Call } from './timetable.ts';

const MON: ServiceDay = { str: '20261019', midnight: Date.parse('2026-10-18T22:00:00Z'), weekday: 1, isHoliday: false };
const TUE: ServiceDay = { str: '20261020', midnight: Date.parse('2026-10-19T22:00:00Z'), weekday: 2, isHoliday: false };

const trip = (dates: ServiceDay[] = [MON]): ActiveTrip =>
    ({ routeId: 'L1', headsign: 'Centrum', serviceId: 'S', wheelchair: 1, directionId: 0, shapeId: null, dates });

const call = (stopId: string, arrival: string, departure: string, sequence: number): Call =>
    ({ tripId: 't1', stopId, arrival, departure, sequence, isRequestStop: false, boards: true, stopHeadsign: '' });

describe('gtfsWindow', () => {
    // KORDIS times a terminus layover as the last stop's departure; a vehicle laying over still runs the trip it arrived on.
    it('ends a trip when it leaves its last stop, layover included', () => {
        const w = gtfsWindow(trip(), [call('A', '', '6:33:00', 1), call('B', '6:56:00', '7:01:00', 2)]);
        assert.deepEqual([w.startMin, w.endMin], [393, 421]);
    });
});

describe('tripWindows', () => {
    it('flags each trip\'s days over the published days and appends a network column when asked', () => {
        const file = tripWindows([['t1', { dates: [TUE], startMin: 10, endMin: 20 }]], [MON, TUE], () => 1);
        assert.deepEqual(file, { days: ['20261019', '20261020'], trips: { t1: [10, 20, 2, 1] } });
    });
});

describe('buildDepartures', () => {
    // A board lists every day a trip runs; same-minute departures keep the order they were given in.
    it('writes one row per boarding and day, with its stop headsign and extras', () => {
        const rows = buildDepartures(
            [{ tripId: 't1', stopId: 'A', offsetMs: 60_000, isRequestStop: true, headsign: 'Nádraží' }, { tripId: 't2', stopId: 'A', offsetMs: 60_000, isRequestStop: false }],
            id => (id === 't1' ? trip([MON, TUE]) : trip()),
            (b, day) => (b.tripId === 't2' ? { feeders: [['f', 'L2', day.midnight, 60, 120]] } : undefined),
        );
        assert.deepEqual(rows.get('A'), [
            ['t1', 'L1', 'Nádraží', MON.midnight + 60_000, 1, 1],
            ['t1', 'L1', 'Nádraží', TUE.midnight + 60_000, 1, 1],
            ['t2', 'L1', 'Centrum', MON.midnight + 60_000, 1, 0, { feeders: [['f', 'L2', MON.midnight, 60, 120]] }],
        ]);
    });
});
