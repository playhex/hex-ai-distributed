import './config';
import { createConnection } from 'node:net';
import { HexJobData } from '../shared';
import queueableMohex from './mohex-cli/queueableMohexInstance';
import logger from '../shared/logger';

const { SERVER_HOST, SERVER_PORT } = process.env;

if (!SERVER_HOST || !SERVER_PORT) {
    throw new Error('Needs SERVER_HOST and SERVER_PORT in .env file');
}

const processJob = async (jobData: HexJobData): Promise<string> => {
    const { size, movesHistory, currentPlayer, swapRule } = jobData.game;
    const { engine, maxGames } = jobData.ai;

    if ('mohex' !== engine) {
        throw new Error('Only supports mohex engine, got: ' + engine);
    }

    return queueableMohex.queueCommand(async mohex => {
        await mohex.setMohexParameters({ max_games: '' + maxGames });
        await mohex.setGameParameters({ allow_swap: swapRule });
        await mohex.setBoardSize(size);
        await mohex.playGame(movesHistory);

        return await mohex.generateMove(currentPlayer);
    });
}

const connectAndProcess = () => {
    const socket = createConnection({
        host: SERVER_HOST,
        port: +SERVER_PORT,
    })
        .on('connect', () => {
            logger.info('Connected. Processing jobs.');

            const { PEER_CONFIG_SECONDARY } = process.env;

            let secondary = false;

            if (undefined !== PEER_CONFIG_SECONDARY) {
                secondary = '1' === PEER_CONFIG_SECONDARY || 'true' === PEER_CONFIG_SECONDARY;
            }

            if (secondary) {
                logger.debug('Set secondary', { secondary });
                socket.write('set_secondary ' + JSON.stringify(secondary));
            }
        })

        .on('data', async data => {
            const string = data.toString();
            const matches = string.match(/^job ([^ ]+) (.+)$/);

            if (!matches) {
                return;
            }

            const [, token, jobDataJson] = matches;
            const jobData: HexJobData = JSON.parse(jobDataJson);

            logger.debug('Received a job. Processing it...');

            try {
                const result = await processJob(jobData);
                socket.write(`job_result ${token} ${JSON.stringify({success: true, result})}`);
            } catch (error) {
                logger.error('Error while processing job by AI', { error });
                socket.write(`job_result ${token} ${JSON.stringify({success: false, error})}`);
                return;
            }

            logger.info('Job processed successfully.');
        })

        .on('error', error => {
            logger.error('Error... Closing connection', { error });
            socket.end();
        })

        .on('close', async () => {
            logger.notice('Connection to server closed, trying to reconnect...');
            await new Promise(resolve => setTimeout(resolve, 2000));
            connectAndProcess();
            socket.destroy();
        })
    ;
};

(async () => {
    logger.info('Waiting for Mohex to be ready...');
    await queueableMohex.queueCommand(async mohex => mohex.license());
    logger.info('Mohex ready');

    logger.info('Connecting to server...');
    connectAndProcess();
})();
