import { MAX_CELLS_PER_RUN, type OrtSession, type OrtTensor } from '../../../mcts/Evaluator';
import { type Activation, type BatchNorm, type Block, type Conv, type KatahexModel, type MatMul } from './readKatahexModel';
import {
    convShader, convTile, dotShader, LARGE_TILE_MIN_CELLS, matMulShader, poolShader,
    WINOGRAD_MAX_TILES, winogradFilter, winogradGemmShader, winogradInputShader, winogradOutputShader, winogradTile,
} from './shaders';

/*
 * Katahex network on WebGPU with own shaders, ~2.7× faster than onnxruntime-web, see web/PERFORMANCE.md.
 * Same inputs and outputs as model-conversion/bin_to_onnx.py onnx model, so it can replace an onnxruntime session.
 */

// Minimal WebGPU types, not in typescript dom lib
type GpuBuffer = { size: number, destroy(): void, mapAsync(mode: number): Promise<void>, getMappedRange(): ArrayBuffer, unmap(): void };
type GpuPipeline = { getBindGroupLayout(index: number): unknown };
type GpuPass = { setPipeline(p: GpuPipeline): void, setBindGroup(i: number, group: unknown): void, dispatchWorkgroups(x: number, y?: number, z?: number): void, end(): void };
type GpuDevice = {
    createBuffer(descriptor: { size: number, usage: number }): GpuBuffer,
    createShaderModule(descriptor: { code: string }): unknown,
    createComputePipeline(descriptor: object): GpuPipeline,
    createBindGroup(descriptor: object): unknown,
    createQuerySet(descriptor: { type: 'timestamp', count: number }): unknown,
    createCommandEncoder(): {
        beginComputePass(descriptor?: object): GpuPass,
        copyBufferToBuffer(src: GpuBuffer, srcOffset: number, dst: GpuBuffer, dstOffset: number, size: number): void,
        resolveQuerySet(querySet: unknown, first: number, count: number, destination: GpuBuffer, offset: number): void,
        finish(): unknown,
    },
    queue: { writeBuffer(buffer: GpuBuffer, offset: number, data: Float32Array | Uint32Array): void, submit(commands: unknown[]): void },
    addEventListener(type: 'uncapturederror', listener: (event: { error: { message: string } }) => void): void,
    lost: Promise<{ message: string }>,
    destroy(): void,
};

// GPUBufferUsage
const STORAGE = 0x80, COPY_DST = 0x08, COPY_SRC = 0x04, UNIFORM = 0x40, MAP_READ = 0x01, QUERY_RESOLVE = 0x200;

/**
 * Spatial input channels padded, conv reads them by 16.
 */
const SPATIAL_CHANNELS = 32;

type Dispatch = {
    label: string,
    pipeline: GpuPipeline,
    bindGroup: unknown,
    workgroups: (run: RunSize) => [number, number?, number?],
};

type RunSize = { m: number, n: number, tiles: number };

/**
 * Dispatches of an op, chosen for each run: large tiles for many positions, Winograd when its buffers are big enough.
 */
type Op = (run: { large: boolean, winograd: boolean }) => Dispatch[];

/**
 * Activated output of an op: act(x * bn.scale + bn.bias), batch norm and activation of next layer.
 */
type Next = { bn: BatchNorm | null, act: Activation };

export default class WebGpuNetwork implements OrtSession
{
    private ops: Op[] = [];
    private buffers: GpuBuffer[] = [];
    private pipelines = new Map<string, GpuPipeline>();
    private constants = new Map<string, GpuBuffer>();

    /**
     * Buffers reused by role, by channels count.
     */
    private tensors = new Map<string, GpuBuffer>();

    private params: GpuBuffer;
    private spatial: GpuBuffer;
    private global: GpuBuffer;
    private policy!: GpuBuffer;
    private pass!: GpuBuffer;
    private value!: GpuBuffer;

    /**
     * One per run in flight, free ones.
     */
    private readbacks: GpuBuffer[] = [];

    private error: null | string = null;

    /**
     * Max channels of 3×3 convs, for Winograd buffers.
     */
    private winogradChannels: number;

    /**
     * GPU duration by op label, in profiling mode, see create().
     */
    readonly profile = new Map<string, { ms: number, count: number }>();

    /**
     * Several runs can be in flight: GPU runs them in submission order, so they can share activation buffers.
     */
    private running = new Set<Promise<unknown>>();

    /**
     * @param largeTiles Whether device has enough workgroup memory for large tile
     */
    private constructor(private device: GpuDevice, private model: KatahexModel, readonly largeTiles: boolean, private profiling: boolean)
    {
        device.addEventListener('uncapturederror', event => this.error ??= event.error.message);
        void device.lost.then(info => this.error ??= `device lost: ${info.message}`);

        this.params = this.buffer(32, UNIFORM | COPY_DST);
        this.spatial = this.buffer(MAX_CELLS_PER_RUN * SPATIAL_CHANNELS * 4);
        this.global = this.buffer(MAX_CELLS_PER_RUN * model.numGlobal * 4);

        const convs = (blocks: Block[]): Conv[] => blocks.flatMap(block => block.kind === 'nested_bottleneck_block'
            ? convs(block.blocks)
            : [block.regularConv, block.finalConv, ...(block.kind === 'gpool_block' ? [block.gpoolConv] : [])]);
        this.winogradChannels = Math.max(...convs(model.trunk.blocks).filter(conv => conv.ky === 3).flatMap(conv => [conv.ic, conv.oc]), 4);

        this.build();
    }

    /**
     * @param profiling Each op in its own pass with GPU timestamps, slower: for experiments only
     */
    static async create(model: KatahexModel, { profiling = false } = {}): Promise<WebGpuNetwork>
    {
        type Adapter = { features: Set<string>, limits: { maxComputeWorkgroupStorageSize: number }, requestDevice(descriptor?: object): Promise<GpuDevice> };
        const gpu = (navigator as unknown as { gpu?: { requestAdapter(options?: object): Promise<null | Adapter> } }).gpu;
        const adapter = await gpu?.requestAdapter({ powerPreference: 'high-performance' });

        if (!adapter) {
            throw new Error('No WebGPU adapter');
        }

        // Large tile needs ~17KB of workgroup memory, default limit is 16KB
        const workgroupStorage = Math.min(32768, adapter.limits.maxComputeWorkgroupStorageSize);
        profiling &&= adapter.features.has('timestamp-query');
        const device = await adapter.requestDevice({
            requiredLimits: { maxComputeWorkgroupStorageSize: workgroupStorage },
            requiredFeatures: profiling ? ['timestamp-query'] : [],
        });
        const network = new WebGpuNetwork(device, model, workgroupStorage >= 32768, profiling);

        // Compilation errors are only reported asynchronously
        await network.run(network.dummyInputs(5, 1));
        await network.run(network.dummyInputs(Math.ceil(Math.sqrt(LARGE_TILE_MIN_CELLS)), 1));

        return network;
    }

    private dummyInputs(size: number, n: number): { spatial: OrtTensor, global: OrtTensor }
    {
        return {
            spatial: { data: new Float32Array(n * this.model.numSpatial * size * size), dims: [n, this.model.numSpatial, size, size] },
            global: { data: new Float32Array(n * this.model.numGlobal), dims: [n, this.model.numGlobal] },
        };
    }

    private buffer(size: number, usage = STORAGE | COPY_DST | COPY_SRC): GpuBuffer
    {
        const buffer = this.device.createBuffer({ size: Math.ceil(size / 16) * 16, usage });
        this.buffers.push(buffer);

        return buffer;
    }

    private upload(data: Float32Array): GpuBuffer
    {
        const buffer = this.buffer(data.byteLength, STORAGE | COPY_DST);
        this.device.queue.writeBuffer(buffer, 0, data);

        return buffer;
    }

    private constant(value: number, length: number): GpuBuffer
    {
        const key = `${value} ${length}`;
        let buffer = this.constants.get(key);

        if (!buffer) {
            buffer = this.upload(new Float32Array(length).fill(value));
            this.constants.set(key, buffer);
        }

        return buffer;
    }

    /**
     * Activations of all positions of a run, reused by role.
     */
    private tensor(role: string, channels: number): GpuBuffer
    {
        const key = `${role} ${channels}`;
        let buffer = this.tensors.get(key);

        if (!buffer) {
            buffer = this.buffer(MAX_CELLS_PER_RUN * channels * 4);
            this.tensors.set(key, buffer);
        }

        return buffer;
    }

    /**
     * Winograd transformed inputs or products, for all 3×3 convs.
     */
    private winogradBuffer(role: 'v' | 'products'): GpuBuffer
    {
        return this.tensors.get(`winograd ${role}`) ?? this.tensors.set(`winograd ${role}`, this.buffer(16 * WINOGRAD_MAX_TILES * this.winogradChannels * 4)).get(`winograd ${role}`)!;
    }

    private pipeline(code: string): GpuPipeline
    {
        let pipeline = this.pipelines.get(code);

        if (!pipeline) {
            pipeline = this.device.createComputePipeline({
                layout: 'auto',
                compute: { module: this.device.createShaderModule({ code }), entryPoint: 'main' },
            });
            this.pipelines.set(code, pipeline);
        }

        return pipeline;
    }

    private dispatch(label: string, code: string, bindings: Record<number, GpuBuffer>, workgroups: Dispatch['workgroups']): Dispatch
    {
        const pipeline = this.pipeline(code);

        return {
            label,
            pipeline,
            workgroups,
            bindGroup: this.device.createBindGroup({
                layout: pipeline.getBindGroupLayout(0),
                entries: Object.entries(bindings).map(([binding, buffer]) => ({ binding: Number(binding), resource: { buffer } })),
            }),
        };
    }

    private op(label: string, code: string, bindings: Record<number, GpuBuffer>, workgroups: Dispatch['workgroups']): void
    {
        const dispatch = this.dispatch(label, code, bindings, workgroups);
        this.ops.push(() => [dispatch]);
    }

    /**
     * Conv with batch norm merged into weights, writes act(next.bn(conv + bias [+ batch bias] [+ raw])) to out.
     */
    private conv(
        src: GpuBuffer,
        conv: Conv,
        bn: BatchNorm | null,
        out: GpuBuffer,
        next: Next,
        { raw, batchBias, icPadded }: { raw?: ['write' | 'add', GpuBuffer], batchBias?: GpuBuffer, icPadded?: number } = {},
    ): void {
        const { ky, kx, ic, oc, dilation } = conv;

        if (ky !== kx || (ky !== 1 && ky !== 3) || dilation[0] !== 1 || dilation[1] !== 1) {
            throw new Error(`Conv ${conv.name} ${ky}×${kx} dilation ${dilation} not supported`);
        }

        const icp = icPadded ?? ic;
        const w = new Float32Array(ky * kx * icp * oc);

        for (let tap = 0; tap < ky * kx; ++tap) {
            for (let i = 0; i < ic; ++i) {
                for (let o = 0; o < oc; ++o) {
                    w[(tap * icp + i) * oc + o] = conv.w[(tap * ic + i) * oc + o] * (bn?.scale[o] ?? 1);
                }
            }
        }

        const bindings: Record<number, GpuBuffer> = {
            1: src,
            2: this.upload(w),
            3: bn ? this.upload(bn.bias) : this.constant(0, oc),
            4: next.bn ? this.upload(next.bn.scale) : this.constant(1, oc),
            5: next.bn ? this.upload(next.bn.bias) : this.constant(0, oc),
            6: out,
        };

        if (raw) {
            bindings[7] = raw[1];
        }

        if (batchBias) {
            bindings[8] = batchBias;
        }

        const options = { raw: raw?.[0] ?? 'none', batchBias: batchBias !== undefined, act: next.act } as const;
        const direct = (large: boolean): Dispatch => {
            const { bm, bn: tileChannels } = convTile(icp, oc, large);
            const code = convShader({ kernel: ky, ic: icp, oc, ...options, large });

            return this.dispatch(`conv ${ky}×${kx} ${icp} → ${oc}`, code, { 0: this.params, ...bindings }, ({ m }) => [oc / tileChannels, Math.ceil(m / bm)]);
        };
        const directs = [direct(false), this.largeTiles ? direct(true) : direct(false)];

        // Not for spatial input conv: few channels, cheap
        if (ky !== 3 || icPadded !== undefined) {
            this.ops.push(({ large }) => [directs[Number(large)]]);
            return;
        }

        const { 2: _weights, ...outputBindings } = bindings;
        const v = this.winogradBuffer('v');
        const products = this.winogradBuffer('products');
        const u = this.upload(winogradFilter(w, icp, oc));
        const input = this.dispatch('winograd transforms', winogradInputShader(icp), { 0: this.params, 1: src, 2: v }, ({ tiles }) => [Math.ceil(tiles * icp / 4 / 64)]);
        const output = this.dispatch('winograd transforms', winogradOutputShader({ oc, ...options }), { ...outputBindings, 0: this.params, 1: products }, ({ tiles }) => [Math.ceil(tiles * oc / 4 / 64)]);
        const gemm = (large: boolean): Dispatch => {
            const { bm, bn: tileChannels } = winogradTile(icp, oc, large);

            return this.dispatch(`winograd ${icp} → ${oc}`, winogradGemmShader(icp, oc, large), { 0: this.params, 1: v, 2: u, 3: products }, ({ tiles }) => [oc / tileChannels, Math.ceil(tiles / bm), 16]);
        };
        const gemms = [gemm(false), this.largeTiles ? gemm(true) : gemm(false)];

        this.ops.push(({ large, winograd }) => winograd ? [input, gemms[Number(large)], output] : [directs[Number(large)]]);
    }

    private pool(src: GpuBuffer, channels: number, kind: 'gpool' | 'value'): GpuBuffer
    {
        const out = this.tensor(`pool ${kind}`, channels * 3);
        this.op('pooling', poolShader(channels, kind), { 0: this.params, 1: src, 2: out }, ({ n }) => [Math.ceil(n * channels / 64)]);

        return out;
    }

    /**
     * @param columnScale Multiplies output channels, i.e merged batch norm
     */
    private matMul(src: GpuBuffer, matMul: MatMul, act: Activation, bias: Float32Array | null, out: GpuBuffer, columnScale?: Float32Array): void
    {
        const { ic, oc } = matMul;
        const w = columnScale ? matMul.w.map((v, i) => v * columnScale[i % oc]) : matMul.w;

        this.op(
            'matmul',
            matMulShader(ic, oc, act),
            { 0: this.params, 1: src, 2: this.upload(w), 3: bias ? this.upload(bias) : this.constant(0, oc), 4: out },
            ({ n }) => [Math.ceil(n * oc / 64)],
        );
    }

    /**
     * When called, act holds activated raw, for first block. Then act holds next(raw).
     */
    private blocks(blocks: Block[], raw: GpuBuffer, act: GpuBuffer, last: Next, depth: number): void
    {
        blocks.forEach((block, i) => {
            const following = blocks[i + 1];
            const next: Next = following ? { bn: following.preBN, act: following.preAct } : last;

            switch (block.kind) {
                case 'ordinary_block': {
                    const h = this.tensor('h', block.regularConv.oc);
                    this.conv(act, block.regularConv, block.midBN, h, { bn: null, act: block.midAct });
                    this.conv(h, block.finalConv, null, act, next, { raw: ['add', raw] });
                    break;
                }

                case 'gpool_block': {
                    const g = this.tensor('g', block.gpoolConv.oc);
                    const h = this.tensor('h', block.regularConv.oc);
                    const bias = this.tensor('gpool bias', block.regularConv.oc);

                    this.conv(act, block.gpoolConv, block.gpoolBN, g, { bn: null, act: block.gpoolAct });

                    // midBN merged into regularConv, and into pooled bias
                    this.matMul(this.pool(g, block.gpoolConv.oc, 'gpool'), block.gpoolToBiasMul, 'ACTIVATION_IDENTITY', null, bias, block.midBN.scale);
                    this.conv(act, block.regularConv, block.midBN, h, { bn: null, act: block.midAct }, { batchBias: bias });
                    this.conv(h, block.finalConv, null, act, next, { raw: ['add', raw] });
                    break;
                }

                case 'nested_bottleneck_block': {
                    const channels = block.preConv.oc;
                    const innerRaw = this.tensor(`raw ${depth + 1}`, channels);
                    const innerAct = this.tensor(`act ${depth + 1}`, channels);
                    const first = block.blocks[0];

                    this.conv(act, block.preConv, null, innerAct, first ? { bn: first.preBN, act: first.preAct } : { bn: block.postBN, act: block.postAct }, { raw: ['write', innerRaw] });
                    this.blocks(block.blocks, innerRaw, innerAct, { bn: block.postBN, act: block.postAct }, depth + 1);
                    this.conv(innerAct, block.postConv, null, act, next, { raw: ['add', raw] });
                    break;
                }
            }
        });
    }

    private build(): void
    {
        const { trunk, policy, value, numSpatial } = this.model;
        const channels = trunk.initialConv.oc;

        if (numSpatial > SPATIAL_CHANNELS) {
            throw new Error(`${numSpatial} spatial inputs not supported`);
        }

        // Trunk
        const raw = this.tensor('raw 0', channels);
        const act = this.tensor('act 0', channels);
        const globalBias = this.tensor('global bias', channels);
        const first = trunk.blocks[0];
        const tip: Next = { bn: trunk.tipBN, act: trunk.tipAct };

        this.matMul(this.global, trunk.initialMatMul, 'ACTIVATION_IDENTITY', null, globalBias);
        this.conv(this.spatial, trunk.initialConv, null, act, first ? { bn: first.preBN, act: first.preAct } : tip, {
            raw: ['write', raw], batchBias: globalBias, icPadded: SPATIAL_CHANNELS,
        });
        this.blocks(trunk.blocks, raw, act, tip, 0);

        // Policy head
        const g1 = this.tensor('g1', policy.g1Conv.oc);
        const p1 = this.tensor('p1', policy.p1Conv.oc);
        const policyBias = this.tensor('policy bias', policy.p1Conv.oc);
        this.policy = this.tensor('policy', 1);
        this.pass = this.tensor('pass', 1);

        this.conv(act, policy.g1Conv, policy.g1BN, g1, { bn: null, act: policy.g1Act });
        const pooled = this.pool(g1, policy.g1Conv.oc, 'gpool');
        this.matMul(pooled, policy.gpoolToBiasMul, 'ACTIVATION_IDENTITY', null, policyBias, policy.p1BN.scale);
        this.matMul(pooled, policy.gpoolToPassMul, 'ACTIVATION_IDENTITY', null, this.pass);
        this.conv(act, policy.p1Conv, policy.p1BN, p1, { bn: null, act: policy.p1Act }, { batchBias: policyBias });
        this.op('policy output', dotShader(policy.p2Conv.ic), { 0: this.params, 1: p1, 2: this.upload(policy.p2Conv.w), 3: this.policy }, ({ m }) => [Math.ceil(m / 64)]);

        // Value head
        const v1 = this.tensor('v1', value.v1Conv.oc);
        const v2 = this.tensor('v2', value.v2Mul.oc);
        this.value = this.tensor('value', value.v3Mul.oc);

        this.conv(act, value.v1Conv, value.v1BN, v1, { bn: null, act: value.v1Act });
        this.matMul(this.pool(v1, value.v1Conv.oc, 'value'), value.v2Mul, value.v2Act, value.v2Bias, v2);
        this.matMul(v2, value.v3Mul, 'ACTIVATION_IDENTITY', value.v3Bias, this.value);
    }

    /**
     * @param feeds spatial [n, c, h, w] and global [n, g], like onnx model
     * @returns policy [n, h * w + 1] and value [n, 3] logits
     */
    run(feeds: { [name: string]: OrtTensor }): Promise<{ policy: OrtTensor, value: OrtTensor }>
    {
        const result = this.runNow(feeds.spatial, feeds.global);

        this.running.add(result);
        void result.catch(() => undefined).finally(() => this.running.delete(result));

        return result;
    }

    private async runNow(spatial: OrtTensor, global: OrtTensor): Promise<{ policy: OrtTensor, value: OrtTensor }>
    {
        if (this.error !== null) {
            throw new Error(`WebGpuNetwork: ${this.error}`);
        }

        const [n, c, h, w] = spatial.dims;
        const area = h * w;
        const m = n * area;
        const outputs = this.model.value.v3Mul.oc;

        if (m > MAX_CELLS_PER_RUN) {
            throw new Error(`WebGpuNetwork: ${m} cells, max ${MAX_CELLS_PER_RUN}`);
        }

        // NCHW to NHWC, channels padded
        const spatialData = spatial.data as Float32Array;
        const nhwc = new Float32Array(m * SPATIAL_CHANNELS);

        for (let i = 0; i < n; ++i) {
            for (let ch = 0; ch < c; ++ch) {
                const from = (i * c + ch) * area;

                for (let cell = 0; cell < area; ++cell) {
                    nhwc[(i * area + cell) * SPATIAL_CHANNELS + ch] = spatialData[from + cell];
                }
            }
        }

        const startedAt = performance.now();
        const th = Math.ceil(h / 2), tw = Math.ceil(w / 2);
        const tiles = n * th * tw;
        const params = new Uint32Array(8);
        params.set([m, h, w, n, 0, tiles, th, tw]);
        new Float32Array(params.buffer)[4] = (Math.sqrt(area) - 14) / 10;

        this.device.queue.writeBuffer(this.params, 0, params);
        this.device.queue.writeBuffer(this.spatial, 0, nhwc);
        this.device.queue.writeBuffer(this.global, 0, global.data as Float32Array);

        const encoder = this.device.createCommandEncoder();
        const choice = { large: m >= LARGE_TILE_MIN_CELLS, winograd: tiles <= WINOGRAD_MAX_TILES };
        const dispatches = this.ops.flatMap(op => op(choice));
        const timestamps = this.profiling ? this.device.createQuerySet({ type: 'timestamp', count: 2 * dispatches.length }) : null;
        let pass = encoder.beginComputePass();

        dispatches.forEach((dispatch, i) => {
            if (timestamps) {
                pass.end();
                pass = encoder.beginComputePass({ timestampWrites: { querySet: timestamps, beginningOfPassWriteIndex: 2 * i, endOfPassWriteIndex: 2 * i + 1 } });
            }

            pass.setPipeline(dispatch.pipeline);
            pass.setBindGroup(0, dispatch.bindGroup);
            const [x, y, z] = dispatch.workgroups({ m, n, tiles });
            pass.dispatchWorkgroups(x, y, z);
        });

        pass.end();

        let timestampsBuffer: null | GpuBuffer = null;

        if (timestamps) {
            const resolved = this.device.createBuffer({ size: 16 * dispatches.length, usage: QUERY_RESOLVE | COPY_SRC });
            timestampsBuffer = this.device.createBuffer({ size: 16 * dispatches.length, usage: MAP_READ | COPY_DST });
            encoder.resolveQuerySet(timestamps, 0, 2 * dispatches.length, resolved, 0);
            encoder.copyBufferToBuffer(resolved, 0, timestampsBuffer, 0, 16 * dispatches.length);
        }
        const readback = this.readbacks.pop() ?? this.buffer(MAX_CELLS_PER_RUN * 5 * 4, MAP_READ | COPY_DST);
        encoder.copyBufferToBuffer(this.policy, 0, readback, 0, m * 4);
        encoder.copyBufferToBuffer(this.pass, 0, readback, m * 4, n * 4);
        encoder.copyBufferToBuffer(this.value, 0, readback, (m + n) * 4, n * outputs * 4);
        this.device.queue.submit([encoder.finish()]);

        await readback.mapAsync(MAP_READ);
        const results = new Float32Array(readback.getMappedRange().slice(0, (m + n + n * outputs) * 4));
        readback.unmap();
        this.readbacks.push(readback);

        if (timestampsBuffer) {
            await timestampsBuffer.mapAsync(MAP_READ);
            const ns = new BigInt64Array(timestampsBuffer.getMappedRange());
            let gpuMs = 0;

            dispatches.forEach(({ label }, i) => {
                const ms = Number(ns[2 * i + 1] - ns[2 * i]) / 1e6;
                const entry = this.profile.get(label) ?? { ms: 0, count: 0 };
                this.profile.set(label, { ms: entry.ms + ms, count: entry.count + 1 });
                gpuMs += ms;
            });

            timestampsBuffer.destroy();
            const total = this.profile.get('total, wall clock') ?? { ms: 0, count: 0 };
            this.profile.set('total, wall clock', { ms: total.ms + performance.now() - startedAt, count: total.count + 1 });
            const gpu = this.profile.get('total, gpu') ?? { ms: 0, count: 0 };
            this.profile.set('total, gpu', { ms: gpu.ms + gpuMs, count: gpu.count + 1 });
        }

        if (this.error !== null) {
            throw new Error(`WebGpuNetwork: ${this.error}`);
        }

        const policy = new Float32Array(n * (area + 1));

        for (let i = 0; i < n; ++i) {
            policy.set(results.subarray(i * area, (i + 1) * area), i * (area + 1));
            policy[i * (area + 1) + area] = results[m + i];
        }

        return {
            policy: { data: policy, dims: [n, area + 1] },
            value: { data: results.slice(m + n), dims: [n, outputs] },
        };
    }

    async release(): Promise<void>
    {
        await Promise.allSettled(this.running);

        for (const buffer of this.buffers) {
            buffer.destroy();
        }

        this.device.destroy();
    }
}
