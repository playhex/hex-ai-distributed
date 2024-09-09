import express, { Response, json } from 'express';
import logger from '../shared/logger';
import mountBullUI from './bullUI';
import typia, { TypeGuardError } from "typia";
import { addAnalyzeToQueue, analyzesQueue } from '../shared/queue/analyze';
import { addWorkerTaskToQueue, workerTasksQueue } from '../shared/queue/workerTasks';
import { CalculateMoveInput } from '../shared/model/CalculateMove';
import { AnalyzeGameInput } from '../shared/model/AnalyzeGame';
import { getPositions, logPositionAnalyzed } from './dbLog';

const api = express();

api.get('/ping', (req, res) => {
    res.send('pong');
});

api.post('/calculate-move', json(), async (req, res) => {
    try {
        logger.info('move requested, queuing to distributer');

        const calculateMoveInput = typia.assert<CalculateMoveInput>(req.body);

        logPositionAnalyzed('move', calculateMoveInput.game.movesHistory, req.ip ?? '');

        const result = await addWorkerTaskToQueue({
            type: 'calculate-move',
            data: calculateMoveInput,
        });

        logger.info('distributer processed move, sending to client the result:', result);

        if (result.success) {
            res.send(result.data);
        } else {
            res.status(400).send(result.error);
        }
    } catch (e) {
        if (!(e instanceof TypeGuardError)) {
            logger.error('Error while /calculate-move', e);
            res.status(400).send(e);
            return;
        }

        logger.warning('error while validating request body input', e);
        res.status(400).send(e.message);
    }
});

api.post('/analyze-game', json(), async (req, res) => {
    try {
        const analyzeGameInput = typia.assert<AnalyzeGameInput>(req.body);
        logger.info('review requested, queuing to distributer');
        logger.debug(`review data: size: ${analyzeGameInput.size} movesHistory: ${analyzeGameInput.movesHistory}`);

        logPositionAnalyzed('analyze', analyzeGameInput.movesHistory, req.ip ?? '');

        const result = await addAnalyzeToQueue(analyzeGameInput);
        logger.info('distributer processed move, sending to client the result:', result);

        if (result.success) {
            res.send(result.data);
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

const { PEER_SERVER_API_HOST, PEER_SERVER_API_PORT } = process.env;

if (!PEER_SERVER_API_HOST || !PEER_SERVER_API_PORT) {
    throw new Error('PEER_SERVER_API_HOST and PEER_SERVER_API_PORT must be set in .env');
}

api.get('/status', async (req, res) => {
    const peerStatusEndpoint = `http://${PEER_SERVER_API_HOST}:${PEER_SERVER_API_PORT}/status`;

    logger.debug(`GET ${peerStatusEndpoint}...`);

    const response = await fetch(peerStatusEndpoint);

    res.send(await response.json());
});

api.get('/processed-positions', async (req, res) => {
    res.send(await getPositions({
        createdBefore: req.query.createdBefore as string | undefined,
        createdAfter: req.query.createdAfter as string | undefined,
    }));
});

mountBullUI(api, '/bull', [
    workerTasksQueue,
    analyzesQueue,
]);

export default api;
