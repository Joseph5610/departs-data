import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stableStationIds } from './station-ids.ts';

const rule = (feedId: string): string => /^(U\d+)N\d+$/.exec(feedId)?.[1] ?? feedId;

test('stations the rule maps onto one id keep their feed ids', () => {
    const ids = stableStationIds({ U1N1: ['U1Z1'], U2N5: ['U2Z1'], U2N9: ['U2Z81'] }, rule);
    assert.deepEqual([...ids], [['U1N1', 'U1'], ['U2N5', 'U2N5'], ['U2N9', 'U2N9']]);
});

test('a station id taken by a platform still throws', () => {
    assert.throws(() => stableStationIds({ U1N1: ['U1'] }, rule));
});
