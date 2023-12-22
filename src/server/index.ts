import './config';
import api from './api';
import peerServer from './peerServer';

peerServer.listen(8089);
api.listen(8088);
