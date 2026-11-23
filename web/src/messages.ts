import type { AiJobType } from '../../src/shared/protocol';
import type { BenchResult } from '../../src/shared/benchTasks';
import type { GpuDetection } from './gpu';

/*
 * Messages between page and compute worker (worker.ts).
 */

export type ToWorker =
    | { type: 'start', key: string, jobTypes: AiJobType[] }
    | { type: 'stop' }

    /** Job types to take from next job */
    | { type: 'setJobTypes', jobTypes: AiJobType[] }

    /** Runs bench jobs, without taking jobs from PlayHex */
    | { type: 'bench' }
;

export type WorkerState =
    /** Downloading or initializing model */
    | 'loading'

    /** Waiting for a job */
    | 'waiting'

    | 'working'
    | 'stopped'

    /** Server unreachable, retrying */
    | 'offline'
;

export type FromWorker =
    | { type: 'state', state: WorkerState }
    /** Model running on GPU */
    | {
        type: 'gpu',
        name: string,
        float16: boolean,
        engine: 'WebGpuNetwork' | 'onnxruntime',

        /**
         * Optimizations used, shown on page.
         */
        details: string[],

        /** Download, or read from cache, and GPU setup */
        loadMs: number,
    }

    /** No hardware WebGPU, worker cannot run */
    | { type: 'noGpu', detection: Exclude<GpuDetection, { ok: true }> }
    | { type: 'modelProgress', loaded: number, total: number }
    | { type: 'job', jobType: AiJobType, size: number, maxPlayouts: number }
    | { type: 'playouts', playouts: number, maxPlayouts: number }
    | { type: 'jobDone', jobType: AiJobType, size: number, durationMs: number, accepted: boolean }

    /** Key refused, worker stopped */
    | { type: 'unauthorized' }

    | { type: 'error', message: string }

    | { type: 'benchResult', result: BenchResult }

    /** One model run with batchSize positions, on 11x11 */
    | { type: 'benchModel', batchSize: number, msPerRun: number }

    /** Where time goes in a benchmark job, to debug slow workers */
    | { type: 'benchStats', jobType: AiJobType, modelBusyPercent: number, runs: number, positionsPerRun: number, cacheHitPercent: number | null }
    | { type: 'benchDone' }
;
