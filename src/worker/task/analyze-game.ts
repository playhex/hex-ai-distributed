import { AnalyzeGameInput, AnalyzeGameOutput, AnalyzeMoveOutput, MoveAndValue } from '../../shared/protocol';
import { katahex } from './calculate-move/katahex';
import { mirrorMoveAndValue, mirrorMoveAndValues, takeKataRawMove, takeKataRawNBestMoves } from '../../shared/utils';
import Move from '../../shared/Move';
import { StandardizedPosition } from '../../shared/StandardizedPosition';

const BEST_MOVES_COUNT = 4;

/**
 * A move of the game being analyzed, in standardized position (black to play).
 */
type MoveAnalyze = {
    moveIndex: number;
    color: 'black' | 'white';
    isLastMoveOfGame: boolean;

    /**
     * Position before move, black to play.
     */
    position: StandardizedPosition;

    /**
     * Played move, mirrored if position is mirrored.
     */
    move: MoveAndValue;

    /**
     * Best moves, mirrored if position is mirrored.
     */
    bestMoves: MoveAndValue[];

    /**
     * White win rate before move, in standardized position.
     */
    whiteWin: number;
};

/**
 * Analyze all moves of a game, using raw katahex neural network output.
 *
 * Positions are evaluated in batches:
 *  - first batch: position before each move, to get its win rate, and move values (policy)
 *  - second batch: positions after best moves that were not played, to get their win rate.
 *    Also position after played move for last move of the game.
 *
 * whiteWin of played move is not set (except for last move of the game),
 * it is set by server from whiteWin before next move.
 *
 * Swap move, as second move, is not analyzed: server deduces it from third move analyze.
 * Same order as server splitToAnalyzeMoveInputs().
 */
export const analyzeGame = async (input: AnalyzeGameInput): Promise<AnalyzeGameOutput> => {
    const moves = input.movesHistory.split(' ').filter(move => '' !== move);

    const moveAnalyzes: MoveAnalyze[] = moves
        .map((move, moveIndex) => ({ move, moveIndex }))
        .filter(({ move, moveIndex }) => !(1 === moveIndex && 'swap-pieces' === move))
        .map(({ move, moveIndex }) => {
            const position = StandardizedPosition.fromMovesHistory(moves.slice(0, moveIndex).join(' '));

            // Katahex neural network returns best moves as black
            position.setBlackToPlay();

            return {
                moveIndex,
                color: 0 === moveIndex % 2 ? 'black' : 'white',
                isLastMoveOfGame: moveIndex === moves.length - 1,
                position,
                move: { move: position.mirrored && 'pass' !== move ? Move.mirror(move) : move, value: 0 },
                bestMoves: [],
                whiteWin: 0,
            };
        })
    ;

    await katahex.setBoardSize(input.size);

    // First batch: positions before each move
    const rawNNOutputs = await katahex.parseRawNnBatch(moveAnalyzes.map(({ position }) => position));

    moveAnalyzes.forEach((moveAnalyze, i) => {
        const { values, whiteWin } = rawNNOutputs[i];

        moveAnalyze.whiteWin = whiteWin;
        moveAnalyze.bestMoves = takeKataRawNBestMoves(values, BEST_MOVES_COUNT);

        if ('pass' !== moveAnalyze.move.move) {
            moveAnalyze.move = takeKataRawMove(moveAnalyze.move.move, values);
        }
    });

    // Second batch: positions after moves which win rate is required
    const movesToEvaluate: { moveAnalyze: MoveAnalyze, blackMove: string }[] = [];

    for (const moveAnalyze of moveAnalyzes) {
        const playedMove = moveAnalyze.move.move;
        const bestMove = moveAnalyze.bestMoves[0]?.move;

        // Last move of the game: no next position to get win rate after played move from
        if (moveAnalyze.isLastMoveOfGame && 'pass' !== playedMove) {
            movesToEvaluate.push({ moveAnalyze, blackMove: playedMove });
        }

        // Win rate of best move if another move were played
        if (undefined !== bestMove && bestMove !== playedMove) {
            movesToEvaluate.push({ moveAnalyze, blackMove: bestMove });
        }
    }

    const rawNNOutputsAfterMove = await katahex.parseRawNnBatch(movesToEvaluate.map(({ moveAnalyze, blackMove }) => {
        const position = moveAnalyze.position.clone();

        // Black plays
        position.blackCells.push(blackMove);

        // Mirror because now white plays, katahex always plays as black
        position.mirror();

        return position;
    }));

    movesToEvaluate.forEach(({ moveAnalyze, blackMove }, i) => {
        const whiteWin = 1 - rawNNOutputsAfterMove[i].whiteWin;

        if (moveAnalyze.move.move === blackMove) {
            moveAnalyze.move.whiteWin = whiteWin;
        }

        for (const bestMove of moveAnalyze.bestMoves) {
            if (bestMove.move === blackMove) {
                bestMove.whiteWin = whiteWin;
            }
        }
    });

    return moveAnalyzes.map(toAnalyzeMoveOutput);
};

/**
 * Mirror back to original position if it has been mirrored.
 */
const toAnalyzeMoveOutput = ({ moveIndex, color, position, move, bestMoves, whiteWin }: MoveAnalyze): AnalyzeMoveOutput => {
    if (position.mirrored) {
        return {
            moveIndex,
            color,
            whiteWin: 1 - whiteWin,
            move: 'pass' === move.move ? move : mirrorMoveAndValue(move),
            bestMoves: mirrorMoveAndValues(bestMoves),
        };
    }

    return {
        moveIndex,
        color,
        whiteWin,
        move,
        bestMoves,
    };
};
