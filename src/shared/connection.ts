import Redis from 'ioredis';
import logger from './logger';

const { REDIS_URL } = process.env;

if (!REDIS_URL) {
    throw new Error('Cannot start, requires REDIS_URL=redis://...');
}

logger.debug('Connection to redis ' + REDIS_URL);

const connection = new Redis(REDIS_URL, {
    maxRetriesPerRequest: null,
});

logger.info('Connected to redis ' + REDIS_URL);

export default connection;
