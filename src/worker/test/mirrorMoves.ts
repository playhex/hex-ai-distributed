import { removeSwap, rawMovesFromHistory, toKatahexPosition } from '../mirrorMoves';
import assert from 'assert';

describe('mirrorMoves', () => {
    describe('removeSwap', () => {
        it('does nothing if no swap move', () => {
            assert.deepStrictEqual(removeSwap('a2 b3 c4 d5'), {
                mirrored: false,
                swapped: false,
                moves: 'a2 b3 c4 d5',
            });

            assert.deepStrictEqual(removeSwap('a2 b3 c4 d5 e6'), {
                mirrored: false,
                swapped: false,
                moves: 'a2 b3 c4 d5 e6',
            });
        });

        it('remove swap move and mirror', () => {
            assert.deepStrictEqual(removeSwap('a2 swap-pieces c4 d5'), {
                mirrored: true,
                swapped: true,
                moves: 'a2 d3 e4',
            });

            assert.deepStrictEqual(removeSwap('a2 swap-pieces c4 d5 e6'), {
                mirrored: true,
                swapped: true,
                moves: 'a2 d3 e4 f5',
            });
        });
    });

    describe('toKatahexPosition', () => {
        it('makes katahex always plays as black', () => {
            assert.strictEqual(
                toKatahexPosition({
                    moves: 'a2',
                    swapped: false,
                    mirrored: false,
                }),
                'white b1',
            );

            assert.strictEqual(
                toKatahexPosition({
                    moves: 'a2 b3',
                    swapped: false,
                    mirrored: false,
                }),
                'black a2 white b3',
            );

            assert.strictEqual(
                toKatahexPosition({
                    moves: 'a2 b3 c4',
                    swapped: false,
                    mirrored: false,
                }),
                'white b1 black c2 white d3',
            );
        });

        it('makes katahex always plays as black, with swap', () => {
            assert.strictEqual(
                toKatahexPosition({
                    moves: 'a2',
                    swapped: true,
                    mirrored: true,
                }),
                'white b1',
            );

            assert.strictEqual(
                toKatahexPosition({
                    moves: 'a2 b3',
                    swapped: true,
                    mirrored: true,
                }),
                'black a2 white b3',
            );

            assert.strictEqual(
                toKatahexPosition({
                    moves: 'a2 b3 c4',
                    swapped: true,
                    mirrored: true,
                }),
                'white b1 black c2 white d3',
            );
        });
    });

    describe('splitMoves', () => {
        it('split moves', () => {
            assert.deepStrictEqual(
                rawMovesFromHistory('a1 b2 c3 d4'),
                {
                    black: ['a1', 'c3'],
                    white: ['b2', 'd4'],
                }
            );

            assert.deepStrictEqual(
                rawMovesFromHistory('a1 b2 c3 d4 e5'),
                {
                    black: ['a1', 'c3', 'e5'],
                    white: ['b2', 'd4'],
                }
            );
        });

        it('split moves, mirror and remove swap', () => {
            assert.deepStrictEqual(
                rawMovesFromHistory('a2 swap-pieces'),
                {
                    black: [],
                    white: ['b1'],
                }
            );

            assert.deepStrictEqual(
                rawMovesFromHistory('a2 swap-pieces c4'),
                {
                    black: ['c4'],
                    white: ['b1'],
                }
            );

            assert.deepStrictEqual(
                rawMovesFromHistory('b1 swap-pieces c4 d5 e6 f7'),
                {
                    black: ['c4', 'e6'],
                    white: ['a2', 'd5', 'f7'],
                }
            );
        });
    });
});