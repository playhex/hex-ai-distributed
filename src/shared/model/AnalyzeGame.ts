import { tags } from 'typia';
import Move from '../Move';

export type AnalyzeGameInput = {
    movesHistory: string
        & tags.MinLength<2>
    ;

    size: number
        & tags.Minimum<1>
        & tags.Maximum<32>
    ;
};

export type AnalyzeGameOutput = AnalyzeMoveOutput[];

/*
 * AnalyzeMove, after AnalyzeGame is split before sending to worker
 */

export type MoveAndValue = {
    move: string,

    /**
     * Value of the move from katahex model.
     * Relative to other moves of same position.
     */
    value: number,

    /**
     * White win rate of position after this move is played.
     */
    whiteWin?: number,
};

export type AnalyzeMoveInput = {
    /**
     * Number of the move.
     * 0 means first move.
     */
    moveIndex: number;

    /**
     * Move played by player.
     * If moveIndex 0, this means the first move played.
     */
    move: string;

    /**
     * Player who played "move".
     */
    color: 'black' | 'white';

    /**
     * If this move is the last of the game,
     * winRate should be calculated for played move,
     * and best move if different from played move.
     */
    isLastMoveOfGame: boolean;

    /**
     * Moves played before current move, excluding current move.
     * If moveIndex 0, this should be empty.
     */
    movesHistory: string;

    /**
     * Board size.
     */
    size: number
        & tags.Minimum<1>
        & tags.Maximum<32>
    ;
};

export type AnalyzeMoveOutput = {
    /**
     * moveIndex from AnalyzeMoveInput.
     */
    moveIndex: number;

    /**
     * White win rate before move played
     */
    whiteWin: number;

    /**
     * color from AnalyzeMoveInput.
     */
    color: 'black' | 'white';

    /**
     * move from AnalyzeMoveInput,
     * with its value.
     */
    move: MoveAndValue;

    /**
     * Alternates best moves and their values.
     */
    bestMoves: MoveAndValue[];
};

export const mirrorMoveAndValue = (moveAndValue: MoveAndValue): MoveAndValue => ({
    move: Move.mirror(moveAndValue.move),
    value: moveAndValue.value, // not mirrored because move value stays same
    whiteWin: undefined === moveAndValue.whiteWin ? undefined : 1 - moveAndValue.whiteWin,
});

export const mirrorMoveAndValues = (moveAndValues: MoveAndValue[]): MoveAndValue[] => moveAndValues
    .map(moveAndValue => mirrorMoveAndValue(moveAndValue))
;
