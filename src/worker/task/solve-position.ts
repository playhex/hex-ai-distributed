import logger from '../../shared/logger';
import Move from '../../shared/Move';
import { SolvePositionInput, SolvePositionOutput, SolveResult } from '../../shared/protocol';
import Mohex from '../mohex-cli/Mohex';

/**
 * Below this remaining time, children are not solved anymore.
 * Not 0: "param_dfpn timelimit 0" means no limit.
 */
const MIN_SEARCH_SECONDS = 0.1;

/**
 * Solver threads, from env, defaults to 1.
 */
const getSolverThreads = (): number => {
    const threads = parseInt(process.env.MOHEX_SOLVER_THREADS ?? '', 10);

    return threads > 0 ? threads : 1;
};

export type SolverEngine = Pick<Mohex, 'setGameParameters' | 'setDfpnParameters' | 'setPosition' | 'solveState' | 'getDfpnPv' | 'play' | 'undo'>;

const opponent = (color: 'black' | 'white'): 'black' | 'white' => color === 'black' ? 'white' : 'black';

const getEmptyCells = ({ size, black, white }: SolvePositionInput): string[] => {
    const occupied = new Set([...black, ...white]);
    const cells: string[] = [];

    for (let row = 0; row < size; ++row) {
        for (let col = 0; col < size; ++col) {
            const cell = new Move(row, col).toString();

            if (!occupied.has(cell)) {
                cells.push(cell);
            }
        }
    }

    return cells;
};

/**
 * Proves winner of a position with mohex dfpn solver.
 * Position can be fictitious, stones are placed without checking turns.
 *
 * Solver transposition table is kept between jobs:
 * positions of a same puzzle are often solved by the same worker.
 *
 * @param now Current time in ms, for tests
 */
export const solvePosition = async (mohex: SolverEngine, input: SolvePositionInput, now = () => Date.now()): Promise<SolvePositionOutput> => {
    const { size, black, white, color, timeLimitSeconds, children } = input;

    if (size < 1 || size > 14) {
        throw new Error('Mohex can solve only boards with size in [1, 14]');
    }

    const startedAt = now();

    await mohex.setGameParameters({ allow_swap: false });
    await mohex.setDfpnParameters({
        timelimit: String(timeLimitSeconds),
        threads: String(getSolverThreads()),
    });
    await mohex.setPosition(size, black, white);

    const winner = await mohex.solveState(color);
    const pv = winner === null ? [] : await mohex.getDfpnPv(color);
    const output: SolvePositionOutput = { winner, pv };

    if (!children) {
        return output;
    }

    const opponentColor = opponent(color);
    const emptyCells = getEmptyCells(input);

    // Best move first, it is the most interesting one, and fast to solve after parent search
    const orderedCells = pv.length > 0 && emptyCells.includes(pv[0])
        ? [pv[0], ...emptyCells.filter(cell => cell !== pv[0])]
        : emptyCells
    ;

    const deadline = startedAt + children.maxTimeSeconds * 1000;
    const childrenResults: { [move: string]: SolveResult } = {};

    for (const cell of orderedCells) {
        await mohex.play(color, cell);

        try {
            // Player to move loses: all its moves are losing, no need to solve them
            if (winner === opponentColor) {
                childrenResults[cell] = { winner: opponentColor, pv: await mohex.getDfpnPv(opponentColor) };
                continue;
            }

            const remainingSeconds = (deadline - now()) / 1000;

            if (remainingSeconds < MIN_SEARCH_SECONDS) {
                childrenResults[cell] = { winner: null, pv: [] };
                continue;
            }

            await mohex.setDfpnParameters({ timelimit: String(Math.min(timeLimitSeconds, remainingSeconds)) });

            const childWinner = await mohex.solveState(opponentColor);

            childrenResults[cell] = {
                winner: childWinner,
                pv: childWinner === null ? [] : await mohex.getDfpnPv(opponentColor),
            };
        } finally {
            await mohex.undo();
        }
    }

    logger.debug('Solved position children', { seconds: (now() - startedAt) / 1000, cells: orderedCells.length });

    output.children = childrenResults;

    return output;
};

export const processJobSolvePosition = async (input: SolvePositionInput): Promise<SolvePositionOutput> => {
    const { mohex } = await import('./calculate-move/mohex');

    return await solvePosition(mohex, input);
};
