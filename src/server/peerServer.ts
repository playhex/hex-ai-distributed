import { createServer } from 'node:net';
import { hexJobDistributer } from './HexJobDistributer';
import { Peer } from './Peer';
import { HexJobData } from '../shared';
import logger from '../shared/logger';
import typia from 'typia';

const peerServer = createServer({
    keepAlive: true,
    allowHalfOpen: false,
});

const benchmarkJob: HexJobData = {
    game: {
        size: 9,
        movesHistory: 'f4',
        currentPlayer: 'white',
        swapRule: false,
    },
    ai: {
        engine: 'mohex',
        maxGames: 2000,
    },
};

/**
 * Sends a standard job to peer to check if it responds well,
 * and measure time to process the job to estimate its speed.
 */
const benchmarkPeer = async (peer: Peer): Promise<number> => {
    const ms0 = new Date().getTime();
    const hexJobResult = await peer.processJob(benchmarkJob);
    const ms1 = new Date().getTime();

    typia.assert(hexJobResult);

    if (!hexJobResult.success) {
        throw new Error('Benchmark job returned an error: ' + hexJobResult.error);
    }

    return 1E6 / (ms1 - ms0);
};

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
});

export default peerServer;
