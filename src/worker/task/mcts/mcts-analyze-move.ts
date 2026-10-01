import { AnalyzeMoveOutput, MctsAnalyzeMoveInput, MoveAndValue } from '../../../shared/protocol';
import { StandardizedPosition } from '../../../shared/StandardizedPosition';
import { SearchMove } from '../../katahex-cli/Katahex';
import { katahex } from '../calculate-move/katahex';

/**
 * Below this visits count, played move win rate is not reliable enough,
 * and is calculated with another search on position after played move.
 */
const MIN_VISITS = 10;

const BEST_MOVES_COUNT = 4;

/**
 * Analyze a move of a game with tree search, limited by maxPlayouts.
 *
 * Unlike intuition analyze, whiteWin is set for played move and all best moves,
 * so that a single move can be analyzed without the next one.
 * Move values are raw neural network policy.
 */
export const analyzeMoveMcts = async (analyzeMove: MctsAnalyzeMoveInput): Promise<AnalyzeMoveOutput> => {
    const { color } = analyzeMove;
    const standardizedPosition = StandardizedPosition.fromMovesHistory(analyzeMove.movesHistory);

    if (standardizedPosition.currentPlayer !== color) {
        throw new Error(`color is set to ${color} but from moves history, it seems to be ${standardizedPosition.currentPlayer} to play`);
    }

    await katahex.setBoardSize(analyzeMove.size);
    await katahex.setMaxPlayouts(analyzeMove.maxPlayouts);
    await katahex.setPositionWithCurrentPlayer(standardizedPosition);

    const { moves } = await katahex.searchAnalyze(color, analyzeMove.size * analyzeMove.size);

    if (0 === moves.length) {
        throw new Error('Katahex search returned no move');
    }

    // winrate is win rate of player to play
    const toWhiteWin = (winrate: number): number => 'white' === color ? winrate : 1 - winrate;

    const toMoveAndValue = (searchMove: SearchMove): MoveAndValue => ({
        move: searchMove.move,
        value: searchMove.prior,
        whiteWin: toWhiteWin(searchMove.winrate),
    });

    let move: MoveAndValue;

    if ('pass' === analyzeMove.move) {
        move = { move: 'pass', value: 0 };
    } else {
        const searchMove = moves.find(m => m.move === analyzeMove.move);

        move = undefined !== searchMove && searchMove.visits >= MIN_VISITS
            ? toMoveAndValue(searchMove)
            : {
                move: analyzeMove.move,
                value: searchMove?.prior ?? 0,
                whiteWin: await calcWhiteWinAfterMove(standardizedPosition, analyzeMove.move),
            }
        ;
    }

    return {
        moveIndex: analyzeMove.moveIndex,
        color,
        whiteWin: toWhiteWin(moves[0].winrate),
        move,
        bestMoves: moves.slice(0, BEST_MOVES_COUNT).map(toMoveAndValue),
    };
};

/**
 * Calculate whiteWin after given move is played by current player, with tree search.
 */
const calcWhiteWinAfterMove = async (standardizedPosition: StandardizedPosition, move: string): Promise<number> => {
    const color = standardizedPosition.currentPlayer;
    const opponent = 'black' === color ? 'white' : 'black';

    standardizedPosition = standardizedPosition.clone();
    standardizedPosition[`${color}Cells`].push(move);
    standardizedPosition.currentPlayer = opponent;

    await katahex.setPositionWithCurrentPlayer(standardizedPosition);

    const { moves } = await katahex.searchAnalyze(opponent, 1);

    // No move left, game won by player who played the move
    if (0 === moves.length) {
        return 'white' === color ? 1 : 0;
    }

    // Win rate of opponent, now to play
    return 'white' === opponent ? moves[0].winrate : 1 - moves[0].winrate;
};
