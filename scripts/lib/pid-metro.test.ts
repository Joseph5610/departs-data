import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildMetroExits, exitName, type MetroPathway, type MetroStop } from './pid-metro.ts';

const stop = (stop_id: string, stop_name: string, location_type: number, parent_station: string | null = 'S'): MetroStop =>
    ({ stop_id, stop_name, location_type, parent_station });
const walk = (from: string, to: string, seconds: number, mode = '1', sign: string | null = null): MetroPathway =>
    ({ from, to, mode, bidirectional: true, seconds, sign, reversedSign: null });

// One platform P with areas at cars 1 and 5; E1 by car 1 up stairs, E2 by car 5 by lift and corridor.
const stops = [
    stop('P', 'Station', 0),
    stop('B1', 'Kolej 1 - Start', 4, 'P'),
    stop('B5', 'Kolej 1 - End', 4, 'P'),
    stop('E1', 'E1', 2),
    stop('E2', '(ul. Dlouhá)', 2),
    stop('N', '', 3),
];
const withStop = (replacement: MetroStop) => stops.map(s => (s.stop_id === replacement.stop_id ? replacement : s));

describe('buildMetroExits', () => {
    it('gives each car the exit nearest to it, with the signposted destination', () => {
        const pathways = [
            walk('B1', 'E1', 40, '2', 'E1 TRAM Centrum'),
            walk('B5', 'N', 20, '5'),
            walk('N', 'E2', 20),
            walk('B1', 'B5', 60),
        ];
        assert.deepEqual(buildMetroExits(stops, pathways, [[1, 'B1'], [5, 'B5']]), {
            P: { exits: [['E1', 'TRAM Centrum', [1]], ['ul. Dlouhá', null, [5]]], stepFree: ['ul. Dlouhá', [5]] },
        });
    });

    it('merges entrances PID maps separately under one exit name', () => {
        const twin = [...stops, stop('E1b', 'E1', 2)];
        const pathways = [walk('B1', 'E1', 10), walk('B5', 'E1b', 10)];
        assert.deepEqual(buildMetroExits(twin, pathways, [[1, 'B1'], [5, 'B5']]).P?.exits, [['E1', null, [1, 5]]]);
    });

    it('routes the step-free way around stairs and escalators', () => {
        const pathways = [walk('B1', 'E1', 10, '4'), walk('B1', 'B5', 30), walk('B5', 'E2', 30, '5')];
        assert.deepEqual(buildMetroExits(stops, pathways, [[1, 'B1']]).P?.stepFree, ['ul. Dlouhá', [1]]);
    });

    it('lists for the step-free exit only cars whose own step-free way leads there', () => {
        const pathways = [walk('B1', 'E1', 20), walk('B5', 'E2', 25)];
        assert.deepEqual(buildMetroExits(stops, pathways, [[1, 'B1'], [5, 'B5']]).P?.stepFree, ['E1', [1]]);
    });

    it('leaves out a car that reaches the lift only by walking along the platform from another car', () => {
        // Only the car 1 end has a lift (to E2); the car 5 end has stairs only (to E1).
        const pathways = [walk('B1', 'B5', 15), walk('B1', 'E2', 110, '5'), walk('B5', 'E1', 30, '2')];
        assert.deepEqual(buildMetroExits(stops, pathways, [[1, 'B1'], [5, 'B5']]).P?.stepFree, ['ul. Dlouhá', [1]]);
    });

    it('skips a platform whose only way out has no public name', () => {
        assert.deepEqual(buildMetroExits(withStop(stop('E1', '(-)', 2)), [walk('B1', 'E1', 10)], [[1, 'B1']]), {});
    });
});

describe('exitName', () => {
    it('unwraps a bracketed street name and drops the unnamed marker', () => {
        assert.equal(exitName('(ul. Nádražní)'), 'ul. Nádražní');
        assert.equal(exitName('(-)'), null);
    });
});
