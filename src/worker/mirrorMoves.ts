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
    const { moves, swapped } = movesWithoutSwap;
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
