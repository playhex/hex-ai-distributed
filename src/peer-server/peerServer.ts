import { createServer } from 'node:net';
import { hexJobDistributer } from './HexJobDistributer';
import { Peer } from './Peer';
import logger from '../shared/logger';
import { benchmarkPeer } from './peer-benchmark';

const peerServer = createServer({
    keepAlive: true,
    keepAliveInitialDelay: 1000,
    allowHalfOpen: false,
});

peerServer.on('connection', async socket => {

    logger.debug('A socket connected to server');

    socket.on('data', data => {
        const string = data.toString();

        if (string.startsWith('set_secondary ')) {
            const secondary = JSON.parse(string.substring('set_secondary '.length));

            if (typeof secondary === 'boolean') {
                peer.setSecondary(secondary);
            }
        }
    });

    const peer = new Peer(socket);

    try {
        logger.debug('Benchmarking this socket...');
        const benchmarkResult = await benchmarkPeer(peer);
        logger.debug('Benchmarking done, power = ' + benchmarkResult);

        peer.setPower(benchmarkResult);
    } catch (e) {
        logger.notice('A peer failed its benchmark', { e });
        socket.end();
        return;
    }

    hexJobDistributer.addPeer(peer);

    socket.on('close', () => hexJobDistributer.removePeer(peer));

    socket.on('timeout', () => {
        logger.notice('Lost connection with a peer (keep alive). Removing it.');
        hexJobDistributer.removePeer(peer);
    });

    socket.on('error', e => {
        logger.notice('Error with a peer socket. Removing it.', { errorMessage: e.message, errorName: e.name });
        hexJobDistributer.removePeer(peer);
    });
});

export default peerServer;
