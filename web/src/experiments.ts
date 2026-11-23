import * as ort from 'onnxruntime-web/webgpu';
import { config } from './config';
import { detectGpu } from './gpu';
import { gunzip, readKatahexModel } from './network/readKatahexModel';
import WebGpuNetwork from './network/WebGpuNetwork';

/*
 * Dev only: own WebGPU shaders vs onnxruntime on hex27x3, ?only=profile gives GPU time by op.
 * Previous results and tried options in web/PERFORMANCE.md.
 */

type Experiment = {
    label: string;
    model: { float16: string, float32: string };
    staticShape?: boolean;

    /**
     * Replays recorded GPU commands, requires static shape and inputs/outputs on GPU.
     */
    graphCapture?: boolean;

    /**
     * Own shaders instead of onnxruntime, katahex model file. Outputs compared to onnxruntime.
     */
    webGpuNetwork?: boolean;

    /**
     * GPU duration of each op, logged. Slower: one pass per op.
     */
    profile?: boolean;
};

// Literal paths, so that vite serves them
const MODEL = {
    float16: new URL('../../model-conversion/out/hex27x3.fp16.onnx', import.meta.url).href,
    float32: new URL('../../model-conversion/out/hex27x3.onnx', import.meta.url).href,
};

const KATAHEX_MODEL_URL = `${config.playhexUrl}/katahex-models/hex27x3.bin.gz`;

const EXPERIMENTS: Experiment[] = [
    { label: 'WebGPU network', model: MODEL, webGpuNetwork: true },
    { label: 'WebGPU network, profile', model: MODEL, webGpuNetwork: true, profile: true },
    { label: 'onnxruntime, static shape', model: MODEL, staticShape: true },
    { label: 'onnxruntime, static shape, graph capture', model: MODEL, staticShape: true, graphCapture: true },
];

// i.e ?only=capture&sizes=11&batches=8&runs=3
const params = new URLSearchParams(location.search);
const numbers = (name: string, defaults: number[]): number[] => params.get(name)?.split(',').map(Number) ?? defaults;
const SIZES = numbers('sizes', [11, 14]);
const BATCH_SIZES = numbers('batches', [8, 16]);
const RUNS = numbers('runs', [10])[0];
const only = params.get('only');

const $ = (id: string) => document.getElementById(id)!;
const log = (text: string) => $('log').textContent += text + '\n';

ort.env.wasm.wasmPaths = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ort.env.versions.web}/dist/`;
ort.env.wasm.numThreads = 1;

/**
 * On board everywhere, random stones: values do not matter for timing.
 */
const inputs = (n: number, size: number): Record<string, Float32Array> => {
    const area = size * size;
    const spatial = new Float32Array(n * 22 * area);

    for (let i = 0; i < n; ++i) {
        for (let cell = 0; cell < area; ++cell) {
            spatial[(i * 22) * area + cell] = 1;
            const stone = Math.random();
            if (stone < 0.15) spatial[(i * 22 + 1) * area + cell] = 1;
            else if (stone < 0.3) spatial[(i * 22 + 2) * area + cell] = 1;
        }
    }

    return {
        spatial,
        global: new Float32Array(n * 19),
    };
};

const dims = (name: string, n: number, size: number): number[] => name === 'spatial' ? [n, 22, size, size] : [n, 19];

type GpuDevice = {
    createBuffer(descriptor: { size: number, usage: number }): unknown;
    queue: { writeBuffer(buffer: unknown, offset: number, data: Float32Array): void };
};

// GPUBufferUsage.STORAGE | COPY_DST | COPY_SRC
const BUFFER_USAGE = 0x80 | 0x08 | 0x04;

/**
 * Graph capture: same GPU input buffers on every run, written before each run.
 */
const createRun = async (session: ort.InferenceSession, experiment: Experiment, n: number, size: number): Promise<() => Promise<void>> => {
    const data = inputs(n, size);

    if (!experiment.graphCapture) {
        return async () => {
            const feeds = Object.fromEntries(Object.entries(data).map(([name, values]) => [name, new ort.Tensor('float32', values, dims(name, n, size))]));
            await session.run(feeds);
        };
    }

    const device = await (ort.env.webgpu as unknown as { device: Promise<GpuDevice> }).device;
    const buffers = Object.fromEntries(Object.entries(data).map(([name, values]) => [
        name,
        device.createBuffer({ size: Math.ceil(values.byteLength / 16) * 16, usage: BUFFER_USAGE }),
    ]));
    const feeds = Object.fromEntries(Object.entries(buffers).map(([name, buffer]) => [
        name,
        ort.Tensor.fromGpuBuffer(buffer as Parameters<typeof ort.Tensor.fromGpuBuffer>[0], { dataType: 'float32', dims: dims(name, n, size) }),
    ]));

    return async () => {
        for (const [name, values] of Object.entries(data)) {
            device.queue.writeBuffer(buffers[name], 0, values);
        }

        const results = await session.run(feeds);

        // Like worker: outputs needed on CPU
        await Promise.all(Object.values(results).map(tensor => tensor.getData()));
    };
};

const addRow = (values: string[]): void => {
    const tr = document.createElement('tr');

    for (const value of values) {
        const td = document.createElement('td');
        td.textContent = value;
        tr.append(td);
    }

    $('results').append(tr);
};

const maxDiff = (a: Float32Array, b: Float32Array): number => a.reduce((max, v, i) => Math.max(max, Math.abs(v - b[i])), 0);

/**
 * Outputs compared to onnxruntime with float32 merged model.
 */
const runWebGpuNetwork = async (experiment: Experiment): Promise<void> => {
    const [katahexModel, onnxModel] = await Promise.all([KATAHEX_MODEL_URL, experiment.model.float32].map(async url => new Uint8Array(await (await fetch(url)).arrayBuffer())));
    const network = await WebGpuNetwork.create(readKatahexModel(await gunzip(katahexModel)), { profiling: experiment.profile });
    const reference = await ort.InferenceSession.create(onnxModel, { executionProviders: ['webgpu'] });

    for (const size of SIZES) {
        for (const batchSize of BATCH_SIZES) {
            const data = inputs(batchSize, size);
            const feeds = Object.fromEntries(Object.entries(data).map(([name, values]) => [name, new ort.Tensor('float32', values, dims(name, batchSize, size))]));
            const expected = await reference.run(feeds);
            const actual = await network.run(feeds);
            const diff = ['policy', 'value'].map(name => maxDiff(actual[name as 'policy'].data as Float32Array, expected[name].data as Float32Array).toExponential(1)).join(' / ');

            const run = () => network.run(feeds);
            await run();
            network.profile.clear();

            const startedAt = performance.now();

            for (let i = 0; i < RUNS; ++i) {
                await run();
            }

            const ms = (performance.now() - startedAt) / RUNS;

            addRow([experiment.label, `${size}×${size}`, String(batchSize), `${ms.toFixed(1)}ms`, String(Math.round(batchSize * 1000 / ms)), diff]);
            log(`${experiment.label}\t${size}×${size}\tbatch ${batchSize}\t${ms.toFixed(1)}ms\tpolicy / value diff ${diff}`);

            if (experiment.profile) {
                if (network.profile.size === 0) {
                    log('\tno timestamp-query feature');
                }

                // Per run: each label summed over a run
                for (const [label, { ms: total, count }] of [...network.profile].sort((a, b) => b[1].ms - a[1].ms)) {
                    log(`\t${(total / RUNS).toFixed(2)}ms\t${label}, ${count / RUNS} per run`);
                }
            }
        }
    }

    await reference.release();
    await network.release();
};

const runExperiment = async (experiment: Experiment, float16: boolean): Promise<void> => {
    if (experiment.webGpuNetwork) {
        return runWebGpuNetwork(experiment);
    }

    const model = new Uint8Array(await (await fetch(float16 ? experiment.model.float16 : experiment.model.float32)).arrayBuffer());

    // Static shape: one session per board size and batch size
    const sessions: [number, number[]][] = SIZES.flatMap(size => experiment.staticShape ? BATCH_SIZES.map((b): [number, number[]] => [size, [b]]) : [[size, BATCH_SIZES]]);

    for (const [size, sessionBatches] of sessions) {
        const session = await ort.InferenceSession.create(model, {
            executionProviders: ['webgpu'],
            graphOptimizationLevel: 'all',
            freeDimensionOverrides: experiment.staticShape ? { N: sessionBatches[0], H: size, W: size } : undefined,
            enableGraphCapture: experiment.graphCapture,
            preferredOutputLocation: experiment.graphCapture ? 'gpu-buffer' : undefined,
        });

        for (const batchSize of sessionBatches) {
            const run = await createRun(session, experiment, batchSize, size);

            // First runs of a shape are slower
            await run();
            await run();

            const startedAt = performance.now();

            for (let i = 0; i < RUNS; ++i) {
                await run();
            }

            const ms = (performance.now() - startedAt) / RUNS;

            addRow([experiment.label, `${size}×${size}`, String(batchSize), `${ms.toFixed(1)}ms`, String(Math.round(batchSize * 1000 / ms))]);
            log(`${experiment.label}\t${size}×${size}\tbatch ${batchSize}\t${ms.toFixed(1)}ms`);
        }

        await session.release();
    }
};

$('run').addEventListener('click', async () => {
    const button = $('run') as HTMLButtonElement;

    button.disabled = true;
    $('results').innerHTML = '';
    $('log').textContent = '';

    // Same model choice as worker
    const gpu = await detectGpu();
    const float16 = gpu.ok && gpu.adapter.features.has('shader-f16');
    log(`GPU: ${gpu.name ?? gpu.ok}, ${float16 ? 'float16' : 'float32 (no shader-f16)'}`);

    const experiments = EXPERIMENTS.filter(experiment => only === null || experiment.label.includes(only));

    for (const [i, experiment] of experiments.entries()) {
        $('status').textContent = `${i + 1} / ${experiments.length}: ${experiment.label}`;

        try {
            await runExperiment(experiment, float16);
        } catch (e) {
            addRow([experiment.label, '', '', 'failed', '']);
            log(`${experiment.label}\tfailed: ${String(e)}`);
        }
    }

    $('status').textContent = 'Done, copy table or log below';
    button.disabled = false;
});
