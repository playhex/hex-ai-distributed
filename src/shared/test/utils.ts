import { takeKataRawGoodMoves } from '../utils';
import assert from 'assert';

describe('utils', () => {
    describe('takeKataRawGoodMoves()', () => {
        it('returns only best move when others are below ratio', () => {
            const moves = takeKataRawGoodMoves([
                [0.1, 0.5],
                [0.2, 0.3],
            ], 0.9);

            assert.deepStrictEqual(moves.map(m => m.move), ['b1']);
        });

        it('returns all moves above ratio, best first', () => {
            const moves = takeKataRawGoodMoves([
                [0.29, 0.1],
                [0.3, 0.28],
            ], 0.9);

            assert.deepStrictEqual(moves.map(m => m.move), ['a2', 'a1', 'b2']);
        });

        it('ignores NaN cells', () => {
            const moves = takeKataRawGoodMoves([
                [NaN, 0.4],
                [NaN, 0.39],
            ], 0.9);

            assert.deepStrictEqual(moves.map(m => m.move), ['b1', 'b2']);
        });

        it('returns empty array when no move', () => {
            assert.deepStrictEqual(takeKataRawGoodMoves([[NaN]], 0.9), []);
        });
    });
});
