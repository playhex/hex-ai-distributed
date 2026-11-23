import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as ort from 'onnxruntime-web';
import { describe, expect, it } from 'vitest';
import HexBoard, { BLACK, WHITE } from '../../mcts/HexBoard';
import { OnnxEvaluator } from '../../mcts/Evaluator';
import { rawNnFixtures } from '../../mcts/test/fixtures';

/*
 * Requires model converted with model-conversion/, else skipped.
 */
const modelPath = fileURLToPath(new URL('../../model-conversion/out/hex27x3.onnx', import.meta.url));

describe.skipIf(!existsSync(modelPath))('OnnxEvaluator', () => {
    it.each([
        { symmetry: 0, random: 0 },
        { symmetry: 1, random: 0.9 },
    ])('gives same policy and win rate as katahex kata-raw-nn, with symmetry $symmetry', async ({ symmetry, random }) => {
        const tolerance = 2e-3;

        ort.env.wasm.numThreads = 1;
        const session = await ort.InferenceSession.create(readFileSync(modelPath));

        {
            // Policy temperature 1, like katahex raw nn
            const evaluator = new OnnxEvaluator(session, ort.Tensor, 1, () => random);

            for (const fixture of rawNnFixtures.filter(f => f.size <= 11)) {
                const board = new HexBoard(fixture.size);
                fixture.black.forEach(([x, y]) => board.play(board.index(x, y), BLACK));
                fixture.white.forEach(([x, y]) => board.play(board.index(x, y), WHITE));

                const player = fixture.whiteToPlay ? WHITE : BLACK;
                const moves = board.legalMoves();
                const [evaluation] = await evaluator.evaluate([{ board, player, moves }]);

                moves.forEach((move, i) => {
                    const x = move % fixture.size;
                    const y = (move - x) / fixture.size;

                    const expected = symmetry === 0 ? fixture.policy[y][x]! : fixture.policy1[y][x]!;

                    expect(Math.abs(evaluation.policy[i] - expected)).toBeLessThan(tolerance);
                });

                // utility = win - loss
                const whiteWin = player === WHITE ? evaluation.win : evaluation.win - evaluation.utility;
                expect(Math.abs(whiteWin - (symmetry === 0 ? fixture.whiteWin : fixture.whiteWin1))).toBeLessThan(tolerance);
            }
        }
    });
});
