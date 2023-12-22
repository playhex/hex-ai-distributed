import { tags } from 'typia';

export type HexJobData = {
    game: {
        size: number
            & tags.Minimum<1>
            & tags.Maximum<13>
        ;

        movesHistory: string;
        currentPlayer: 'black' | 'white';
        swapRule: boolean;
    };

    ai: {
        engine: 'mohex';

        /**
         * Limit power.
         * For Mohex, it is max_games.
         */
        maxGames: number
            & tags.Minimum<1>
        ;
    };
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
