import { tags } from 'typia';
import { ResultType } from './ResultType';
import { AnalyzeMoveOutput } from './AnalyzeMove';

export type AnalyzeGameInput = {
    movesHistory: string
        & tags.MinLength<2>
    ;

    size: number
        & tags.Minimum<1>
        & tags.Maximum<32>
    ;
};

export type AnalyzeGameOutput = AnalyzeMoveOutput[];

export type AnalyzeGameJobInput = AnalyzeGameInput;

export type AnalyzeGameJobOutput = ResultType<AnalyzeGameOutput>;

