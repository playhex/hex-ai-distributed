import { AiJobType, AiTask, HEARTBEAT_MS, ReservedJob } from './protocol';

/*
 * Http client of PlayHex AI workers api, see protocol.ts.
 * Only uses fetch, so that it runs in node and in browsers.
 */

/**
 * Key is invalid or revoked, worker must stop.
 */
export class UnauthorizedError extends Error {}

/**
 * Worker does not own the job anymore (lock expired and job given to another worker).
 */
export class JobNotOwnedError extends Error {}

export type ProcessJobOutcome =
    /** Result accepted by server, or failure reported */
    | { status: 'done', failed: boolean, error?: Error }

    /** Job given to another worker while processing, result not sent or ignored */
    | { status: 'abandoned' }

    /** Server refused the result */
    | { status: 'refused', httpStatus: number, message: string }
;

export type ProcessJobOptions = {
    /**
     * Whether a job that failed with this error should be given to another worker.
     */
    isRetryable: (error: Error) => boolean;

    /**
     * Called when a heartbeat could not be sent, job continues.
     */
    onHeartbeatError?: (error: Error) => void;

    /**
     * Called as soon as server gives job to another worker, i.e to stop processing it.
     */
    onNotOwned?: () => void;
};

export default class AiWorkerClient
{
    /**
     * @param assertReservedJob Validates job received from server, throws if invalid.
     */
    constructor(
        private hexUrl: string,
        private key: string,
        readonly workerId: string,
        private assertReservedJob: (data: unknown) => ReservedJob = data => data as ReservedJob,
    ) {
        this.hexUrl = hexUrl.replace(/\/+$/, '');
    }

    /**
     * @throws {UnauthorizedError}
     * @throws {JobNotOwnedError}
     */
    private async api(path: string, body: object, init?: { signal?: AbortSignal, keepalive?: boolean }): Promise<Response>
    {
        const response = await fetch(`${this.hexUrl}/api/ai-workers${path}`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${this.key}`,
                'Content-Type': 'application/json',
                'Accept': 'application/json',
            },
            body: JSON.stringify({ workerId: this.workerId, ...body }),
            ...init,
        });

        if (401 === response.status || 403 === response.status) {
            throw new UnauthorizedError(await response.text());
        }

        if (409 === response.status) {
            throw new JobNotOwnedError(await response.text());
        }

        return response;
    }

    /**
     * Waits for a job, up to LONG_POLL_MS.
     *
     * @returns Next job, or null if there is no job yet.
     */
    async next(types: AiJobType[], { signal }: { signal?: AbortSignal } = {}): Promise<null | ReservedJob>
    {
        const response = await this.api('/jobs/next', { types }, { signal });

        if (204 === response.status) {
            return null;
        }

        if (!response.ok) {
            throw new Error(`Server responded ${response.status}: ${await response.text()}`);
        }

        return this.assertReservedJob(await response.json());
    }

    /**
     * Gives back job so that another worker processes it, or fails it definitively if not retryable.
     */
    async fail(job: ReservedJob, error: string, retryable: boolean): Promise<Response>
    {
        return await this.api(`/jobs/${job.jobId}/fail`, { token: job.token, error: error.substring(0, 1000), retryable });
    }

    /**
     * Tells server this worker stops, so it is not considered online anymore.
     *
     * @param keepalive Request still sent if page is closing, for browsers.
     */
    async disconnect({ signal, keepalive }: { signal?: AbortSignal, keepalive?: boolean } = {}): Promise<void>
    {
        await this.api('/disconnect', {}, { signal, keepalive });
    }

    /**
     * Sends heartbeats while job is processing.
     * Calls onNotOwned if server says job has been given to another worker.
     *
     * @returns Function to stop heartbeats.
     */
    startHeartbeats(job: ReservedJob, onNotOwned: () => void, onError?: (error: Error) => void): () => void
    {
        const interval = setInterval(() => {
            this.api(`/jobs/${job.jobId}/heartbeat`, { token: job.token })
                .catch(e => {
                    if (e instanceof JobNotOwnedError) {
                        onNotOwned();
                        return;
                    }

                    onError?.(e instanceof Error ? e : new Error(String(e)));
                })
            ;
        }, HEARTBEAT_MS);

        return () => clearInterval(interval);
    }

    /**
     * Processes a job while sending heartbeats, then sends its result, or its failure.
     *
     * @throws {UnauthorizedError}
     * @throws {Error} When result or failure could not be sent.
     */
    async processJob(job: ReservedJob, process: (task: AiTask) => Promise<unknown>, options: ProcessJobOptions): Promise<ProcessJobOutcome>
    {
        let abandoned = false;

        const stopHeartbeats = this.startHeartbeats(job, () => {
            abandoned = true;
            options.onNotOwned?.();
        }, options.onHeartbeatError);

        let path: string;
        let body: object;
        let error: undefined | Error;

        try {
            const result = await process(job.task);

            path = `/jobs/${job.jobId}/result`;
            body = { token: job.token, result };
        } catch (e) {
            error = e instanceof Error ? e : new Error(String(e));

            path = `/jobs/${job.jobId}/fail`;
            body = { token: job.token, error: error.message.substring(0, 1000), retryable: options.isRetryable(error) };
        } finally {
            stopHeartbeats();
        }

        if (abandoned) {
            return { status: 'abandoned' };
        }

        try {
            const response = await this.api(path, body);

            if (!response.ok) {
                return { status: 'refused', httpStatus: response.status, message: await response.text() };
            }

            return { status: 'done', failed: undefined !== error, error };
        } catch (e) {
            if (e instanceof JobNotOwnedError) {
                return { status: 'abandoned' };
            }

            throw e;
        }
    }
}
