import { tags } from 'typia';

type MohexAIData = {
    engine: 'mohex';

    /**
     * Limit Mohex power by limiting simulation games (param "max_games").
     */
    maxGames: number
        & tags.Minimum<1>
    ;
}

type KatahexAIData = {
    engine: 'katahex';

    /**
     * Whether Katahex uses tree search (harder),
     * or only use raw neural network output (easier).
     */
    treeSearch: boolean;
}

export type HexJobData = {
    game: {
        size: number
            & tags.Minimum<1>
            & tags.Maximum<19>
        ;

        movesHistory: string;
        currentPlayer: 'black' | 'white';
        swapRule: boolean;
    };

    ai: MohexAIData | KatahexAIData;
}

export type HexJobResult = HexJobSuccess | HexJobError;

export type HexJobSuccess = {
    success: true;
    result: string;
};

export type HexJobError = {
    success: false;
    error: string;
};
