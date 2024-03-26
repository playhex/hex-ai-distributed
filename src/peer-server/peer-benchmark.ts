import typia from 'typia';
import { Peer } from './Peer';
import logger from '../shared/logger';
import { WorkerTaskJobInput } from '../shared/model/WorkerTask';

/**
 * Same job sent to all new peer to benchmark its computation speed
 */
const benchmarkJob: WorkerTaskJobInput = {
    type: 'calculate-move',
    data: {
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
    }
};

/**
 * Sends a standard job to peer to check if it responds well,
 * and measure time to process the job to estimate its speed.
 */
export const benchmarkPeer = async (peer: Peer): Promise<number> => {
    const ms0 = new Date().getTime();
    logger.debug('Sending benchmark job...', { benchmarkJob });
    const hexJobResult = await peer.sendJob(benchmarkJob);
    const ms1 = new Date().getTime();

    typia.assert(hexJobResult);

    if (!hexJobResult.success) {
        throw new Error('Benchmark job returned an error: ' + hexJobResult.error);
    }

    return 1E6 / (ms1 - ms0);
};
