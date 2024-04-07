import { InfluxDBClient, Point } from '@influxdata/influxdb3-client';
import logger from '../shared/logger';
import { hexJobDistributer } from './HexJobDistributer';

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
})();