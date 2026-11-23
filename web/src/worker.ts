/*
 * Compute worker: loads model, pulls katahex jobs from PlayHex, runs tree search.
 * In a Web Worker so that page stays responsive.
 */

import * as ort from 'onnxruntime-web/webgpu';
import AiWorkerClient, { UnauthorizedError } from '../../src/shared/AiWorkerClient';
import { AiJobType, AiTask } from '../../src/shared/protocol';
import { processJobKatahexMcts } from '../../src/worker/task/mcts/mcts-move';
import { analyzePositionMcts } from '../../src/worker/task/mcts/mcts-analyze-position';
import { analyzeMoveMcts } from '../../src/worker/task/mcts/mcts-analyze-move';
import { processJobKatahex } from '../../src/worker/task/intuition/intuition-move';
import { analyzePosition } from '../../src/worker/task/intuition/analyze-position';
import { analyzeGame } from '../../src/worker/task/intuition/analyze-game';
import { runBench } from '../../src/shared/benchTasks';
import { CachedEvaluator, NN_POLICY_TEMPERATURE, OnnxEvaluator, type EvaluationRequest, type OrtSession } from '../../mcts/Evaluator';
import WebMctsEngine from '../../mcts/WebMctsEngine';
import { DEFAULT_SEARCH_PARAMS } from '../../mcts/search';
import WebRawNnEngine from '../../mcts/WebRawNnEngine';
import HexBoard, { BLACK, WHITE } from '../../mcts/HexBoard';
import { config } from './config';
import StaticShapeSession from './StaticShapeSession';
import { gunzip, readKatahexModel } from './network/readKatahexModel';
import WebGpuNetwork from './network/WebGpuNetwork';
import { detectGpu, type GpuDetection } from './gpu';
import type { FromWorker, ToWorker } from './messages';

/**
 * Worker global scope, typed with DOM lib only.
 */
const scope = self as unknown as Worker & { crossOriginIsolated: boolean };

/**
 * Chosen on page, in priority order.
 */
let jobTypes: AiJobType[] = [];

/**
 * No hardware GPU: tree search would take minutes on CPU.
 */
class NoGpuError extends Error {
    constructor(public detection: Exclude<GpuDetection, { ok: true }>) {
        super('No GPU');
    }
}

const MIN_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 60_000;

const post = (message: FromWorker): void => scope.postMessage(message);

type Session = OrtSession & { release(): Promise<void> };

type Engines = { session: Session, mcts: WebMctsEngine, rawNn: WebRawNnEngine, cache: CachedEvaluator };

/**
 * Model usage, for benchmark: whether jobs wait for GPU, or GPU waits for tree search.
 */
const modelStats = { runs: 0, positions: 0, busyMs: 0, running: 0, busySince: 0 };

class MeasuredSession implements Session
{
    constructor(private session: Session) {}

    async run(feeds: Parameters<Session['run']>[0]): ReturnType<Session['run']>
    {
        // Pipelined runs overlap: busy time counted once
        if (modelStats.running++ === 0) {
            modelStats.busySince = performance.now();
        }

        modelStats.runs++;
        modelStats.positions += feeds.spatial.dims[0];

        try {
            return await this.session.run(feeds);
        } finally {
            if (--modelStats.running === 0) {
                modelStats.busyMs += performance.now() - modelStats.busySince;
            }
        }
    }

    release(): Promise<void>
    {
        return this.session.release();
    }
}

let engines: null | Engines = null;

/**
 * Tree search visits since worker started, for benchmark.
 */
let visits = 0;
let searchPlayouts = 0;
let running = false;

/**
 * Aborts long polling, and current search.
 */
let stopController = new AbortController();
let jobController = new AbortController();

/**
 * Aborts current long polling only, to poll again with new job types.
 */
let pollController = new AbortController();

const workerId = crypto.randomUUID();

/**
 * Downloads model with progress, kept in Cache API for next visits.
 */
const MODELS_CACHE = 'hex-web-worker-models';

const isModelResponse = (response: Response): boolean =>
    response.ok && !(response.headers.get('Content-Type') ?? '').startsWith('text/');

const fetchModel = async (url: string): Promise<Uint8Array> => {
    const cache = await caches.open(MODELS_CACHE).catch(() => null);
    const cached = await cache?.match(url);

    if (cached && isModelResponse(cached)) {
        return new Uint8Array(await cached.arrayBuffer());
    }

    const response = await fetch(url);

    // Missing file may be answered with html page
    if (!isModelResponse(response) || response.body === null) {
        throw new Error(`Could not download model ${url}: ${response.status} ${response.headers.get('Content-Type') ?? ''}`);
    }

    const total = Number(response.headers.get('Content-Length') ?? 0);
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let loaded = 0;

    while (true) {
        const { done, value } = await reader.read();

        if (done) {
            break;
        }

        chunks.push(value);
        loaded += value.length;
        post({ type: 'modelProgress', loaded, total });
    }

    const model = new Uint8Array(loaded);
    let offset = 0;

    for (const chunk of chunks) {
        model.set(chunk, offset);
        offset += chunk.length;
    }

    await cache?.put(url, new Response(model, { headers: { 'Content-Type': 'application/octet-stream' } })).catch(() => undefined);

    return model;
};

const deleteCachedModel = (url: string): Promise<unknown> =>
    caches.open(MODELS_CACHE).then(cache => cache.delete(url)).catch(() => undefined);

/**
 * Own WebGPU shaders, float32, ~2× faster than onnxruntime.
 */
const createWebGpuNetwork = async (): Promise<WebGpuNetwork> => {
    const data = await fetchModel(config.katahexModelUrl);
    let model;

    try {
        model = readKatahexModel(await gunzip(data));
    } catch (e) {
        // Corrupted download: fetch again next time
        await deleteCachedModel(config.katahexModelUrl);
        throw e;
    }

    return await WebGpuNetwork.create(model);
};

/**
 * WebGpuNetwork, else onnxruntime: float16 model when supported (half size), else float32.
 *
 * @throws {NoGpuError}
 */
const createSession = async (): Promise<{ session: Session, gpuName: string } & Omit<Extract<FromWorker, { type: 'gpu' }>, 'type' | 'name' | 'loadMs'>> => {
    // Not bundled in docs/ to keep git repository light, see vite.config.ts
    ort.env.wasm.wasmPaths = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ort.env.versions.web}/dist/`;

    // No COOP/COEP headers on GitHub Pages, so no wasm threads
    ort.env.wasm.numThreads = 1;

    const gpu = await detectGpu();

    if (!gpu.ok) {
        throw new NoGpuError(gpu);
    }

    try {
        const network = await createWebGpuNetwork();

        return {
            session: network,
            gpuName: gpu.name,
            float16: false,
            engine: 'WebGpuNetwork',
            details: ['own shaders', 'Winograd F(2,3)', network.largeTiles ? 'large tiles' : 'small tiles only', `${DEFAULT_SEARCH_PARAMS.pipelinedBatches} batches in flight`],
        };
    } catch (e) {
        console.warn('WebGpuNetwork failed, using onnxruntime', e);
    }

    const float16 = gpu.adapter.features.has('shader-f16');
    const modelUrl = float16 ? config.modelUrl : config.modelUrlFloat32;
    const model = await fetchModel(modelUrl);
    const session = new StaticShapeSession(model);

    // Most played board size, also checks model
    await session.load(11)
        .catch(async (e: unknown) => {
            // Corrupted download: fetch again next time
            await deleteCachedModel(modelUrl);
            throw e;
        });

    return { session, gpuName: gpu.name, float16, engine: 'onnxruntime', details: ['fallback', 'static shapes', 'no batch in parallel'] };
};

const loadEngines = async (): Promise<Engines> => {
    if (engines !== null) {
        return engines;
    }

    post({ type: 'state', state: 'loading' });

    const startedAt = performance.now();
    const { session: created, gpuName, float16, engine, details } = await createSession();
    const session = new MeasuredSession(created);
    const cache = new CachedEvaluator(new OnnxEvaluator(session, ort.Tensor));

    post({ type: 'gpu', name: gpuName, float16, engine, details, loadMs: Math.round(performance.now() - startedAt) });

    engines = {
        session,
        cache,
        mcts: new WebMctsEngine(cache, {
            signal: () => jobController.signal,
            onProgress: (playouts, maxPlayouts) => {
                // Playouts restart from 0 on each search
                visits += playouts >= searchPlayouts ? playouts - searchPlayouts : playouts;
                searchPlayouts = playouts;
                post({ type: 'playouts', playouts, maxPlayouts });
            },
        }),

        // Symmetry 0, like docker workers katahex kata-raw-nn
        rawNn: new WebRawNnEngine(new OnnxEvaluator(session, ort.Tensor, NN_POLICY_TEMPERATURE, () => 0)),
    };

    return engines;
};

/**
 * After a GPU error, session is unusable: create a new one for next job.
 */
const processTask = async (task: AiTask): Promise<unknown> => {
    const taskEngines = await loadEngines();

    try {
        return await runTask(taskEngines, task);
    } catch (e) {
        if (/OrtRun|WebGpuNetwork/.test(String(e)) && taskEngines === engines) {
            console.warn('Model failed, reloading it', e);
            engines = null;
            void taskEngines.session.release().catch(() => undefined);
        }

        throw e;
    }
};

const runTask = async ({ mcts, rawNn }: Engines, task: AiTask): Promise<unknown> => {
    switch (task.type) {
        case 'katahex-mcts-move': return await processJobKatahexMcts(mcts, task.data);
        case 'katahex-mcts-analyze-position': return await analyzePositionMcts(mcts, task.data);
        case 'katahex-mcts-analyze-move': return await analyzeMoveMcts(mcts, task.data);
        case 'katahex-intuition-move': return await processJobKatahex(rawNn, task.data);
        case 'katahex-intuition-analyze-position': return await analyzePosition(rawNn, task.data);
        case 'katahex-intuition-analyze-game': return await analyzeGame(rawNn, task.data);
    }

    throw new Error(`Job type ${task.type} not supported by web worker`);
};

/**
 * Model run duration by batch size: shows whether runs are limited by overhead or by computation.
 */
const benchModel = async (): Promise<void> => {
    const { session } = await loadEngines();
    const evaluator = new OnnxEvaluator(session, ort.Tensor);
    const size = 11;
    const runs = 10;

    const request = (seed: number): EvaluationRequest => {
        const board = new HexBoard(size);

        for (let i = 0; i < 30; ++i) {
            const cell = (seed * 31 + i * 17) % (size * size);

            if (board.legalMoves().includes(cell)) {
                board.play(cell, i % 2 === 0 ? BLACK : WHITE);
            }
        }

        return { board, player: BLACK, moves: board.legalMoves() };
    };

    for (const batchSize of [1, 8, 16, 32, 64]) {
        const requests = Array.from({ length: batchSize }, (_, i) => request(i));

        // Warm-up: first run of each shape is slower
        await evaluator.evaluate(requests);

        const startedAt = performance.now();

        for (let i = 0; i < runs; ++i) {
            await evaluator.evaluate(requests);
        }

        post({ type: 'benchModel', batchSize, msPerRun: (performance.now() - startedAt) / runs });
    }
};

let benchCache = { hits: 0, misses: 0 };

/**
 * Bench task, with model usage counted from its start.
 */
const benchTask = async (task: AiTask): Promise<unknown> => {
    const { cache } = await loadEngines();

    Object.assign(modelStats, { runs: 0, positions: 0, busyMs: 0 });
    benchCache = { hits: cache.hits, misses: cache.misses };

    return processTask(task);
};

const postBenchStats = (jobType: AiJobType, durationMs: number): void => {
    const cache = engines?.cache;
    const hits = (cache?.hits ?? 0) - benchCache.hits;
    const lookups = hits + (cache?.misses ?? 0) - benchCache.misses;

    post({
        type: 'benchStats',
        jobType,
        modelBusyPercent: Math.round(100 * modelStats.busyMs / Math.max(1, durationMs)),
        runs: modelStats.runs,
        positionsPerRun: modelStats.runs > 0 ? modelStats.positions / modelStats.runs : 0,
        cacheHitPercent: lookups > 0 ? Math.round(100 * hits / lookups) : null,
    });
};

const sleep = (ms: number, signal: AbortSignal): Promise<void> => new Promise(resolve => {
    const timeout = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
        clearTimeout(timeout);
        resolve();
    }, { once: true });
});

const run = async (key: string): Promise<void> => {
    // Before polling: no job taken while model loads
    await loadEngines();
    const client = new AiWorkerClient(config.playhexUrl, key, workerId);
    let backoffMs = MIN_BACKOFF_MS;

    while (running) {
        try {
            post({ type: 'state', state: 'waiting' });

            pollController = new AbortController();

            const job = await client.next(jobTypes, { signal: AbortSignal.any([stopController.signal, pollController.signal]) });

            backoffMs = MIN_BACKOFF_MS;

            if (job === null) {
                continue;
            }

            const size = 'game' in job.task.data ? job.task.data.game.size : job.task.data.size;
            const maxPlayouts = 'maxPlayouts' in job.task.data ? job.task.data.maxPlayouts : 0;
            const startedAt = Date.now();

            jobController = new AbortController();
            post({ type: 'state', state: 'working' });
            post({ type: 'job', jobType: job.task.type, size, maxPlayouts });

            const outcome = await client.processJob(job, task => processTask(task), {
                // Search aborted by stop, or unexpected error: let another worker try
                isRetryable: () => true,
                onNotOwned: () => jobController.abort(),
                onHeartbeatError: error => console.warn('Could not send heartbeat', error),
            });

            if (outcome.status === 'done' && outcome.error) {
                console.error('Job failed', outcome.error);
            }

            post({
                type: 'jobDone',
                jobType: job.task.type,
                size,
                durationMs: Date.now() - startedAt,
                accepted: outcome.status === 'done' && !outcome.failed,
            });
        } catch (e) {
            if (e instanceof UnauthorizedError) {
                running = false;
                post({ type: 'unauthorized' });
                break;
            }

            if (!running) {
                break;
            }

            // Job types changed while polling
            if (pollController.signal.aborted) {
                continue;
            }

            console.warn(`Server error, retrying in ${backoffMs / 1000}s`, e);
            post({ type: 'state', state: 'offline' });
            await sleep(backoffMs, stopController.signal);
            backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
        }
    }

    await client.disconnect({ keepalive: true }).catch(() => undefined);
    post({ type: 'state', state: 'stopped' });
};

scope.onmessage = (event: MessageEvent<ToWorker>) => {
    const message = event.data;

    switch (message.type) {
        case 'start':
            if (running) {
                return;
            }

            running = true;
            jobTypes = message.jobTypes;
            stopController = new AbortController();

            run(message.key).catch(e => {
                running = false;
                post(e instanceof NoGpuError
                    ? { type: 'noGpu', detection: e.detection }
                    : { type: 'error', message: e instanceof Error ? e.message : String(e) });
                post({ type: 'state', state: 'stopped' });
            });
            break;

        case 'stop':
            // Current job is given back to server, another worker takes it
            running = false;
            stopController.abort();
            jobController.abort();
            break;

        case 'setJobTypes':
            jobTypes = message.jobTypes;
            pollController.abort();
            break;

        case 'bench':
            runBench(benchTask, result => {
                post({ type: 'benchResult', result });
                postBenchStats(result.type as AiJobType, result.durationMs);
            }, () => visits)
                .then(benchModel)
                .catch(e => post(e instanceof NoGpuError
                    ? { type: 'noGpu', detection: e.detection }
                    : { type: 'error', message: e instanceof Error ? e.message : String(e) }))
                .finally(() => post({ type: 'benchDone' }));
            break;

    }
};
