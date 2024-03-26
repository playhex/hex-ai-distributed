import { AnalyzeMoveInput, AnalyzeMoveOutput } from '../../shared/model/AnalyzeMove';
import { katahex } from './calculate-move/katahex';
import { RawMoves, cloneRawMoves, mirrorMoveAndValues, mirrorMove, mirrorMoveAndValue, mirrorRawMoves, rawMovesFromHistory, rawMovesToKatahexPosition } from '../mirrorMoves';
import { takeKataRawMove, takeKataRawNBestMoves } from '../../shared/utils';

/**
 * Analyze position and returns current win rate, and most probable moves.
 * Uses raw katahex neural network output.
 *
 * Always use set_position, way more fluid.
 * When using "play black xx", katahex take long time to reinitialising things
 * when recalling set_position.
 *
 * This task:
 *  - does not compute whiteWin for played move because will be set at analyze-game level (while consolidation)
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
    let rawMoves = rawMovesFromHistory(analyzeMove.movesHistory);

    // Mirror when white to play: katahex neural network returns best moves as black
    const mirrored = 'white' === analyzeMove.color;
    const currentMove = mirrored ? mirrorMove(analyzeMove.move) : analyzeMove.move;

    if (mirrored) {
        rawMoves = mirrorRawMoves(rawMoves);
    }

    await katahex.setBoardSize(analyzeMove.size);
    await katahex.setPosition(rawMovesToKatahexPosition(rawMoves));

    const rawNNOutput = await katahex.parseRawNn(0);
    const bestMoves = takeKataRawNBestMoves(rawNNOutput.values, 4);
    const move = takeKataRawMove(currentMove, rawNNOutput.values);

    if (analyzeMove.isLastMoveOfGame) {
        // If last move, calculate whiteWin of position after actual played move and best move
        const moveWhiteWin = await calcWhiteWinAfterBlackMove(rawMoves, currentMove);

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
            bestMoves[0].whiteWin = await calcWhiteWinAfterBlackMove(rawMoves, bestMoves[0].move);
        }
    } else if (bestMoves[0].move !== currentMove) {
        // Process win rate of best move if another move were played
        bestMoves[0].whiteWin = await calcWhiteWinAfterBlackMove(rawMoves, bestMoves[0].move);
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
 * Process win rate of best move if another move is played
 */
const calcWhiteWinAfterBlackMove = async (rawMoves: RawMoves, move: string): Promise<number> => {
    let newRawMoves = cloneRawMoves(rawMoves);

    // Black plays
    newRawMoves.black.push(move);

    // Mirror because now we play as white, katahex always plays as black
    newRawMoves = mirrorRawMoves(newRawMoves);

    await katahex.setPosition(rawMovesToKatahexPosition(newRawMoves));

    const rawNNOutputBest =  await katahex.parseRawNn(0);

    return 1 - rawNNOutputBest.whiteWin;
};
