import Redis from 'ioredis';
import { Job, Queue, QueueEvents, QueueOptions, Worker, WorkerOptions } from 'bullmq';
import { HexJobData, HexJobResult } from '../shared';
import { TypedEmitter } from 'tiny-typed-emitter';
import { Peer } from './Peer';
import logger from '../shared/logger';

const { REDIS_URL } = process.env;

if (!REDIS_URL) {
    throw new Error('Cannot start, requires REDIS_URL=redis://...');
}

logger.debug('Connection to redis ' + REDIS_URL);

const connection = new Redis(REDIS_URL, {
    maxRetriesPerRequest: null,
});

logger.info('Connected to redis ' + REDIS_URL);

const TOKEN = 'HexJobDistributer';
const QUEUE_NAME = 'hex_jobs';

const queueOptions: QueueOptions = {
    connection,
    defaultJobOptions: {
        attempts: 10,
        removeOnComplete: {
            age: 24 * 3600,
            count: 1000,
        },
        removeOnFail: {
            age: 24 * 3600,
            count: 1000,
        },
    },
};

const workerOptions: WorkerOptions = {
    connection,
    maxStalledCount: 3,
    stalledInterval: 10000,
    lockDuration: 20000,
};

interface PeerListEvents
{
    peerAvailable: (peer: Peer) => void;
}

export class HexJobDistributer extends TypedEmitter<PeerListEvents>
{
    private peers: Peer[] = [];

    private queue = new Queue<HexJobData, HexJobResult>(QUEUE_NAME, queueOptions);
    private queueEvents = new QueueEvents(QUEUE_NAME, { connection });

    private worker: Worker;

    constructor()
    {
        super();

        // As soon as API has been offline, all previous move requests have been cancelled.
        // So no need to keep previous move jobs in queue.
        this.queue.obliterate({
            force: true,
        });

        this.worker = new Worker(QUEUE_NAME, null, workerOptions);

        this.worker.startStalledCheckTimer();

        this.startProcessing();
    }

    addPeer(peer: Peer): void
    {
        this.peers.push(peer);

        logger.info('Peer connected. Peers count: ' + this.peers.length);

        this.emit('peerAvailable', peer);
    }

    removePeer(peer: Peer): void
    {
        const index = this.peers.indexOf(peer);

        if (index < 0) {
            return;
        }

        this.peers.splice(index, 1);

        logger.info('Peer disconnected. Peers count: ' + this.peers.length);
    }

    /**
     * Get best available peer and put a lock on it.
     * Unlock the peer to make it available again with:
     *
     *  peer.unlock()
     */
    async acquirePeer(): Promise<Peer>
    {
        let peers = this.peers.filter(peer => !peer.getConfig().secondary);

        if (0 === peers.length) {
            peers = this.peers;
        }

        peers = peers.filter(peer => !peer.isLocked());

        if (0 === peers.length) {
            return new Promise(resolve => {
                this.once('peerAvailable', () => resolve(this.acquirePeer()));
            });
        }

        const bestPeer = peers.reduce(
            (bestPeer, peer) => peer.getConfig().power > bestPeer.getConfig().power
                ? peer
                : bestPeer
            ,
        );

        bestPeer.lock();

        return bestPeer;
    }

    getQueue()
    {
        return this.queue;
    }

    private async startProcessing(): Promise<void>
    {
        logger.info('Distributer starts processing');

        while (true) {
            let job: undefined | Job = undefined;

            while (!job) {
                job = await this.worker.getNextJob(TOKEN);

                if (!job) {
                    logger.debug('no job, wait for new event...');
                    await new Promise(resolve => this.queueEvents.once('waiting', resolve));
                }
            }

            logger.debug('Job fetched', job.data);

            let peer: null | Peer = null;

            logger.debug('getting best available peer...');
            peer = await this.acquirePeer();
            logger.info('Sending job to peer...', job.data);

            (async () => {
                try {
                    const result = await peer.processJob(job.data);

                    logger.debug('peer finished job, result: ' + result);

                    await job.moveToCompleted(result, TOKEN, false);
                    logger.info('Job completed');
                } catch (e) {
                    job.moveToFailed(new Error('Error: ' + e), TOKEN, false);
                    logger.notice('Job failed');
                } finally {
                    if (peer) {
                        peer.unlock();
                        this.emit('peerAvailable', peer);
                    }
                }
            })();
        }
    }

    async processJob(jobData: HexJobData): Promise<HexJobResult> {
        const job = await this.queue.add('move', jobData);

        return await job.waitUntilFinished(this.queueEvents);
    }
}
