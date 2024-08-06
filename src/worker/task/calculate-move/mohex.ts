import logger from '../../../shared/logger';
import { CalculateMoveInput } from '../../../shared/model/CalculateMove';
import Mohex from '../../mohex-cli/Mohex';
import Move from '../../../shared/Move';
import { StandardizedPosition } from '../../../shared/StandardizedPosition';

const { MOHEX_BIN } = process.env;

if (!MOHEX_BIN) {
    throw new Error('Requires MOHEX_BIN=... in .env file');
}

export const mohex = new Mohex(MOHEX_BIN);

/**
 * Mohex "swap-pieces" is actually a swap sides. Black stone stays, but players change color.
 * Where we expect swap-pieces mirror the stone and changes its color.

param_mohex max_games 2000
param_game allow_swap 1

boardsize 4
play-game b1 swap-pieces
showboard
=
  a  b  c  d
 1\.  B  .  .\1
  2\.  .  .  .\2
   3\.  .  .  .\3
    4\.  .  .  .\4
       a  b  c  d
(white to play now)

 *
 * So we have to adapt moves here.
 *
 * If there is a swap piece move, drop it, mirror first move, and invert colors.
 */
export const processJobMohex = async (jobData: CalculateMoveInput): Promise<string> => {
    const { size } = jobData.game;

    if (size < 1 || size > 13) {
        throw new Error('Mohex can play only on board with size in [1, 13]');
    }

    let { movesHistory, swapRule } = jobData.game;

    if (!jobData.ai) {
        throw new Error('This job is not for an ai');
    }

    const { engine } = jobData.ai;

    if ('mohex' !== engine) {
        throw new Error('Only supports mohex engine, got: ' + engine);
    }

    const { maxGames } = jobData.ai;
    const standardizedPosition = StandardizedPosition.fromMovesHistory(movesHistory);
    const { mirrored, swapStillAllowed, blackCells, whiteCells, currentPlayer } = standardizedPosition;

    console.log(movesHistory, standardizedPosition);

    if (currentPlayer !== jobData.game.currentPlayer) {
        throw new Error(`currentPlayer is set to ${jobData.game.currentPlayer} but from moves history, it seems to be ${currentPlayer} to play`);
    }

    logger.debug(`Mohex received job:\nparam_mohex max_games ${maxGames}\nparam_game allow_swap ${swapRule ? '1' : '0'}\nboardsize ${size}\nplay-game ${movesHistory}\ngenmove ${currentPlayer}\nshowboard`);

    await mohex.setMohexParameters({
        // do not keep calculated moves because plays multiple games in parallel
        reuse_subtree: false,

        // timeout, must not stop calculations to keep consistent AI difficulty
        max_time: '30',

        // limit memory
        max_memory: '' + (1024 * 1024 * 1024), // 1Go

        max_games: '' + maxGames,
    });

    await mohex.setGameParameters({
        allow_swap: swapStillAllowed && swapRule,
    });

    await mohex.setBoardSize(size);

    try {
        await mohex.setStandardizedPosition(standardizedPosition);
    } catch (e) {
        logger.notice('Error while replaying game', { blackCells, whiteCells });
        throw e;
    }

    logger.debug('mirrored: ' + mirrored);
    logger.debug(await mohex.showboard());

    let generatedMove = await mohex.generateMove(standardizedPosition.currentPlayer);

    if (mirrored) {
        generatedMove = Move.mirror(generatedMove);
    }

    logger.debug('generated move: ' + generatedMove);

    return generatedMove;
};
