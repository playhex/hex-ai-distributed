import './config';
import express, { json } from 'express';
import { createServer } from 'node:net';
import { HexJobDistributer } from './HexJobDistributer';
import { Peer } from './Peer';
import logger from '../shared/logger';
import mountBullUI from './bullUI';

const hexJobDistributer = new HexJobDistributer();

const server = createServer();

server.on('connection', socket => {
    const peer = new Peer(socket);
    hexJobDistributer.addPeer(peer);

    socket.on('data', data => {
        const string = data.toString();

        if (string.startsWith('config ')) {
            const config = JSON.parse(string.substring('config '.length));

            peer.setConfig(config);
        }
    });

    socket.on('close', () => hexJobDistributer.removePeer(peer));
});

server.listen(8089);

const api = express();

api.post('/calculate-move', json(), async (req, res) => {
    logger.info('move requested, queued to distributer');

    const result = await hexJobDistributer.processJob(req.body);

    logger.info('distributer processed move, sending to client the result:', result);

    res.send(result);
});

api.get('/ping', (req, res) => res.send('pong'));

mountBullUI(api, '/bull', [hexJobDistributer.getQueue()]);

api.listen(8088);
