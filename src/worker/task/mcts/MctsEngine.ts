import { StandardizedPosition } from '../../../shared/StandardizedPosition';

export type SearchMove = {
    move: string;
    visits: number;

    /**
     * Win rate of player to play after this move.
     */
    winrate: number;

    /**
     * Raw neural network policy of this move.
     */
    prior: number;

    /**
     * Rank of this move, 0 for best move.
     */
    order: number;
};

export type SearchOutput = {
    /**
     * Searched moves, best move first. Pass excluded.
     */
    moves: SearchMove[];

    /**
     * Move chosen by engine, can be pass ("pss").
     */
    played: string;
};

/**
 * Katahex returns "pss" for pass.
 */
export const isPass = (move: string): boolean => /^pa?ss$/.test(move);

/**
 * Engine running tree search for katahex-mcts-* jobs:
 * katahex binary for docker workers, or onnx model with tree search in browser for web workers.
 */
export interface MctsEngine
{
    setBoardSize(size: number): Promise<void>;

    /**
     * Limit tree search of next searches.
     */
    setMaxPlayouts(maxPlayouts: number): Promise<void>;

    /**
     * Set position with its current player to play.
     */
    setPositionWithCurrentPlayer(standardizedPosition: StandardizedPosition): Promise<void>;

    /**
     * Run a tree search on current position, limited by maxPlayouts,
     * and returns searched moves and the move engine would play.
     *
     * @param color Player to play, must be the one set on board.
     * @param maxMoves Max number of searched moves to return.
     */
    searchAnalyze(color: 'black' | 'white', maxMoves: number): Promise<SearchOutput>;
}
