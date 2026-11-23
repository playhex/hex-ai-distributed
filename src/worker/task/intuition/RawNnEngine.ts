import { StandardizedPosition } from '../../../shared/StandardizedPosition';

export type RawNNOutput = {
    /**
     * Policy of each cell, values[row][col], NaN for cells that cannot be played.
     */
    values: number[][];
    whiteWin: number;
};

/**
 * Engine giving raw neural network output for katahex-intuition-* jobs, without tree search:
 * katahex binary for docker workers, or onnx model in browser for web workers.
 * Positions are evaluated with black to play.
 */
export interface RawNnEngine
{
    setBoardSize(size: number): Promise<void>;

    setStandardizedPosition(standardizedPosition: StandardizedPosition): Promise<void>;

    /**
     * Output for current position.
     */
    parseRawNn(): Promise<RawNNOutput>;

    /**
     * Output of many positions on current board size, evaluated in batches. Does not change current position.
     */
    parseRawNnBatch(positions: StandardizedPosition[]): Promise<RawNNOutput[]>;
}
