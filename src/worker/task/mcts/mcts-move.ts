import logger from '../../../shared/logger';
import { KatahexMctsMoveInput } from '../../../shared/protocol';
import { StandardizedPosition } from '../../../shared/StandardizedPosition';
import { isPass } from '../../katahex-cli/Katahex';
import { katahex } from '../calculate-move/katahex';

/**
 * Katahex move with tree search, limited by maxPlayouts.
 */
export const processJobKatahexMcts = async (jobData: KatahexMctsMoveInput): Promise<string> => {
    const { size, movesHistory, currentPlayer } = jobData.game;
    const standardizedPosition = StandardizedPosition.fromMovesHistory(movesHistory);

    if (standardizedPosition.currentPlayer !== currentPlayer) {
        throw new Error(`currentPlayer is set to ${currentPlayer} but from moves history, it seems to be ${standardizedPosition.currentPlayer} to play`);
    }

    await katahex.setBoardSize(size);
    await katahex.setMaxPlayouts(jobData.maxPlayouts);
    await katahex.setPositionWithCurrentPlayer(standardizedPosition);

    const { moves, played } = await katahex.searchAnalyze(currentPlayer, 1);

    // Katahex can pass when it feels too winning or too losing
    if (!isPass(played)) {
        logger.debug(`katahex mcts move (maxPlayouts ${jobData.maxPlayouts}): ${played}`);
        return played;
    }

    logger.debug('Katahex returned "pass", using best searched move instead');

    if (0 === moves.length) {
        logger.error('Did not found best move in katahex search');
        return 'resign';
    }

    return moves[0].move;
};
