import Move from './Move';

/**
 * A board position with:
 *  - no swap move
 *  - no pass move
 *
 * Examples:
 *
 *  - Easy position
 *      StandardizedPosition.fromMovesHistory('a1 b2') =>
 *      {
 *          black: ['a1'],
 *          white: ['b2'],
 *      }
 *
 *  - Always black to play
 *      StandardizedPosition.fromMovesHistory('a2') =>
 *      {
 *          black: [],
 *          white: ['b1'],
 *          mirrored: true,
 *      }
 *
 *  - swap move
 *      StandardizedPosition.fromMovesHistory('b1 swap-pieces') =>
 *      {
 *          black: [],
 *          white: ['a2'],
 *          swapStillAllowed: false,
 *      }
 *
 *  - pass move
 *      StandardizedPosition.fromMovesHistory('pass a1') =>
 *      {
 *          black: [],
 *          white: ['a1'],
 *          swapStillAllowed: false,
 *      }
 */
export class StandardizedPosition
{
    /**
     * Black cells occupied
     */
    blackCells: string[] = [];

    /**
     * White cells occupied
     */
    whiteCells: string[] = [];

    /**
     * Whether swap is allowed in this position.
     *
     * False if:
     *  - swap move already played (but dropped after standardization)
     *  - not the second move (because pass moves dropped after standardization)
     */
    swapStillAllowed: boolean = true;

    /**
     * Whether the original position is currently mirrored.
     *
     * Useful to know whether we have sent a mirrored position to AI,
     * so we should mirror back AI result.
     */
    mirrored: boolean = false;

    /**
     * Next player to move.
     *
     * Guessed from initial position,
     * and changes when mirrored.
     */
    currentPlayer: 'black' | 'white' = 'black';

    static fromMovesHistory(movesHistory: string): StandardizedPosition
    {
        const moves = movesHistory.length > 0 ? movesHistory.split(' ') : [];
        const standardizedPosition = new StandardizedPosition();

        standardizedPosition.currentPlayer = 0 === (moves.length % 2) ? 'black' : 'white';

        const firstMove = moves.shift();
        const secondMove = moves.shift();

        if (!firstMove) {
            return standardizedPosition;
        }

        if (!secondMove) {
            if ('pass' === firstMove) {
                standardizedPosition.swapStillAllowed = false;
            } else {
                standardizedPosition.blackCells.push(firstMove);
            }

            return standardizedPosition;
        }

        if ('swap-pieces' === secondMove) {
            if ('pass' !== firstMove) {
                standardizedPosition.whiteCells.push(Move.mirror(firstMove));
            }
        } else {
            if ('pass' !== firstMove) {
                standardizedPosition.blackCells.push(firstMove);
            }

            if ('pass' !== secondMove) {
                standardizedPosition.whiteCells.push(secondMove);
            }
        }

        standardizedPosition.swapStillAllowed = false;

        const colors = ['blackCells', 'whiteCells'] as const;

        for (let i = 0; i < moves.length; ++i) {
            if ('pass' === moves[i]) {
                continue;
            }

            standardizedPosition[colors[i % 2]].push(moves[i]);
        }

        return standardizedPosition;
    }

    mirror(): void
    {
        const blackCells = this.whiteCells.map(cell => Move.mirror(cell));
        const whiteCells = this.blackCells.map(cell => Move.mirror(cell));

        this.blackCells = blackCells;
        this.whiteCells = whiteCells;
        this.mirrored = !this.mirrored;
        this.currentPlayer = 'black' === this.currentPlayer ? 'white' : 'black';
    }

    /**
     * Katahex neural network always plays as black,
     * so this should be called before sending position to katahex.
     *
     * Katahex result should be mirrored back if this.mirrored is true.
     *
     * Useful for Katahex only, Mohex won't swap white move
     * if only white played a single move.
     */
    setBlackToPlay(): void
    {
        if ('black' !== this.currentPlayer) {
            this.mirror();
        }
    }

    clone(): StandardizedPosition
    {
        const clone = new StandardizedPosition();

        clone.blackCells = this.blackCells.map(cell => cell);
        clone.whiteCells = this.whiteCells.map(cell => cell);
        clone.swapStillAllowed = this.swapStillAllowed;
        clone.mirrored = this.mirrored;
        clone.currentPlayer = this.currentPlayer;

        return clone;
    }
}
