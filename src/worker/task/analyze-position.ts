import { AnalyzePositionInput, AnalyzePositionOutput } from '../../shared/model/AnalyzePosition';
import { katahex } from './calculate-move/katahex';
import { StandardizedPosition } from '../../shared/StandardizedPosition';

export const analyzePosition = async (input: AnalyzePositionInput): Promise<AnalyzePositionOutput> => {
    const standardizedPosition = new StandardizedPosition();
    standardizedPosition.blackCells = input.black.length > 0 ? input.black.split(' ') : [];
    standardizedPosition.whiteCells = input.white.length > 0 ? input.white.split(' ') : [];
    standardizedPosition.currentPlayer = input.color;

    standardizedPosition.setBlackToPlay();
    const { mirrored } = standardizedPosition;

    await katahex.setBoardSize(input.size);
    await katahex.setStandardizedPosition(standardizedPosition);

    const { values, whiteWin } = await katahex.parseRawNn();

    return {
        whiteWin: mirrored ? 1 - whiteWin : whiteWin,
        policy: mirrored ? values[0].map((_, col) => values.map(row => row[col])) : values,
    };
};
