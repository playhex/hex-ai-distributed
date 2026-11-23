import logger from '../../../shared/logger';
import { KatahexMoveInput } from '../../../shared/protocol';
import Move from '../../../shared/Move';
import { StandardizedPosition } from '../../../shared/StandardizedPosition';
import { takeKataRawGoodMoves } from '../../../shared/utils';
import { RawNnEngine } from './RawNnEngine';

/**
 * Intuition bot plays randomly one of the moves
 * having policy > INTUITION_MOVE_POLICY_RATIO * best policy,
 * so that it does not always play same games.
 */
export const INTUITION_MOVE_POLICY_RATIO = 0.8;

/**
 * Katahex move from raw neural network output, without tree search.
 * See processJobKatahexMcts() for tree search.
 */
export const processJobKatahex = async (katahex: RawNnEngine, jobData: KatahexMoveInput): Promise<string> => {
    const { size, movesHistory } = jobData.game;
    const standardizedPosition = StandardizedPosition.fromMovesHistory(movesHistory);

    if (standardizedPosition.currentPlayer !== jobData.game.currentPlayer) {
        throw new Error(`currentPlayer is set to ${jobData.game.currentPlayer} but from moves history, it seems to be ${standardizedPosition.currentPlayer} to play`);
    }

    standardizedPosition.setBlackToPlay();

    await katahex.setBoardSize(size);
    await katahex.setStandardizedPosition(standardizedPosition);

    const goodMoves = takeKataRawGoodMoves((await katahex.parseRawNn()).values, INTUITION_MOVE_POLICY_RATIO);

    if (0 === goodMoves.length) {
        throw new Error('Did not found best move');
    }

    let generatedMove = goodMoves[Math.floor(Math.random() * goodMoves.length)].move;

    if (standardizedPosition.mirrored) {
        generatedMove = Move.mirror(generatedMove);
    }

    logger.debug(`intuition move for ${movesHistory}: ${generatedMove}`);

    return generatedMove;
};
