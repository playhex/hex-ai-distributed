import type { AiTask } from './protocol';

/*
 * Same jobs on every worker, to compare durations.
 * Positions are random but deterministic, so all workers run exactly the same jobs.
 */

export const BENCH_SIZES = [11, 14];
export const BENCH_PLAYOUTS = 400;

export type BenchResult = {
    type: AiTask['type'];
    size: number;
    durationMs: number;

    /**
     * Tree search visits per second, for mcts jobs.
     */
    visitsPerSecond?: number;
};

const toMoveString = (index: number, size: number): string => {
    const x = index % size;
    const letter = (n: number): string => String.fromCharCode(97 + n);

    return (x < 26 ? letter(x) : letter(Math.floor(x / 26) - 1) + letter(x % 26)) + String((index - x) / size + 1);
};

/**
 * Mulberry32
 */
const seededRandom = (seed: number): () => number => () => {
    seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;

    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

/**
 * Random moves filling a quarter of the board, black first.
 */
const randomGame = (size: number, seed: number): string[] => {
    const random = seededRandom(size * 100 + seed);
    const cells = Array.from({ length: size * size }, (_, i) => i);

    for (let i = cells.length - 1; i > 0; --i) {
        const j = Math.floor(random() * (i + 1));
        [cells[i], cells[j]] = [cells[j], cells[i]];
    }

    return cells.slice(0, Math.round(size * size / 4)).map(cell => toMoveString(cell, size));
};

/**
 * One different position per task, so that no task reuses evaluations cached by previous one.
 */
const benchInputs = (size: number, seed: number) => {
    const moves = randomGame(size, seed);
    const color = moves.length % 2 === 0 ? 'black' : 'white';
    const position = {
        size,
        color,
        black: moves.filter((_, i) => i % 2 === 0).join(' '),
        white: moves.filter((_, i) => i % 2 === 1).join(' '),
    } as const;
    const game = { size, movesHistory: moves.join(' '), currentPlayer: color, swapRule: false } as const;
    const analyzeMove = {
        size,
        moveIndex: moves.length - 1,
        move: moves[moves.length - 1],
        color: moves.length % 2 === 1 ? 'black' : 'white',
        isLastMoveOfGame: false,
        movesHistory: moves.slice(0, -1).join(' '),
    } as const;

    return { position, game, analyzeMove };
};

export const getBenchTasks = (): AiTask[] => BENCH_SIZES.flatMap((size): AiTask[] => {
    const input = (seed: number) => benchInputs(size, seed);

    return [
        { type: 'katahex-mcts-move', data: { game: input(1).game, maxPlayouts: BENCH_PLAYOUTS } },
        { type: 'katahex-mcts-analyze-position', data: { ...input(2).position, maxPlayouts: BENCH_PLAYOUTS } },
        { type: 'katahex-mcts-analyze-move', data: { ...input(3).analyzeMove, maxPlayouts: BENCH_PLAYOUTS } },
        { type: 'katahex-intuition-move', data: { game: input(4).game } },
        { type: 'katahex-intuition-analyze-position', data: input(5).position },
        { type: 'katahex-intuition-analyze-game', data: { size, movesHistory: input(6).game.movesHistory } },
    ];
});

/**
 * Not measured: first model runs of each board size are slower (GPU initialization, shaders).
 */
const getWarmUpTasks = (): AiTask[] => BENCH_SIZES.flatMap((size): AiTask[] => [
    { type: 'katahex-intuition-analyze-position', data: benchInputs(size, 0).position },
    { type: 'katahex-mcts-analyze-position', data: { ...benchInputs(size, 0).position, maxPlayouts: 50 } },
]);

/**
 * Runs each bench task once, after warm-up.
 */
export const runBench = async (
    process: (task: AiTask) => Promise<unknown>,
    onResult: (result: BenchResult) => void = () => undefined,
    getVisits?: () => number,
): Promise<BenchResult[]> => {
    const tasks = getBenchTasks();
    const results: BenchResult[] = [];

    for (const task of getWarmUpTasks()) {
        await process(task);
    }

    for (const task of tasks) {
        const startedAt = performance.now();
        const visitsBefore = getVisits?.() ?? 0;
        await process(task);

        const durationMs = performance.now() - startedAt;
        const visits = (getVisits?.() ?? 0) - visitsBefore;
        const result: BenchResult = {
            type: task.type,
            size: 'game' in task.data ? task.data.game.size : task.data.size,
            durationMs: Math.round(durationMs),
        };

        if (visits > 0) {
            result.visitsPerSecond = Math.round(visits / (durationMs / 1000));
        }

        results.push(result);
        onResult(result);
    }

    return results;
};
