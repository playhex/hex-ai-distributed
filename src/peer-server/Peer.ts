import { Socket } from 'node:net';
import logger from '../shared/logger';
import typia from 'typia';
import { WorkerTaskJobInput, WorkerTaskJobOutput } from '../shared/model/WorkerTask';

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

    isPrimary(): boolean
    {
        return !this.secondary;
    }

    isSecondary(): boolean
    {
        return this.secondary;
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

    async sendJob(jobData: WorkerTaskJobInput): Promise<WorkerTaskJobOutput>
    {
        return new Promise((resolve, reject) => {
            const token = Math.floor(Math.random() * 1E12);

            const onClose = () => {
                logger.notice('Socket closed while processing, reject job result promise');
                reject(new Error('Socket closed, reject job result promise'));
            };

            const onData = (data: Buffer) => {
                const string = data.toString();
                logger.debug(`Data received from worker: ${string}`);

                if (string.startsWith(`job_result ${token} `)) {
                    this.socket.off('close', onClose);
                    this.socket.off('data', onData);

                    const peerResult = typia.assert<WorkerTaskJobOutput>(JSON.parse(string.substring(`job_result ${token} `.length)));

                    resolve(peerResult);
                }
            };

            logger.debug(`Send to peer: job ${token} ${JSON.stringify(jobData)}`);

            this.socket
                .on('close', onClose)
                .on('data', onData)
                .write(`job ${token} ${JSON.stringify(jobData)}`)
            ;
        });
    }
}
