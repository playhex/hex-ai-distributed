import { HexJobData } from '../../shared';
import logger from '../../shared/logger';
import Move from '../Move';
import Katahex from '../katahex-cli/Katahex';
import { mirrorAllMoves, mirrorMove, removeSwap, toKatahexPosition } from '../mirrorMoves';

const { KATAHEX_BIN } = process.env;

if (!KATAHEX_BIN) {
    throw new Error('Requires KATAHEX_BIN=... in .env file');
}

export const katahex = new Katahex(KATAHEX_BIN);

export const processJobKatahex = async (jobData: HexJobData): Promise<string> => {
    const { size } = jobData.game;
    let { movesHistory, swapRule, currentPlayer } = jobData.game;

    if (!jobData.ai) {
        throw new Error('This job is not for an ai');
    }

    const { engine } = jobData.ai;

    if ('katahex' !== engine) {
        throw new Error('Only supports katahex engine, got: ' + engine);
    }

    const { treeSearch } = jobData.ai;
    const movesWithoutSwap = removeSwap(movesHistory);

    logger.debug(`Katahex received job:\nuse tree search: ${treeSearch ? 'yes' : 'no'}\nparam_game allow_swap ${swapRule ? '1' : '0'}\nboardsize ${size}\nplay-game ${movesHistory}\ngenmove ${currentPlayer}\nshowboard`);

    await katahex.setBoardSize(size);
    await katahex.sendCommand('clear_board');

    if ('' !== movesHistory) {
        await katahex.setPosition(toKatahexPosition(movesWithoutSwap));
    }

    logger.debug(await katahex.showboard());

    let generatedMove = treeSearch
        ? await katahex.getBestNonPassingMoveFromTreeSearch('black')
        : await katahex.getBestMoveFromNeuralNetworkOutput()
    ;

    logger.debug('generated move, not mirrored: ' + generatedMove);

    const { swapped, moves } = movesWithoutSwap;
    const even = !(moves.split(' ').length % 2);

    const shouldMirrorResult = swapped === even;

    if (shouldMirrorResult) {
        generatedMove = mirrorMove(generatedMove);
    }

    logger.debug('mirrored: ' + shouldMirrorResult);
    logger.debug('generated move: ' + generatedMove);

    return generatedMove;
};
