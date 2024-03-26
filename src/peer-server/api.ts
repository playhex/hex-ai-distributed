import express from 'express';
import { hexJobDistributer } from './HexJobDistributer';

const api = express();

api.get('/ping', (req, res) => {
    res.send('pong');
});

api.get('/status', (req, res) => {
    const peers = hexJobDistributer.getPeers();

    res.send({
        totalPeers: peers.length,
        totalPeersPrimary: peers.filter(peer => peer.isPrimary()).length,
        totalPeersSecondary: peers.filter(peer => peer.isSecondary()).length,
        peers: peers.map(peer => ({
            power: peer.getPower(),
            secondary: peer.isSecondary(),
            locked: peer.isLocked(),
        })),
    });
});

export default api;
