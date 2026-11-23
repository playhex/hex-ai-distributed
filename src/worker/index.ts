import '../../config';
import { randomUUID } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';
import typia from 'typia';
import logger from '../shared/logger';
import { AiJobType, getAiJobTypeEngine, getEngineAiJobTypes, getEngineDefaultAiJobTypes, isAiJobType, isEngine, ReservedJob } from '../shared/protocol';
import AiWorkerClient, { UnauthorizedError } from '../shared/AiWorkerClient';
import { EngineWorker, IMPLEMENTED_AI_JOB_TYPES, loadEngineWorker } from './engines';
import { GTPEngineError } from './GTPClient';

const { ENGINE, AI_JOB_TYPES, HEX_URL, AI_WORKER_KEY } = process.env;

if (!isEngine(ENGINE)) {
    throw new Error(`ENGINE must be set to one of: katahex, mohex, davies. Got "${ENGINE}"`);
}

if (!HEX_URL || !AI_WORKER_KEY) {
    throw new Error('HEX_URL and AI_WORKER_KEY must be set in env vars. Ask a key to PlayHex admins.');
}

const engine = ENGINE;

/**
 * Job types this worker processes.
 * By default, job types of its engine, except opt-in ones (i.e katahex-mcts-*) which must be explicitly set.
 */
let jobTypes: AiJobType[] = AI_JOB_TYPES
    ? AI_JOB_TYPES.split(',').map(type => type.trim()).filter(type => '' !== type).map(type => {
        if (!isAiJobType(type) || getAiJobTypeEngine(type) !== engine) {
            throw new Error(`AI_JOB_TYPES: "${type}" is not a job type of ${engine}. Expected some of: ${getEngineAiJobTypes(engine).join(', ')}`);
        }

        if (!IMPLEMENTED_AI_JOB_TYPES.includes(type)) {
            throw new Error(`AI_JOB_TYPES: "${type}" is not yet implemented by this worker`);
        }

        return type;
    })
    : getEngineDefaultAiJobTypes(engine)
;

if (0 === jobTypes.length) {
    throw new Error('AI_JOB_TYPES must contain at least one job type, or be empty to process default job types of engine');
}

const hexUrl = HEX_URL.replace(/\/+$/, '');

/**
 * Identifies this worker process, a same key can be used by multiple workers.
 */
const workerId = randomUUID();

const client = new AiWorkerClient(hexUrl, AI_WORKER_KEY, workerId, data => typia.assert<ReservedJob>(data));

/**
 * Delay before retrying when server is unreachable, doubled on each consecutive error.
 */
const MIN_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 60_000;

/**
 * Do not delay worker stop too long when server is unreachable.
 */
const DISCONNECT_TIMEOUT_MS = 2000;

let stopping = false;
let currentJob: null | ReservedJob = null;
const stopController = new AbortController();

/**
 * Tells server this worker stops, so it is not considered online anymore, then exits.
 */
const disconnectAndExit = async (): Promise<never> => {
    try {
        await client.disconnect({ signal: AbortSignal.timeout(DISCONNECT_TIMEOUT_MS) });
    } catch (e) {
        logger.warning('Could not notify server of disconnection', { message: e instanceof Error ? e.message : String(e) });
    }

    process.exit(0);
};

const processJob = async (engineWorker: EngineWorker, reservedJob: ReservedJob): Promise<void> => {
    const { jobId, task } = reservedJob;

    logger.info('Processing job', { jobId, type: task.type });

    const outcome = await client.processJob(reservedJob, task => engineWorker.process(task), {
        // Engine crashed or timed out: another worker may process it. Else task itself is not processable.
        isRetryable: error => error instanceof GTPEngineError,
        onHeartbeatError: error => logger.warning('Could not send heartbeat', { jobId, message: error.message }),
    });

    switch (outcome.status) {
        case 'abandoned':
            logger.notice('Job has been given to another worker, abandoning it', { jobId });
            return;

        case 'refused':
            logger.error('Server refused job result', { jobId, status: outcome.httpStatus, message: outcome.message });
            return;

        case 'done':
            if (outcome.error) {
                logger.error('Error while processing job', { jobId, type: task.type, message: outcome.error.message, retryable: outcome.error instanceof GTPEngineError });
            }

            logger.info('Job done', { jobId });
    }
};

const run = async (engineWorker: EngineWorker): Promise<void> => {
    let backoffMs = MIN_BACKOFF_MS;
    let disconnected = false;

    while (!stopping) {
        try {
            currentJob = await client.next(jobTypes, { signal: stopController.signal });

            if (disconnected) {
                disconnected = false;
                logger.info('Reconnected to server');
            }

            if (null !== currentJob) {
                await processJob(engineWorker, currentJob);
                currentJob = null;
            }

            backoffMs = MIN_BACKOFF_MS;
        } catch (e) {
            currentJob = null;

            if (stopping) {
                break;
            }

            if (e instanceof UnauthorizedError) {
                logger.crit('AI worker key refused by server, stopping. Is the key valid, or has it been revoked?', { message: e.message });
                process.exit(1);
            }

            disconnected = true;
            logger.warning(`Server error, retrying in ${backoffMs / 1000}s`, { message: e instanceof Error ? e.message : String(e) });

            await setTimeout(backoffMs);
            backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
        }
    }

    logger.info('Worker stopped.');
    await disconnectAndExit();
};

/**
 * First signal: finish current job then stop.
 * Second signal: give back current job to server so another worker takes it, then stop.
 */
const onStopSignal = (): void => {
    if (!stopping) {
        stopping = true;
        stopController.abort();

        if (null !== currentJob) {
            logger.info('Stopping after current job. Send signal again to stop now.');
        }

        return;
    }

    const job = currentJob;

    if (null === job) {
        void disconnectAndExit();
        return;
    }

    logger.info('Giving back current job to server...');

    client.fail(job, 'Worker stopped', true)
        .catch(e => logger.warning('Could not give back job', { message: e.message }))
        .finally(() => disconnectAndExit())
    ;
};

process.on('SIGINT', onStopSignal);
process.on('SIGTERM', onStopSignal);

(async () => {
    logger.info(`Starting ${engine} worker...`);

    const engineWorker = await loadEngineWorker(engine);

    logger.info(`Engine ready: ${await engineWorker.version()}`);

    const unavailableJobTypes = jobTypes.filter(type => engineWorker.unavailableJobTypes.includes(type));

    if (unavailableJobTypes.length > 0) {
        // Explicitly requested job types must be processed
        if (AI_JOB_TYPES) {
            throw new Error(`AI_JOB_TYPES: ${unavailableJobTypes.join(', ')} not supported by this ${engine} build, update it`);
        }

        logger.warning(`Not processing ${unavailableJobTypes.join(', ')}: not supported by this ${engine} build, update it`);
        jobTypes = jobTypes.filter(type => !unavailableJobTypes.includes(type));
    }
    logger.info(`Pulling jobs ${jobTypes.join(', ')} from ${hexUrl}, worker id: ${workerId}`);

    await run(engineWorker);
})();
