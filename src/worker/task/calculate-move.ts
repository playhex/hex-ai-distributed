import { CalculateMoveInput } from '../../shared/model/CalculateMove';
import { processJobKatahex } from './calculate-move/katahex';
import { processJobMohex } from './calculate-move/mohex';

export const aiProcessJob = async (calculateMoveInput: CalculateMoveInput): Promise<string> => {
    const { engine } = calculateMoveInput.ai;

    switch (engine) {
        case 'mohex': return processJobMohex(calculateMoveInput);
        case 'katahex': return processJobKatahex(calculateMoveInput);

        default: throw new Error(`AI engine "${engine}" not supported.`);
    }
}
