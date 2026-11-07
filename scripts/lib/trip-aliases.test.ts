import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { aliasGenerations, mergedAliases, type CourseGeneration } from './trip-aliases.ts';

const currentByCourse = new Map([['1/1', '10'], ['1/2', '11'], ['2/1', '12']]);

describe('aliasGenerations', () => {
    // KORDIS's realtime feed can lag more than one export behind, so each older export keeps its own reading.
    it('maps every older export onto the current trips by run, newest first', () => {
        const older: CourseGeneration[] = [{ '5': '1/1', '6': '1/2' }, { '5': '2/1', '7': '1/1' }];
        assert.deepEqual(aliasGenerations(older, currentByCourse), [{ '5': '10', '6': '11' }, { '5': '12', '7': '10' }]);
    });

    it('leaves out ids that resolve to themselves and runs the current export dropped', () => {
        assert.deepEqual(aliasGenerations([{ '10': '1/1', '8': '9/9' }], currentByCourse), [{}]);
    });
});

describe('mergedAliases', () => {
    it('keeps the newest redirect of an id', () => {
        assert.deepEqual(mergedAliases([{ '5': '10' }, { '5': '12', '7': '10' }]), { '5': '10', '7': '10' });
    });
});
