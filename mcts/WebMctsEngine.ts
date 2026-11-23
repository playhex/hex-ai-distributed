import type { MctsEngine, SearchOutput } from '../src/worker/task/mcts/MctsEngine';
import type { StandardizedPosition } from '../src/shared/StandardizedPosition';
import HexBoard, { BLACK, opponent, Player, WHITE } from './HexBoard';
import { Evaluator } from './Evaluator';
import { DEFAULT_SEARCH_PARAMS, Search, SearchParams } from './search';

export type WebMctsEngineOptions = {
    params?: SearchParams;

    /**
     * Called during search, i.e to display progress.
     */
    onProgress?: (playouts: number, maxPlayouts: number) => void;

    /**
     * Aborts current and next searches, i.e when job has been given to another worker.
     */
    signal?: () => undefined | AbortSignal;
};

/**
 * Same as katahex for katahex-mcts-* tasks, with the onnx model and tree search in this process.
 */
export default class WebMctsEngine implements MctsEngine
{
    private size = 11;
    private maxPlayouts = 400;
    private board: null | HexBoard = null;
    private player: Player = BLACK;

    constructor(
        private evaluator: Evaluator,
        private options: WebMctsEngineOptions = {},
    ) {}

    async setBoardSize(size: number): Promise<void>
    {
        this.size = size;
        this.board = null;
    }

    async setMaxPlayouts(maxPlayouts: number): Promise<void>
    {
        this.maxPlayouts = maxPlayouts;
    }

    async setPositionWithCurrentPlayer(standardizedPosition: StandardizedPosition): Promise<void>
    {
        const board = new HexBoard(this.size);

        for (const cell of standardizedPosition.blackCells) {
            board.play(HexBoard.parseMove(cell, this.size), BLACK);
        }

        for (const cell of standardizedPosition.whiteCells) {
            board.play(HexBoard.parseMove(cell, this.size), WHITE);
        }

        this.board = board;
        this.player = standardizedPosition.currentPlayer === 'black' ? BLACK : WHITE;
    }

    async searchAnalyze(color: 'black' | 'white', maxMoves: number): Promise<SearchOutput>
    {
        const { board, player, size, maxPlayouts } = this;

        if (board === null) {
            throw new Error('Set position before searching');
        }

        if ((color === 'black' ? BLACK : WHITE) !== player) {
            throw new Error(`Searching for ${color}, but other player is to play`);
        }

        // Game already won by opponent
        if (board.isConnected(opponent(player), false)) {
            return { moves: [], played: 'pass' };
        }

        const search = new Search(this.evaluator, board, player, this.options.params ?? DEFAULT_SEARCH_PARAMS);
        const result = await search.run({
            maxPlayouts,
            signal: this.options.signal?.(),
            onProgress: playouts => this.options.onProgress?.(playouts, maxPlayouts),
        });

        const moves = result.moves.slice(0, maxMoves).map((searchedMove, order) => ({
            move: HexBoard.moveToString(searchedMove.move, size),
            visits: searchedMove.visits,
            winrate: searchedMove.winrate,
            prior: searchedMove.prior,
            order,
        }));

        return {
            moves,
            played: moves[0]?.move ?? 'pass',
        };
    }
}
