import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildMetroExits, exitName, signText, type MetroPathway, type MetroStop } from './pid-metro.ts';

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

    it('routes the step-free way around stairs and escalators, at the car where the lift leaves', () => {
        const pathways = [walk('B1', 'E1', 10, '4'), walk('B1', 'B5', 30), walk('B5', 'E2', 30, '5')];
        assert.deepEqual(buildMetroExits(stops, pathways, [[1, 'B1'], [5, 'B5']]).P?.stepFree, ['ul. Dlouhá', [5]]);
    });

    it('names only the car at the escalator when every car walks to it', () => {
        // Like Florenc B: one escalator up, at car 5's section; car 1 walks along the platform to it.
        const pathways = [walk('B1', 'B5', 15), walk('B5', 'E1', 40, '4')];
        assert.deepEqual(buildMetroExits(stops, pathways, [[1, 'B1'], [5, 'B5']]).P?.exits, [['E1', null, [5]]]);
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

    it('never credits a track with the stairs of the other track across an island platform', () => {
        // Track 2's car 1 stands across from track 1's car 5, and only that side has a way up.
        const island = [...stops, stop('Q', 'Station', 0), stop('C1', 'Kolej 2 - Start', 4, 'Q')];
        const pathways = [walk('C1', 'B5', 5), walk('B5', 'E2', 60, '5')];
        assert.equal(buildMetroExits(island, pathways, [[5, 'B5'], [1, 'C1']]).Q, undefined);
    });

    it('lists the far exit too, and leaves out a corridor signposted as a transfer', () => {
        const pathways = [walk('B1', 'E1', 30), walk('B5', 'E2', 90), walk('B1', 'N', 5, '1', 'Přestup C, Transfer C'), walk('N', 'E2', 5)];
        assert.deepEqual(buildMetroExits(stops, pathways, [[1, 'B1'], [5, 'B5']]).P?.exits, [['E1', null, [1]], ['ul. Dlouhá', null, [5]]]);
    });

    it('shows the sign at the stairs on the platform before the one at the exit', () => {
        const pathways = [walk('B1', 'N', 10, '4', 'E1 - E2 náměstí OSN'), walk('N', 'E1', 10, '1', 'E1 ulice Freyova')];
        assert.deepEqual(buildMetroExits(stops, pathways, [[1, 'B1']]).P?.exits, [['E1', 'náměstí OSN', [1]]]);
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

describe('signText', () => {
    it('keeps the destination and drops exit codes, transfers, bare exits and levels', () => {
        assert.equal(signText('E1 - E2 náměstí OSN, NC Fénix'), 'náměstí OSN, NC Fénix');
        assert.equal(signText('E1, ulice Mukařovského'), 'ulice Mukařovského');
        assert.equal(signText('Přestup B, Transfer B'), null);
        assert.equal(signText('Výstup, Exit'), null);
        assert.equal(signText('E5 -1'), null);
    });
});
