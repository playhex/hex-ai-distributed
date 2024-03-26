import '../../config';
import api from './api';
import peerServer from './peerServer';

const { PEER_SERVER_PORT, PEER_SERVER_API_PORT } = process.env;

if (!PEER_SERVER_PORT || !PEER_SERVER_API_PORT) {
    throw new Error('PEER_SERVER_PORT and PEER_SERVER_API_PORT required in .env to start peer server');
}

peerServer.listen(+PEER_SERVER_PORT);
api.listen(+PEER_SERVER_API_PORT);
