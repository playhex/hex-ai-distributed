import { tags } from 'typia';

export type AnalyzePositionInput = {
    color: 'black' | 'white';

    size: number
        & tags.Minimum<1>
        & tags.Maximum<32>
    ;

    white: string;

    black: string;
};

export type AnalyzePositionOutput = {
    whiteWin: number;
    policy: number[][];
};
