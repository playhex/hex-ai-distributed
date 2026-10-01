import logger from '../../../shared/logger';
import { KatahexMoveInput } from '../../../shared/protocol';
import Katahex from '../../katahex-cli/Katahex';
import Move from '../../../shared/Move';
import { StandardizedPosition } from '../../../shared/StandardizedPosition';

const { KATAHEX_BIN } = process.env;

if (!KATAHEX_BIN) {
    throw new Error('Requires KATAHEX_BIN=... in .env file');
}

export const katahex = new Katahex(KATAHEX_BIN);

/**
 * Katahex move from raw neural network output, without tree search.
 * See processJobKatahexMcts() for tree search.
 */
export const processJobKatahex = async (jobData: KatahexMoveInput): Promise<string> => {
    const { size } = jobData.game;
    const { movesHistory, swapRule } = jobData.game;
    const standardizedPosition = StandardizedPosition.fromMovesHistory(movesHistory);

    if (standardizedPosition.currentPlayer !== jobData.game.currentPlayer) {
        throw new Error(`currentPlayer is set to ${jobData.game.currentPlayer} but from moves history, it seems to be ${standardizedPosition.currentPlayer} to play`);
    }

    standardizedPosition.setBlackToPlay();

    logger.debug(`Katahex received job:\nparam_game allow_swap ${swapRule ? '1' : '0'}\nboardsize ${size}\nplay-game ${movesHistory}\ngenmove ${standardizedPosition.currentPlayer}\nshowboard`);

    await katahex.setBoardSize(size);
    await katahex.sendCommand('clear_board');

    if ('' !== movesHistory) {
        await katahex.setStandardizedPosition(standardizedPosition);
    }

    logger.debug(await katahex.showboard());

    let generatedMove = await katahex.getBestMoveFromNeuralNetworkOutput();

    logger.debug('generated move, not mirrored: ' + generatedMove);

    const { mirrored } = standardizedPosition;

    if (mirrored) {
        generatedMove = Move.mirror(generatedMove);
    }

    logger.debug('mirrored: ' + mirrored);
    logger.debug('generated move: ' + generatedMove);

    return generatedMove;
};
