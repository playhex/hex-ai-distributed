import { AnalyzePositionOutput, MctsAnalyzePositionInput } from '../../../shared/protocol';
import Move from '../../../shared/Move';
import { StandardizedPosition } from '../../../shared/StandardizedPosition';
import { katahex } from '../calculate-move/katahex';

/**
 * Analyze position with tree search, limited by maxPlayouts.
 * Returns share of visits of each cell as policy.
 */
export const analyzePositionMcts = async (input: MctsAnalyzePositionInput): Promise<AnalyzePositionOutput> => {
    const standardizedPosition = new StandardizedPosition();
    standardizedPosition.blackCells = input.black.length > 0 ? input.black.split(' ') : [];
    standardizedPosition.whiteCells = input.white.length > 0 ? input.white.split(' ') : [];
    standardizedPosition.currentPlayer = input.color;

    await katahex.setBoardSize(input.size);
    await katahex.setMaxPlayouts(input.maxPlayouts);
    await katahex.setPositionWithCurrentPlayer(standardizedPosition);

    const { moves } = await katahex.searchAnalyze(input.color, input.size * input.size);

    if (0 === moves.length) {
        throw new Error('Katahex search returned no move');
    }

    const totalVisits = moves.reduce((total, move) => total + move.visits, 0);
    const policy: number[][] = Array.from({ length: input.size }, () => Array(input.size).fill(0));

    for (const searchMove of moves) {
        const { row, col } = Move.fromString(searchMove.move);

        policy[row][col] = searchMove.visits / totalVisits;
    }

    // winrate is win rate of player to play
    const winrate = moves[0].winrate;

    return {
        whiteWin: 'white' === input.color ? winrate : 1 - winrate,
        policy,
    };
};
