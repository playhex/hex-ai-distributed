import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as ort from 'onnxruntime-web';
import { describe, expect, it } from 'vitest';
import HexBoard from '../../mcts/HexBoard';
import { OnnxEvaluator } from '../../mcts/Evaluator';
import WebRawNnEngine from '../../mcts/WebRawNnEngine';
import { rawNnFixtures } from '../../mcts/test/fixtures';
import { analyzePosition } from '../../src/worker/task/intuition/analyze-position';

/*
 * Requires model converted with model-conversion/, else skipped.
 */
const modelPath = fileURLToPath(new URL('../../model-conversion/out/hex27x3.onnx', import.meta.url));

describe.skipIf(!existsSync(modelPath))('WebRawNnEngine', () => {
    it('gives same intuition position analysis as katahex kata-raw-nn', async () => {
        const tolerance = 2e-3;

        ort.env.wasm.numThreads = 1;
        const session = await ort.InferenceSession.create(readFileSync(modelPath));

        // Policy temperature 1 and symmetry 0, like fixtures
        const engine = new WebRawNnEngine(new OnnxEvaluator(session, ort.Tensor, 1, () => 0));

        // Tasks mirror positions to black to play, fixtures with white to play are not comparable
        for (const fixture of rawNnFixtures.filter(f => f.size <= 11 && !f.whiteToPlay)) {
            const toCells = (cells: [number, number][]) => cells.map(([x, y]) => HexBoard.moveToString(y * fixture.size + x, fixture.size)).join(' ');

            const { policy, whiteWin } = await analyzePosition(engine, {
                size: fixture.size,
                color: 'black',
                black: toCells(fixture.black),
                white: toCells(fixture.white),
            });

            expect(Math.abs(whiteWin - fixture.whiteWin)).toBeLessThan(tolerance);

            for (let y = 0; y < fixture.size; ++y) {
                for (let x = 0; x < fixture.size; ++x) {
                    const expected = fixture.policy[y][x];

                    // Occupied cells are 0, like katahex parseFloatOrZero()
                    if (expected === null) {
                        expect(policy[y][x]).toBe(0);
                        continue;
                    }

                    expect(Math.abs(policy[y][x] - expected)).toBeLessThan(tolerance);
                }
            }
        }
    });
});
