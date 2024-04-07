import { Job } from 'bullmq';
import { TypedEmitter } from 'tiny-typed-emitter';
import { Peer } from './Peer';
import logger from '../shared/logger';
import { createWorkerTasksWorker, workerTasksQueueEvents } from '../shared/queue/workerTasks';
import { WorkerTaskJobInput, WorkerTaskJobOutput } from '../shared/model/WorkerTask';
import { createAnalyzeWorker } from '../shared/queue/analyze';

interface PeerListEvents
{
    peerAvailable: (peer: Peer) => void;
    peerConnected: (peer: Peer) => void;
    peerDisconnected: (peer: Peer) => void;
}

const TOKEN = 'HexJobDistributerKey';

export class HexJobDistributer extends TypedEmitter<PeerListEvents>
{
    private peers: Peer[] = [];

    private worker = createWorkerTasksWorker();
    private analyzesConsolidationWorker = createAnalyzeWorker();

    constructor()
    {
        super();

        this.worker.startStalledCheckTimer();

        this.startProcessing();
    }

    getPeers(): Peer[]
    {
        return this.peers;
    }

    addPeer(peer: Peer): void
    {
        this.peers.push(peer);

        logger.info('Peer connected. Peers count: ' + this.peers.length);

        this.emit('peerConnected', peer);
        this.emit('peerAvailable', peer);
    }

    removePeer(peer: Peer): void
    {
        const index = this.peers.indexOf(peer);

        if (index < 0) {
            return;
        }

        this.peers.splice(index, 1);

        this.emit('peerDisconnected', peer);

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
        let peers = this.peers.filter(peer => !peer.getSecondary());

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
            (bestPeer, peer) => peer.getPower() > bestPeer.getPower()
                ? peer
                : bestPeer
            ,
        );

        bestPeer.lock();

        return bestPeer;
    }

    private async startProcessing(): Promise<void>
    {
        logger.info('Distributer starts processing');

        while (true) {
            let job: undefined | Job<WorkerTaskJobInput, WorkerTaskJobOutput> = undefined;

            while (!job) {
                job = await this.worker.getNextJob(TOKEN);

                if (!job) {
                    logger.debug('no job, wait for new event...');
                    await new Promise(resolve => workerTasksQueueEvents.once('waiting', resolve));
                }
            }

            logger.debug('Job fetched', job.data);

            let peer: null | Peer = null;

            logger.debug('getting best available peer...');
            peer = await this.acquirePeer();
            logger.info('Sending job to peer...', job.data);

            (async () => {
                try {
                    const result = await peer.sendJob(job.data);

                    logger.debug('peer finished job, result: ' + JSON.stringify(result));

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

    getAnalyzeConsolidationWorker()
    {
        return this.analyzesConsolidationWorker;
    }
}

export const hexJobDistributer = new HexJobDistributer();
