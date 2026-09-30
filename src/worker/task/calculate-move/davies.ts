import { getBestMove, WHO_BLUE, WHO_RED } from 'davies-hex-ai';
import { DaviesMoveInput } from '../../../shared/protocol';

export const daviesVersion = 'davies-hex-ai ' + require('davies-hex-ai/package.json').version;

/**
 * Davies is written in javascript, no binary required.
 */
export const processJobDavies = (input: DaviesMoveInput): string => {
    return getBestMove(
        'black' === input.game.currentPlayer ? WHO_RED : WHO_BLUE,
        input.game.movesHistory.split(' ').filter(move => '' !== move),
        input.level,
    );
};
