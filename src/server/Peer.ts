import { Socket } from 'node:net';
import { HexJobData, HexJobResult, PeerConfig, defaultConfig } from '../shared';
import logger from '../shared/logger';

export class Peer
{
    /**
     * Whether this peers is already processing a job.
     */
    private locked: boolean = false;

    private config: PeerConfig = defaultConfig;

    constructor(
        private socket: Socket,
    ) {}

    getConfig(): PeerConfig
    {
        return this.config;
    }

    setConfig(config: PeerConfig): void
    {
        logger.debug('peer update its config', config);

        this.config = {
            ...this.config,
            ...config,
        };

        logger.info('peer config has been updated', this.config);
    }

    isLocked(): boolean
    {
        return this.locked;
    }

    lock(): void
    {
        if (this.locked) {
            logger.warning('Lock peer: already locked');
            return;
        }

        this.locked = true;
    }

    unlock(): void
    {
        if (!this.locked) {
            logger.warning('Unlock peer: already unlocked');
            return;
        }

        this.locked = false;
    }

    async processJob(jobData: HexJobData): Promise<HexJobResult>
    {
        return new Promise((resolve, reject) => {
            const token = Math.floor(Math.random() * 1E12);

            const onClose = () => {
                logger.notice('Socket closed while processing, reject job result promise');
                reject('Socket closed, reject job result promise');
            };

            const onData = (data: Buffer) => {
                const string = data.toString();

                if (string.startsWith(`job_result ${token} `)) {
                    this.socket.off('close', onClose);
                    this.socket.off('data', onData);

                    resolve(JSON.parse(string.substring(`job_result ${token} `.length)));
                }
            };

            this.socket
                .on('close', onClose)
                .on('data', onData)
                .write(`job ${token} ${JSON.stringify(jobData)}`)
            ;
        });
    }
}
