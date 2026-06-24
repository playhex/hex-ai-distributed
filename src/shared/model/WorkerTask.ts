import { AnalyzeMoveInput, AnalyzeMoveOutput } from './AnalyzeGame';
import { CalculateMoveInput, CalculateMoveOutput } from './CalculateMove';
import { AnalyzePositionInput, AnalyzePositionOutput } from './AnalyzePosition';
import { ResultType } from './ResultType';

export type WorkerInput = {
    type: 'calculate-move';
    data: CalculateMoveInput;
} | {
    type: 'analyze-move';
    data: AnalyzeMoveInput;
} | {
    type: 'analyze-position';
    data: AnalyzePositionInput;
};

/**
 * Output returned by worker and peer-server.
 * `result: false` means an handled error that should be propagated to server response.
 */
export type WorkerOutput = ResultType<CalculateMoveOutput | AnalyzeMoveOutput | AnalyzePositionOutput>;
