import type { RawNnEngine, RawNNOutput } from '../src/worker/task/intuition/RawNnEngine';
import type { StandardizedPosition } from '../src/shared/StandardizedPosition';
import HexBoard, { BLACK, WHITE } from './HexBoard';
import { Evaluator, EvaluationRequest } from './Evaluator';

/**
 * Same as katahex kata-raw-nn for katahex-intuition-* tasks, with the onnx model.
 * Black to play, like katahex after StandardizedPosition.setBlackToPlay().
 */
export default class WebRawNnEngine implements RawNnEngine
{
    private size = 11;
    private position: null | StandardizedPosition = null;

    /**
     * @param evaluator Should use symmetry 0, like katahex kata-raw-nn default.
     */
    constructor(
        private evaluator: Evaluator,
    ) {}

    async setBoardSize(size: number): Promise<void>
    {
        this.size = size;
        this.position = null;
    }

    async setStandardizedPosition(standardizedPosition: StandardizedPosition): Promise<void>
    {
        this.position = standardizedPosition;
    }

    async parseRawNn(): Promise<RawNNOutput>
    {
        if (this.position === null) {
            throw new Error('Set position before evaluating');
        }

        return (await this.parseRawNnBatch([this.position]))[0];
    }

    async parseRawNnBatch(positions: StandardizedPosition[]): Promise<RawNNOutput[]>
    {
        const requests: EvaluationRequest[] = positions.map(position => {
            const board = new HexBoard(this.size);

            for (const cell of position.blackCells) {
                board.play(HexBoard.parseMove(cell, this.size), BLACK);
            }

            for (const cell of position.whiteCells) {
                board.play(HexBoard.parseMove(cell, this.size), WHITE);
            }

            return { board, player: BLACK, moves: board.legalMoves() };
        });

        // Split in model runs by evaluator
        const evaluations = await this.evaluator.evaluate(requests);

        return requests.map(({ moves }, i) => {
            const { policy, win, utility } = evaluations[i];
            const values = Array.from({ length: this.size }, () => new Array<number>(this.size).fill(0));

            moves.forEach((move, m) => {
                const x = move % this.size;
                values[(move - x) / this.size][x] = policy[m];
            });

            // Black to play: white wins when black loses, utility = win - loss
            return { values, whiteWin: win - utility };
        });
    }
}
