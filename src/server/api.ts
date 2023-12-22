import express, { json } from 'express';
import logger from '../shared/logger';
import mountBullUI from './bullUI';
import { hexJobDistributer } from './HexJobDistributer';
import typia, { TypeGuardError } from "typia";
import { HexJobData } from '../shared';

const api = express();


api.post('/calculate-move', json(), async (req, res) => {
    try {
        const hexJobData = typia.assert<HexJobData>(req.body);
        logger.info('move requested, queued to distributer');

        const result = await hexJobDistributer.processJob(hexJobData);
        logger.info('distributer processed move, sending to client the result:', result);

        if (result.success) {
            res.send(result.result);
        } else {
            res.status(400).send(result.error);
        }
    } catch (e) {
        if (!(e instanceof TypeGuardError)) {
            logger.error('Error while /calculate-move', e);
            res.status(400).send(e);
            return;
        }

        logger.warning('error while validating hexJobData input', e);
        res.status(400).send(e.message);
    }
});

api.get('/status', (req, res) => {
    const peers = hexJobDistributer.getPeers();

    res.send({
        totalPeers: peers.length,
        totalPeersPrimary: peers.filter(peer => !peer.getSecondary()).length,
        totalPeersSecondary: peers.filter(peer => peer.getSecondary).length,
        peers: peers.map(peer => ({
            power: peer.getPower(),
            secondary: peer.getSecondary(),
            locked: peer.isLocked(),
        })),
    });
});

mountBullUI(api, '/bull', [hexJobDistributer.getQueue()]);

export default api;
