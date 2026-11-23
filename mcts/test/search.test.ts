import { describe, expect, it } from 'vitest';
import HexBoard, { BLACK, WHITE } from '../HexBoard';
import { Evaluation, EvaluationRequest, Evaluator } from '../Evaluator';
import { Search } from '../search';

/**
 * Uniform policy, even position: search only finds what rules tell.
 */
class UniformEvaluator implements Evaluator
{
    evaluated = 0;

    async evaluate(requests: EvaluationRequest[]): Promise<Evaluation[]>
    {
        this.evaluated += requests.length;

        return requests.map(({ moves }) => ({
            policy: new Float32Array(moves.length).fill(1 / moves.length),
            win: 0.5,
            utility: 0,
        }));
    }
}

/**
 * Black column x = 3, rows 0 to 4 of a 7x7 board: several moves connect.
 */
const almostWonBoard = (): HexBoard => {
    const board = new HexBoard(7);

    for (let y = 0; y <= 4; ++y) {
        board.play(board.index(3, y), BLACK);
    }

    return board;
};

describe('Search', () => {
    it('finds a winning move', async () => {
        const board = almostWonBoard();
        const result = await new Search(new UniformEvaluator(), board, BLACK).run({ maxPlayouts: 300 });

        const after = board.clone();
        after.play(result.moves[0].move, BLACK);

        expect(after.isConnected(BLACK)).toBe(true);
        expect(result.moves[0].winrate).toBe(1);
        expect(result.winrate).toBeGreaterThan(0.8);
    });

    it('blocks when opponent threatens to win', async () => {
        // White to play must prevent black from connecting next move
        const board = new HexBoard(5);

        board.play(board.index(2, 0), BLACK);
        board.play(board.index(2, 1), BLACK);
        board.play(board.index(2, 2), BLACK);
        board.play(board.index(0, 0), WHITE);
        board.play(board.index(4, 4), WHITE);

        const result = await new Search(new UniformEvaluator(), board, WHITE).run({ maxPlayouts: 800 });

        // Black loses every move but blocking ones, so best move of white is not a lost one
        expect(result.moves[0].winrate).toBeGreaterThan(0);
    });

    it('runs maxPlayouts playouts, visits of root children sum up to them', async () => {
        const evaluator = new UniformEvaluator();
        const result = await new Search(evaluator, new HexBoard(9), BLACK).run({ maxPlayouts: 100 });
        const visits = result.moves.reduce((sum, move) => sum + move.visits, 0);

        expect(result.playouts).toBe(100);
        expect(visits).toBe(100);
        expect(evaluator.evaluated).toBeLessThanOrEqual(101);
    });

    it('stops when aborted', async () => {
        const controller = new AbortController();
        controller.abort();

        await expect(new Search(new UniformEvaluator(), new HexBoard(9), BLACK).run({ maxPlayouts: 100, signal: controller.signal })).rejects.toThrow();
    });
});
