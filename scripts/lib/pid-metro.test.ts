import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildMetroExits, exitName, type MetroPathway, type MetroStop } from './pid-metro.ts';

const stop = (name: string, type: string, parent = 'S'): MetroStop => ({ name, type, parent });
const walk = (from: string, to: string, seconds: number, mode = '1', sign: string | null = null): MetroPathway =>
    ({ from, to, mode, bidirectional: true, seconds, sign, reversedSign: null });

// One platform P with areas at cars 1 and 5; E1 by car 1 up stairs, E2 by car 5 by lift and corridor.
const stops = new Map<string, MetroStop>([
    ['P', stop('Station', '0')],
    ['B1', stop('Kolej 1 - Start', '4', 'P')],
    ['B5', stop('Kolej 1 - End', '4', 'P')],
    ['E1', stop('E1', '2')],
    ['E2', stop('(ul. Dlouhá)', '2')],
    ['N', stop('', '3')],
]);

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

    it('routes the step-free way around stairs and escalators', () => {
        const pathways = [walk('B1', 'E1', 10, '4'), walk('B1', 'B5', 30), walk('B5', 'E2', 30, '5')];
        assert.deepEqual(buildMetroExits(stops, pathways, [[1, 'B1']]).P?.stepFree, ['ul. Dlouhá', [1]]);
    });

    it('skips a platform whose only way out has no public name', () => {
        const unnamed = new Map(stops).set('E1', stop('(-)', '2'));
        assert.deepEqual(buildMetroExits(unnamed, [walk('B1', 'E1', 10)], [[1, 'B1']]), {});
    });
});

describe('exitName', () => {
    it('unwraps a bracketed street name and drops the unnamed marker', () => {
        assert.equal(exitName('(ul. Nádražní)'), 'ul. Nádražní');
        assert.equal(exitName('(-)'), null);
    });
});
