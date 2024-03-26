import Move from '../worker/Move';
import { MoveAndValue } from './model/AnalyzeMove';

export const takeKataRawNBestMoves = (values: number[][], nBest: number): MoveAndValue[] => {
    const bestMoves: MoveAndValue[] = [];

    for (let row = 0; row < values.length; ++row) {
        for (let col = 0; col < values[row].length; ++col) {
            const value = values[row][col];

            if (isNaN(value)) {
                continue;
            }

            if (bestMoves.length < nBest) {
                bestMoves.push({
                    move: new Move(row, col).toString(),
                    value,
                });

                bestMoves.sort((a, b) => b.value - a.value);

                continue;
            }

            if (value > bestMoves[nBest - 1].value) {
                bestMoves.pop();

                bestMoves.push({
                    move: new Move(row, col).toString(),
                    value,
                });

                bestMoves.sort((a, b) => b.value - a.value);
            }
        }
    }

    return bestMoves;
};

export const takeKataRawMove = (move: string, values: number[][]): MoveAndValue => {
    const { row, col } = Move.fromString(move);

    return {
        move,
        value: values[row][col],
    };
};
