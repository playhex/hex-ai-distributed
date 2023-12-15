export type HexJobData = {
    game: {
        size: number;
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
        maxGames: number;
    };
};

export type HexJobResult = string;


export type PeerConfig = {
    /**
     * Benchmark result.
     * A peer with high power will be selected first to process a task.
     */
    power: number;

    /**
     * If true, this peer will never be selected,
     * unless all connected peers are secondary.
     *
     * Used for slow peers, or peer sharing the same machine as the hex website.
     */
    secondary: boolean;
};

export const defaultConfig: PeerConfig = {
    power: 1,
    secondary: false,
};
