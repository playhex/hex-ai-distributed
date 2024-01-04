import { HexJobData } from '../../shared';
import logger from '../../shared/logger';
import Move from '../Move';
import queueableMohex from '../mohex-cli/queueableMohexInstance';

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
 * - I play c2, mohex swaps, I play d2, generate move:
 *      c2 swap d2 => W b3, B d2 => play-game d2 b3, genmove white (shift first move, play-game, play white first move)
 *
 * - I play c2, mohex swaps, I play d2, mohex play a1, I play a2, generate move:
 *      c2 swap d2 a1 a2 => W b3, B d2, W a1, B a2 => play-game d2 b3 a1 a2, genmove white (shift first move, play-game, play white first move)
 *
 * - Mohex plays c2, I swap, generate move:
 *      c2 swap => W b3 => play white b3, genmove black (shift first move, play-game, play white first move)
 *
 * - Mohex plays c2, I swap, Mohex plays d3, I play a1, generate move:
 *      c2 swap d3 a1 => W b3, B d3, W a1 => play-game d3 a1, play white b3, genmove black (shift first move, play-game, play white first move)
 *
 * So strategy is:
 *  - If swap move
 *      shift first move and mirror it
 *      remove swap-pieces
 *      play-game
 *      then play first move as always white
 *      genmove current player
 */
export const processJobMohex = async (jobData: HexJobData): Promise<string> => {
    const { size, currentPlayer } = jobData.game;
    let { movesHistory, swapRule } = jobData.game;

    if (!jobData.ai) {
        throw new Error('This job is not for an ai');
    }

    const { engine, maxGames } = jobData.ai;

    if ('mohex' !== engine) {
        throw new Error('Only supports mohex engine, got: ' + engine);
    }

    let playFinallyAsWhite: null | string = null;

    if (swapRule && movesHistory.includes('swap-pieces')) {
        const moves = movesHistory.split(' ');

        playFinallyAsWhite = Move.fromString(moves.shift() as string).cloneMirror().toString(); // shift swaped move and mirror it
        moves.shift(); // remove swap-pieces

        swapRule = false; // disallow swap to prevent mohex swap again, as we removed swap move

        movesHistory = moves.join(' ');
    }

    return queueableMohex.queueCommand(async mohex => {
        logger.debug(`Received job:\nparam_mohex max_games ${maxGames}\nparam_game allow_swap ${swapRule ? '1' : '0'}\nboardsize ${size}\nplay-game ${movesHistory}\ngenmove ${currentPlayer}\nshowboard`);

        await mohex.setMohexParameters({ max_games: '' + maxGames });
        await mohex.setGameParameters({ allow_swap: swapRule });
        await mohex.setBoardSize(size);
        await mohex.playGame(movesHistory);

        if (null !== playFinallyAsWhite) {
            await mohex.play('white', playFinallyAsWhite);
        }

        logger.debug(await mohex.showboard());

        const generatedMove = await mohex.generateMove(currentPlayer);

        logger.debug('generated move: ' + generatedMove);

        return generatedMove;
    });
};
