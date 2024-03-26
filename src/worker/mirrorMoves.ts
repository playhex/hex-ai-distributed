import { MoveAndValue } from '../shared/model/AnalyzeMove';
import Move from './Move';

type MovesWithoutSwap = {
    /**
     * whether moves have been mirrored,
     * so colors are inverted and mirrored.
     * If true, AI should play as other color, and its output should also be mirrored
     */
    mirrored: boolean,

    /**
     * If there was a swap moves.
     * Swap should be disabled to AI then,
     * to prevent he swaps again.
     */
    swapped: boolean,

    /**
     * Moves that should be used to replay game
     * without swap move.
     * First move is always black.
     */
    moves: string,
};

/**
 * List of moves played by black and white
 */
export type RawMoves = {
    black: string[],
    white: string[],
};

export const cloneRawMoves = (rawMoves: RawMoves): RawMoves => ({
    black: [...rawMoves.black],
    white: [...rawMoves.white],
});

/**
 * Remove swap moves, and mirror all moves instead.
 *
 * @param mustPlayAs For katahex neural network which only plays as black.
 *                   Will mirror whole board/color if necessary to make it play as its color.
 */
export const removeSwap = (movesHistory: string): MovesWithoutSwap => {
    if (!movesHistory.match(/swap/)) {
        return {
            mirrored: false,
            swapped: false,
            moves: movesHistory,
        };
    }

    let moves = movesHistory.split(' ');

    if (!moves[1].match(/swap/)) {
        throw new Error('Unexpected swap-pieces not second move');
    }

    const firstMove = moves.shift() as string;
    moves.shift(); // remove swap-pieces

    moves = moves.map(move => mirrorMove(move)); // Mirror moves because sides changed
    moves.unshift(firstMove); // unshift swaped move, not mirrored

    return {
        mirrored: true,
        swapped: true,
        moves: moves.join(' '),
    };
};

export const mirrorMove = (moveString: string): string => Move.fromString(moveString).cloneMirror().toString();

export const mirrorColor = (color: 'black' | 'white'): 'black' | 'white' => color === 'black' ? 'white' : 'black';

export const mirrorAllMoves = (standardizedMoves: string): string => standardizedMoves.split(' ').map(move => mirrorMove(move)).join(' ');

export const toKatahexPosition = (movesWithoutSwap: MovesWithoutSwap): string => {
    const { moves } = movesWithoutSwap;
    const colors = ['black', 'white'];

    let movesArray = moves.split(' ');

    if (movesArray.length % 2) {
        colors.reverse();
        movesArray = movesArray.map(move => mirrorMove(move));
    }

    return movesArray
        .map((move, i) => `${colors[i % 2]} ${move}`)
        .join(' ')
    ;
};

/**
 * 'a1 b2 c3' =>
 *      {
 *          black: ['a1', 'c3'],
 *          white: ['b2'],
 *      }
 *
 * 'b1 swap-pieces c3' =>
 *      {
 *          black: ['c3'],
 *          white: ['a2'],
 *      }
 */
export const rawMovesFromHistory = (movesHistory: string): RawMoves => {
    const moves = movesHistory.split(' ');
    const rawMoves: RawMoves = {
        black: [],
        white: [],
    };

    const firstMove = moves.shift();
    const secondMove = moves.shift();

    if (!firstMove) {
        return rawMoves;
    }

    if (!secondMove) {
        rawMoves.black.push(firstMove);
        return rawMoves;
    }

    if (secondMove.match(/swap/)) {
        rawMoves.white.push(mirrorMove(firstMove));
    } else {
        rawMoves.black.push(firstMove);
        rawMoves.white.push(secondMove);
    }

    const colors: ['black', 'white'] = ['black', 'white'];

    for (let i = 0; i < moves.length; ++i) {
        rawMoves[colors[i % 2]].push(moves[i]);
    }

    return rawMoves;
};

export const mirrorRawMoves = (rawMoves: RawMoves): RawMoves => ({
    black: rawMoves.white.map(move => mirrorMove(move)),
    white: rawMoves.black.map(move => mirrorMove(move)),
});

export const rawMovesToKatahexPosition = (rawMoves: RawMoves): string => [
    ...rawMoves.black.map(m => `black ${m}`),
    ...rawMoves.white.map(m => `white ${m}`),
].join(' ');

export const mirrorMoveAndValue = (moveAndValue: MoveAndValue): MoveAndValue => ({
    move: mirrorMove(moveAndValue.move),
    value: moveAndValue.value, // not mirrored because move value stays same
    whiteWin: undefined === moveAndValue.whiteWin ? undefined : 1 - moveAndValue.whiteWin,
});

export const mirrorMoveAndValues = (moveAndValues: MoveAndValue[]): MoveAndValue[] => moveAndValues
    .map(moveAndValue => mirrorMoveAndValue(moveAndValue))
;
