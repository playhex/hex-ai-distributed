import { InfluxDBClient, Point } from '@influxdata/influxdb3-client';
import logger from '../shared/logger';
import { hexJobDistributer } from './HexJobDistributer';
import { workerTasksQueue, workerTasksQueueEvents } from '../shared/queue/workerTasks';

/**
 * If INFLUX_ env vars set,
 * monitor some metrics from peer server:
 *  - number of peer connected
 */
(() => {
    const { INFLUX_HOST, INFLUX_TOKEN, INFLUX_DATABASE } = process.env;

    if (!INFLUX_HOST || !INFLUX_TOKEN || !INFLUX_DATABASE) {
        return;
    }

    logger.info('Monitoring enabled');

    const client = new InfluxDBClient({
        host: INFLUX_HOST,
        token: INFLUX_TOKEN,
        database: INFLUX_DATABASE,
    });

    /*
     * Monitor connected peers, check how many are connected, when they connect or disconnect...
     */

    const updatePeersCount = (): void => {
        const peers = hexJobDistributer.getPeers();
        const primaryPeers: number = peers.filter(peer => peer.isPrimary()).length;
        const secondaryPeers: number = peers.filter(peer => peer.isSecondary()).length;

        const point = Point
            .measurement('peers_connected')
            .setIntegerField('primary', primaryPeers)
            .setIntegerField('secondary', secondaryPeers)
        ;

        logger.debug('monitor send data', { primaryPeers, secondaryPeers });

        client.write(point).catch(reason => {
            logger.warning('Error while sending monitoring data', { reason });
        });
    };

    hexJobDistributer.on('peerConnected', updatePeersCount);
    hexJobDistributer.on('peerDisconnected', updatePeersCount);

    /*
     * Monitor queue size, how many peer are working, how many jobs are waiting in queue...
     */

    const updateQueueState = async (date: null | Date = null): Promise<void> => {
        const jobCounts = await workerTasksQueue.getJobCounts(); // Example: {"active":0,"completed":63,"delayed":0,"failed":0,"paused":0,"prioritized":9,"waiting":0,"waiting-children":0}

        const waitingCount = jobCounts.prioritized + jobCounts.waiting;
        const activeCount = jobCounts.active;

        logger.debug('monitor send data, queue state', { activeCount, waitingCount });

        const point = Point
            .measurement('queue_state')
            .setIntegerField('activeCount', activeCount)
            .setIntegerField('waitingCount', waitingCount)
        ;

        if (date) {
            point.setTimestamp(date);
        }

        client.write(point).catch(reason => {
            logger.warning('Error while sending monitoring data', { reason });
        });
    };

    /**
     * Prevent sending unecessary points:
     *
     * - on new job, if there is an available peer, the waiting count is still incremented and decremented quickly
     * - when a peer take a job from waiting queue, the active count is decremented and incremented quickly
     *
     * In both case, do not show a peak, but only send last point to smooth it.
     * So on new point, always wait 10 more milliseconds before sending it, and send the last one if not more point.
     */
    const updateQueueStateDebounced = (): () => void => {
        const wait = 10;
        let timeout: null | NodeJS.Timeout = null;
        let date: null | Date = null;

        return () => {
            if (null !== timeout) {
                clearTimeout(timeout);
            }

            date = new Date();

            timeout = setTimeout(() => {
                updateQueueState(date);
                timeout = null;
                date = null;
            }, wait);
        };
    };

    const listenerDebounced = updateQueueStateDebounced();

    workerTasksQueueEvents.on('waiting', listenerDebounced);
    workerTasksQueueEvents.on('completed', listenerDebounced);
    workerTasksQueueEvents.on('active', listenerDebounced);
})();
