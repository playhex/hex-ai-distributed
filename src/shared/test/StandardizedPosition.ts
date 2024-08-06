import { StandardizedPosition } from '../StandardizedPosition';
import assert from 'assert';

describe('StandardizedPosition', () => {
    describe('fromMovesHistory()', () => {
        it('creates basic position', () => {
            const position = StandardizedPosition.fromMovesHistory('a2 b3');

            assert.strictEqual(position.blackCells.join(' '), 'a2');
            assert.strictEqual(position.whiteCells.join(' '), 'b3');
            assert.strictEqual(position.swapStillAllowed, false);
            assert.strictEqual(position.mirrored, false);
            assert.strictEqual(position.currentPlayer, 'black');
        });

        it('creates position with swap move', () => {
            const position = StandardizedPosition.fromMovesHistory('a2 swap-pieces');

            assert.strictEqual(position.blackCells.join(' '), '');
            assert.strictEqual(position.whiteCells.join(' '), 'b1');
            assert.strictEqual(position.swapStillAllowed, false);
            assert.strictEqual(position.mirrored, false);
            assert.strictEqual(position.currentPlayer, 'black');
        });

        it('creates position mirrored to make black to play', () => {
            const position = StandardizedPosition.fromMovesHistory('a2');

            position.setBlackToPlay();

            assert.strictEqual(position.blackCells.join(' '), '');
            assert.strictEqual(position.whiteCells.join(' '), 'b1');
            assert.strictEqual(position.swapStillAllowed, true);
            assert.strictEqual(position.mirrored, true);
            assert.strictEqual(position.currentPlayer, 'black');
        });

        it('creates position with pass move', () => {
            const position = StandardizedPosition.fromMovesHistory('pass a2');

            assert.strictEqual(position.blackCells.join(' '), '');
            assert.strictEqual(position.whiteCells.join(' '), 'a2');
            assert.strictEqual(position.swapStillAllowed, false);
            assert.strictEqual(position.mirrored, false);
            assert.strictEqual(position.currentPlayer, 'black');
        });

        it('creates position with pass moves from both players', () => {
            const position = StandardizedPosition.fromMovesHistory('pass pass a2 b3');

            assert.strictEqual(position.blackCells.join(' '), 'a2');
            assert.strictEqual(position.whiteCells.join(' '), 'b3');
            assert.strictEqual(position.swapStillAllowed, false);
            assert.strictEqual(position.mirrored, false);
            assert.strictEqual(position.currentPlayer, 'black');
        });

        it('creates position with pass move', () => {
            const position = StandardizedPosition.fromMovesHistory('pass a2 b3');

            assert.strictEqual(position.blackCells.join(' '), 'b3');
            assert.strictEqual(position.whiteCells.join(' '), 'a2');
            assert.strictEqual(position.swapStillAllowed, false);
            assert.strictEqual(position.mirrored, false);
            assert.strictEqual(position.currentPlayer, 'white');
        });

        it('creates position with swap, pass, and call setBlackToPlay()', () => {
            const position = StandardizedPosition.fromMovesHistory('a2 swap-pieces pass b3 c4');

            position.setBlackToPlay();

            assert.strictEqual(position.blackCells.join(' '), 'a2 c2');
            assert.strictEqual(position.whiteCells.join(' '), 'd3');
            assert.strictEqual(position.swapStillAllowed, false);
            assert.strictEqual(position.mirrored, true);
            assert.strictEqual(position.currentPlayer, 'black');
        });

        it('returns swapStillAllowed = false when there is a single pass move dropped after standardization', () => {
            const position = StandardizedPosition.fromMovesHistory('pass');

            assert.strictEqual(position.blackCells.join(' '), '');
            assert.strictEqual(position.whiteCells.join(' '), '');
            assert.strictEqual(position.swapStillAllowed, false);
            assert.strictEqual(position.mirrored, false);
            assert.strictEqual(position.currentPlayer, 'white');
        });

        it('returns swapStillAllowed = false when there was pass moves dropped after standardization', () => {
            const position = StandardizedPosition.fromMovesHistory('pass a2 pass');

            assert.strictEqual(position.blackCells.join(' '), '');
            assert.strictEqual(position.whiteCells.join(' '), 'a2');
            assert.strictEqual(position.swapStillAllowed, false);
            assert.strictEqual(position.mirrored, false);
            assert.strictEqual(position.currentPlayer, 'white');
        });

        it('creates empty position', () => {
            const position = StandardizedPosition.fromMovesHistory('');

            assert.strictEqual(position.blackCells.length, 0);
            assert.strictEqual(position.whiteCells.length, 0);
            assert.strictEqual(position.swapStillAllowed, true);
            assert.strictEqual(position.mirrored, false);
            assert.strictEqual(position.currentPlayer, 'black');
        });
    });
});
