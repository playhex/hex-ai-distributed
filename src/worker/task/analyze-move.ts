import { AnalyzeMoveInput, AnalyzeMoveOutput, MoveAndValue, mirrorMoveAndValue, mirrorMoveAndValues } from '../../shared/model/AnalyzeGame';
import { katahex } from './calculate-move/katahex';
import { takeKataRawMove, takeKataRawNBestMoves } from '../../shared/utils';
import Move from '../../shared/Move';
import { StandardizedPosition } from '../../shared/StandardizedPosition';

/**
 * Analyze position and returns current win rate, and most probable moves.
 * Uses raw katahex neural network output.
 *
 * Always use set_position, way more fluid.
 * When using "play black xx", katahex take long time to reinitialising things
 * when recalling set_position.
 *
 * This task:
 *  - does not compute whiteWin for played move because will be set at analyze-game level, from next AnalyzeMove job where that move is played (while consolidation)
 *  - still compute whiteWin of best move if this one is not the played move
 *  - still compute whiteWin of played move if this is last move of the game
 *
 * Example output (see AnalyzeMoveOutput type for fields description):
 *
 *      moveIndex: 6
 *      color: black
 *      whiteWin: 0.408436
 *
 *      move:
 *          move: c10
 *          value: 0.745757
 *          whiteWin: 0.339446
 *
 *      bestMoves:
 *          move: c4
 *          value: 0.05786
 *          whiteWin: 0.112214
 *
 *          move: h7
 *          value: 0.05786
 *          whiteWin: -
 *
 *          move: c10
 *          value: 0.745757
 *          whiteWin: 0.339446
 */
export const analyzeMove = async (analyzeMove: AnalyzeMoveInput): Promise<AnalyzeMoveOutput> => {
    const standardizedPosition = StandardizedPosition.fromMovesHistory(analyzeMove.movesHistory);

    standardizedPosition.setBlackToPlay();

    // Mirror when white to play: katahex neural network returns best moves as black
    const { mirrored } = standardizedPosition;
    const currentMove = mirrored && analyzeMove.move !== 'pass'
        ? Move.mirror(analyzeMove.move)
        : analyzeMove.move
    ;

    await katahex.setBoardSize(analyzeMove.size);
    await katahex.setStandardizedPosition(standardizedPosition);

    const rawNNOutput = await katahex.parseRawNn();
    const bestMoves = takeKataRawNBestMoves(rawNNOutput.values, 4);
    const move: MoveAndValue = 'pass' !== currentMove
        ? takeKataRawMove(currentMove, rawNNOutput.values)
        : { move: 'pass', value: 0 }
    ;

    if (analyzeMove.isLastMoveOfGame) {
        // If last move, calculate whiteWin of position after actual played move and best move
        const moveWhiteWin = await calcWhiteWinAfterBlackMove(standardizedPosition, currentMove);

        move.whiteWin = moveWhiteWin;

        // Also set whiteWin to same move in bestMoves list
        for (let i = 0; i < bestMoves.length; ++i) {
            if (bestMoves[i].move === move.move) {
                bestMoves[i].whiteWin = moveWhiteWin;
                break;
            }
        }

        // Also process whiteWin for best move (if not same move)
        if (bestMoves[0].whiteWin === undefined) {
            bestMoves[0].whiteWin = await calcWhiteWinAfterBlackMove(standardizedPosition, bestMoves[0].move);
        }
    } else if (bestMoves[0].move !== currentMove) {
        // Process win rate of best move if another move were played
        bestMoves[0].whiteWin = await calcWhiteWinAfterBlackMove(standardizedPosition, bestMoves[0].move);
    }

    if (mirrored) {
        return {
            moveIndex: analyzeMove.moveIndex,
            color: analyzeMove.color,
            whiteWin: 1 - rawNNOutput.whiteWin,
            move: mirrorMoveAndValue(move),
            bestMoves: mirrorMoveAndValues(bestMoves),
        };
    }

    return {
        moveIndex: analyzeMove.moveIndex,
        color: analyzeMove.color,
        whiteWin: rawNNOutput.whiteWin,
        move,
        bestMoves,
    };
};

/**
 * Calculate whiteWin after given move is played
 */
const calcWhiteWinAfterBlackMove = async (standardizedPosition: StandardizedPosition, blackMove: string): Promise<number> => {
    standardizedPosition = standardizedPosition.clone();

    // Black plays
    standardizedPosition.blackCells.push(blackMove);

    // Mirror because now we play as white, katahex always plays as black
    standardizedPosition.mirror();

    await katahex.setStandardizedPosition(standardizedPosition);

    const rawNNOutputBest =  await katahex.parseRawNn(0);

    return 1 - rawNNOutputBest.whiteWin;
};
