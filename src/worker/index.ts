import '../../config';
import { randomUUID } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';
import typia from 'typia';
import logger from '../shared/logger';
import { AiJobType, getAiJobTypeEngine, getEngineAiJobTypes, getEngineDefaultAiJobTypes, HEARTBEAT_MS, isAiJobType, isEngine, ReservedJob } from '../shared/protocol';
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

/**
 * Delay before retrying when server is unreachable, doubled on each consecutive error.
 */
const MIN_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 60_000;

/**
 * Key is invalid or revoked, worker must stop.
 */
class UnauthorizedError extends Error {}

/**
 * Worker does not own the job anymore (lock expired and job given to another worker).
 */
class JobNotOwnedError extends Error {}

let stopping = false;
let currentJob: null | ReservedJob = null;
const stopController = new AbortController();

const api = async (path: string, body: object, signal?: AbortSignal): Promise<Response> => {
    const response = await fetch(`${hexUrl}/api/ai-workers${path}`, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${AI_WORKER_KEY}`,
            'Content-Type': 'application/json',
            'Accept': 'application/json',
        },
        body: JSON.stringify({ workerId, ...body }),
        signal,
    });

    if (401 === response.status || 403 === response.status) {
        throw new UnauthorizedError(await response.text());
    }

    if (409 === response.status) {
        throw new JobNotOwnedError(await response.text());
    }

    return response;
};

/**
 * @returns Next job, or null if there is no job yet.
 */
const fetchNextJob = async (): Promise<null | ReservedJob> => {
    const response = await api('/jobs/next', { types: jobTypes }, stopController.signal);

    if (204 === response.status) {
        return null;
    }

    if (!response.ok) {
        throw new Error(`Server responded ${response.status}: ${await response.text()}`);
    }

    return typia.assert<ReservedJob>(await response.json());
};

/**
 * Sends heartbeats while job is processing.
 * Calls onNotOwned if server says job has been given to another worker.
 */
const startHeartbeats = (reservedJob: ReservedJob, onNotOwned: () => void): () => void => {
    const interval = setInterval(() => {
        api(`/jobs/${reservedJob.jobId}/heartbeat`, { token: reservedJob.token })
            .catch(e => {
                if (e instanceof JobNotOwnedError) {
                    onNotOwned();
                    return;
                }

                logger.warning('Could not send heartbeat', { jobId: reservedJob.jobId, message: e.message });
            })
        ;
    }, HEARTBEAT_MS);

    return () => clearInterval(interval);
};

const processJob = async (engineWorker: EngineWorker, reservedJob: ReservedJob): Promise<void> => {
    const { jobId, token, task } = reservedJob;
    let abandoned = false;

    logger.info('Processing job', { jobId, type: task.type });

    const stopHeartbeats = startHeartbeats(reservedJob, () => {
        logger.notice('Job has been given to another worker, abandoning it', { jobId });
        abandoned = true;
    });

    let path: string;
    let body: object;

    try {
        const result = await engineWorker.process(task);

        path = `/jobs/${jobId}/result`;
        body = { token, result };
    } catch (e) {
        const error = e instanceof Error ? e : new Error(String(e));

        // Engine crashed or timed out: another worker may process it. Else task itself is not processable.
        const retryable = error instanceof GTPEngineError;

        logger.error('Error while processing job', { jobId, type: task.type, message: error.message, retryable });

        path = `/jobs/${jobId}/fail`;
        body = { token, error: error.message.substring(0, 1000), retryable };
    } finally {
        stopHeartbeats();
    }

    if (abandoned) {
        return;
    }

    try {
        const response = await api(path, body);

        if (!response.ok) {
            logger.error('Server refused job result', { jobId, status: response.status, message: await response.text() });
            return;
        }

        logger.info('Job done', { jobId });
    } catch (e) {
        if (e instanceof JobNotOwnedError) {
            logger.notice('Job has been given to another worker, result ignored', { jobId });
            return;
        }

        throw e;
    }
};

const run = async (engineWorker: EngineWorker): Promise<void> => {
    let backoffMs = MIN_BACKOFF_MS;
    let disconnected = false;

    while (!stopping) {
        try {
            currentJob = await fetchNextJob();

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
    process.exit(0);
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
        process.exit(0);
    }

    logger.info('Giving back current job to server...');

    api(`/jobs/${job.jobId}/fail`, { token: job.token, error: 'Worker stopped', retryable: true })
        .catch(e => logger.warning('Could not give back job', { message: e.message }))
        .finally(() => process.exit(0))
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
