import assert from 'assert';
import { getStonesInPlayOrder, isLastStoneOwn } from '../mohex-cli/Mohex';
import { StandardizedPosition } from '../../shared/StandardizedPosition';

describe('Mohex', () => {
    describe('getStonesInPlayOrder()', () => {
        const playOrder = (movesHistory: string): string => getStonesInPlayOrder(StandardizedPosition.fromMovesHistory(movesHistory))
            .map(({ color, cell }) => `${color[0]}:${cell}`)
            .join(' ')
        ;

        it('returns nothing on empty position', () => {
            assert.strictEqual(playOrder(''), '');
        });

        it('keeps game order without swap', () => {
            assert.strictEqual(playOrder('a1 b2 c3'), 'b:a1 w:b2 b:c3');
            assert.strictEqual(playOrder('a1 b2 c3 d4'), 'b:a1 w:b2 b:c3 w:d4');
        });

        it('ends with opponent stone when white to play after a swap', () => {
            assert.strictEqual(playOrder('a13 swap-pieces d10'), 'w:m1 b:d10');
            assert.strictEqual(playOrder('a13 swap-pieces d10 l3 g7'), 'w:m1 b:d10 w:l3 b:g7');
        });

        it('ends with opponent stone when black to play after a swap', () => {
            assert.strictEqual(playOrder('a13 swap-pieces'), 'w:m1');
            assert.strictEqual(playOrder('a13 swap-pieces d10 l3'), 'w:m1 b:d10 w:l3');
        });

        it('ends with most recent opponent stone when opponent passed', () => {
            assert.strictEqual(playOrder('a1 b2 c3 pass'), 'b:a1 b:c3 w:b2');
        });

        it('ends with current player stone when opponent has no stone', () => {
            assert.strictEqual(playOrder('a1 pass b2 pass'), 'b:a1 b:b2');
        });
    });

    describe('isLastStoneOwn()', () => {
        const isOwn = (movesHistory: string): boolean => isLastStoneOwn(StandardizedPosition.fromMovesHistory(movesHistory));

        it('is false on empty board', () => {
            assert.strictEqual(isOwn(''), false);
        });

        it('is false when opponent has a stone', () => {
            assert.strictEqual(isOwn('a1'), false);
            assert.strictEqual(isOwn('a1 b2'), false);
            assert.strictEqual(isOwn('a13 swap-pieces d10'), false);
            assert.strictEqual(isOwn('a1 b2 c3 pass'), false);
        });

        it('is true when only current player has stones', () => {
            assert.strictEqual(isOwn('a1 pass'), true);
            assert.strictEqual(isOwn('a1 pass b2 pass'), true);
        });
    });
});
