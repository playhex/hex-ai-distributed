import { Socket } from 'node:net';
import { HexJobData, HexJobResult } from '../shared';
import logger from '../shared/logger';

export class Peer
{
    /**
     * Whether this peers is already processing a job.
     */
    private locked: boolean = false;

    /**
     * Benchmark result.
     * A peer with high power will be selected first to process a task.
     */
    private power: number = 1;

    /**
     * If true, this peer will never be selected,
     * unless all connected peers are secondary.
     *
     * Used for slow peers, or peer sharing the same machine as the hex website.
     */
    private secondary = false;

    constructor(
        private socket: Socket,
    ) {}

    getPower(): number
    {
        return this.power;
    }

    setPower(power: number): void
    {
        this.power = power;
    }

    getSecondary(): boolean
    {
        return this.secondary;
    }

    setSecondary(secondary: boolean): void
    {
        this.secondary = secondary;
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
