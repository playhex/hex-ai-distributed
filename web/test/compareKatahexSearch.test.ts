import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
// Native onnxruntime: tree search in wasm on a single thread is too slow for this test
import * as ort from 'onnxruntime-node';
import { describe, expect, it } from 'vitest';
import Katahex from '../../src/worker/katahex-cli/Katahex';
import { processJobKatahexMcts } from '../../src/worker/task/mcts/mcts-move';
import { analyzePositionMcts } from '../../src/worker/task/mcts/mcts-analyze-position';
import Move from '../../src/shared/Move';
import { CachedEvaluator, OnnxEvaluator } from '../../mcts/Evaluator';
import WebMctsEngine from '../../mcts/WebMctsEngine';

/*
 * Compares tree search with native katahex, on same positions and playouts.
 * Not identical searches: reports agreement instead of failing on each difference.
 *
 * Run:
 *  KATAHEX_BIN=../../katahex/build/katahex KATAHEX_MODEL=.../hex27x3.bin.gz npx vitest run compareKatahexSearch
 */

const { KATAHEX_BIN, KATAHEX_MODEL } = process.env;
const modelPath = fileURLToPath(new URL('../../model-conversion/out/hex27x3.onnx', import.meta.url));
const configPath = fileURLToPath(new URL('../../katahex/config.cfg', import.meta.url));

const PLAYOUTS = 400;

/**
 * Random games, so that positions look like real ones: few stones.
 */
const randomGames = (count: number, size: number, seed: number): string[] => {
    const random = () => {
        seed = (seed * 1103515245 + 12345) % 2147483648;
        return seed / 2147483648;
    };

    return Array.from({ length: count }, () => {
        const cells = Array.from({ length: size * size }, (_, i) => new Move(Math.floor(i / size), i % size).toString());
        const length = 2 + Math.floor(random() * size);

        for (let i = cells.length - 1; i > 0; --i) {
            const j = Math.floor(random() * (i + 1));
            [cells[i], cells[j]] = [cells[j], cells[i]];
        }

        return cells.slice(0, length).join(' ');
    });
};

describe.skipIf(!KATAHEX_BIN || !KATAHEX_MODEL || !existsSync(modelPath))('Tree search compared to katahex', () => {
    it(`plays same moves as katahex with ${PLAYOUTS} playouts`, async () => {
        const session = await ort.InferenceSession.create(readFileSync(modelPath));
        const web = new WebMctsEngine(new CachedEvaluator(new OnnxEvaluator(session, ort.Tensor)));
        const katahex = new Katahex(`${KATAHEX_BIN} gtp -config ${configPath} -model ${KATAHEX_MODEL}`);

        let sameMove = 0;
        let sameTop3 = 0;
        let total = 0;
        let winrateDiffSum = 0;

        try {
            for (const size of [9, 11, 14]) {
                for (const movesHistory of randomGames(4, size, size)) {
                    const moves = movesHistory.split(' ');
                    const game = { size, movesHistory, currentPlayer: moves.length % 2 === 0 ? 'black' as const : 'white' as const, swapRule: false };

                    const katahexMove = await processJobKatahexMcts(katahex, { game, maxPlayouts: PLAYOUTS });
                    const webMove = await processJobKatahexMcts(web, { game, maxPlayouts: PLAYOUTS });

                    const position = { size, color: game.currentPlayer, black: moves.filter((_, i) => i % 2 === 0).join(' '), white: moves.filter((_, i) => i % 2 === 1).join(' '), maxPlayouts: PLAYOUTS };
                    const katahexAnalyze = await analyzePositionMcts(katahex, position);
                    const webAnalyze = await analyzePositionMcts(web, position);

                    const katahexTop3 = katahexAnalyze.policy.flatMap((row, r) => row.map((v, c) => ({ v, move: new Move(r, c).toString() })))
                        .sort((a, b) => b.v - a.v).slice(0, 3).map(({ move }) => move);

                    ++total;
                    sameMove += katahexMove === webMove ? 1 : 0;
                    sameTop3 += katahexTop3.includes(webMove) ? 1 : 0;
                    winrateDiffSum += Math.abs(katahexAnalyze.whiteWin - webAnalyze.whiteWin);

                    console.log(`${size}x${size} ${moves.length} moves: katahex ${katahexMove} web ${webMove}, whiteWin katahex ${katahexAnalyze.whiteWin.toFixed(3)} web ${webAnalyze.whiteWin.toFixed(3)}`);
                }
            }
        } finally {
            await katahex.sendCommand('quit').catch(() => undefined);
        }

        console.log(`Same move ${sameMove}/${total}, web move in katahex top 3 ${sameTop3}/${total}, mean whiteWin difference ${(winrateDiffSum / total).toFixed(3)}`);

        expect(sameTop3 / total).toBeGreaterThan(0.6);
    }, 30 * 60_000);
});
