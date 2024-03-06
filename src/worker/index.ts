import './config';
import { createConnection, Socket } from 'node:net';
import { setTimeout } from 'node:timers/promises';
import { HexJobData } from '../shared';
import logger from '../shared/logger';
import { mohex, processJobMohex } from './ai-client/mohex';
import { katahex, processJobKatahex } from './ai-client/katahex';

const { SERVER_HOST, SERVER_PORT } = process.env;

if (!SERVER_HOST || !SERVER_PORT) {
    throw new Error('Needs SERVER_HOST and SERVER_PORT in .env file');
}

const processJob = async (jobData: HexJobData): Promise<string> => {
    const { engine } = jobData.ai;

    switch (engine) {
        case 'mohex': return processJobMohex(jobData);
        case 'katahex': return processJobKatahex(jobData);

        default: throw new Error(`AI engine "${engine}" not supported.`);
    }
}

let socket: null | Socket = null;

const connectAndProcess = () => {
    logger.info(`Creating connection to server ${SERVER_HOST}:${SERVER_PORT}...`);

    if (null !== socket) {
        logger.notice('There is already a socket, stopping now to prevent creating another');
        return;
    }

    socket = createConnection({
        host: SERVER_HOST,
        port: +SERVER_PORT,
        keepAlive: true,
        timeout: 5000, // Only used for connection timeout. Ignore timeouts if socket is connected.
    });

    socket
        .on('connect', () => {
            logger.info('Connected. Processing jobs.');

            if (null === socket) {
                logger.error('No socket, cannot configure');
                return;
            }

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
                logger.warning('Received an unknwown command, ignore it', { command: string });
                return;
            }

            if (null === socket) {
                logger.error('No socket, cannot process data');
                return;
            }

            const [, token, jobDataJson] = matches;
            const jobData: HexJobData = JSON.parse(jobDataJson);

            logger.debug('Received a job. Processing it...');

            try {
                const result = await processJob(jobData);
                socket.write(`job_result ${token} ${JSON.stringify({success: true, result})}`);
            } catch (error) {
                if (error instanceof Error) {
                    logger.error('Error while processing job by AI', {
                        name: error.name,
                        msg: error.message,
                        stack: error.stack,
                    });
                } else {
                    console.error(error);
                }
                socket.write(`job_result ${token} ${JSON.stringify({success: false, error})}`);
                return;
            }

            logger.info('Job processed successfully.');
        })

        .on('error', error => {
            logger.error('Error... Closing connection', { error });

            if (null === socket) {
                return;
            }

            socket.end();
            socket.destroy();
            socket = null;
        })

        .on('close', async () => {
            logger.notice('Connection to server closed, trying to reconnect...');

            if (null !== socket) {
                socket.destroy();
                socket = null;
            }

            await setTimeout(2000);
            connectAndProcess();
        })

        .on('timeout', async () => {
            if (null !== socket) {
                if (!socket.connecting) {
                    return;
                }

                socket.destroy();
                socket = null;
            }

            logger.notice('Timeout while connecting to server, trying to reconnect...');

            await setTimeout(2000);
            connectAndProcess();
        })
    ;
};

(async () => {
    logger.info('Waiting for Mohex to be ready...');
    logger.info(await mohex.version());
    logger.info('Mohex ready');

    logger.info('Waiting for Katahex to be ready...');
    logger.info(await katahex.version());
    logger.info('Katahex ready');

    logger.info('Connecting to server...');
    connectAndProcess();
})();
