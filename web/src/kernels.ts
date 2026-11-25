/* eslint-disable @typescript-eslint/no-explicit-any */
import * as ort from 'onnxruntime-web/webgpu';
import { loadATileRows } from './network/shaders';

/*
 * Dev only: custom WebGPU kernels vs onnxruntime, on a chain of residual blocks (model-conversion/chain.py).
 * Conv 3×3 as tiled matrix product, NHWC, with bias, residual, batch norm and Mish fused in its output.
 */

const CHANNELS = 192;
const BLOCKS = 10;
const MODEL_URL = new URL('../../model-conversion/out/variants/chain.onnx', import.meta.url).href;
const WEIGHTS_URL = new URL('../../model-conversion/out/variants/chain.bin', import.meta.url).href;

/**
 * Output tile of a workgroup: bm positions × bn channels, tm × tn per thread, bk inputs per step.
 */
type Tile = { bm: number, bn: number, tm: number, tn: number, bk: number, vec4?: boolean };

// Best ones on Ampere: others (scalar, 8×8 per thread, 32 or 128 positions) slower
const TILES: Tile[] = [
    { bm: 64, bn: 64, tm: 4, tn: 4, bk: 16, vec4: true },
    { bm: 64, bn: 64, tm: 8, tn: 4, bk: 32, vec4: true },
];

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

const MISH = /* wgsl */ `
fn mish(x: f32) -> f32 {
    // tanh(softplus(x)) = n / (n + 2), n = e^x (e^x + 2)
    let e = exp(min(x, 20.0));
    let n = e * (e + 2.0);
    return x * n / (n + 2.0);
}`;

const range = (n: number): number[] => [...Array(n).keys()];

/**
 * act = mish((conv(src) + bias [+ raw]) * scale + shift), raw also updated when residual.
 */
const convShader = ({ bm, bn, tm, tn, bk }: Tile, residual: boolean): string => {
    const wgx = bn / tn, wgy = bm / tm;
    const accs = range(tm).flatMap(i => range(tn).map(j => `acc${i}_${j}`));

    return /* wgsl */ `
struct Params { m: u32, h: u32, w: u32, ic: u32, oc: u32 }
@group(0) @binding(0) var<uniform> p: Params;
@group(0) @binding(1) var<storage, read> src: array<f32>;
@group(0) @binding(2) var<storage, read> weights: array<f32>;
@group(0) @binding(3) var<storage, read> bias: array<f32>;
@group(0) @binding(4) var<storage, read> scale: array<f32>;
@group(0) @binding(5) var<storage, read> shift: array<f32>;
@group(0) @binding(6) var<storage, read_write> act: array<f32>;
${residual ? '@group(0) @binding(7) var<storage, read_write> raw: array<f32>;' : ''}

const BM = ${bm}u;
const BN = ${bn}u;
const BK = ${bk}u;
const AS = BM + 1u;
const WGX = ${wgx}u;
const WGY = ${wgy}u;
const THREADS = WGX * WGY;

var<workgroup> As: array<f32, ${bk * (bm + 1)}>;
var<workgroup> Bs: array<f32, ${bk * bn}>;
${MISH}

@compute @workgroup_size(${wgx}, ${wgy})
fn main(@builtin(local_invocation_id) lid: vec3u, @builtin(workgroup_id) wid: vec3u) {
    let t = lid.y * WGX + lid.x;
    let m0 = wid.y * BM;
    let o0 = wid.x * BN;
    ${accs.map(a => `var ${a} = 0.0;`).join(' ')}

    for (var k0 = 0u; k0 < 9u * p.ic; k0 += BK) {
        // BK divides ic: whole step on same kernel tap
        let tap = k0 / p.ic;
        let ic0 = k0 % p.ic;
        let dy = i32(tap / 3u) - 1;
        let dx = i32(tap % 3u) - 1;

        for (var i = t; i < BK * BM; i += THREADS) {
            let kk = i % BK;
            let mm = i / BK;
            let m = m0 + mm;
            var v = 0.0;
            if (m < p.m) {
                let x = i32(m % p.w) + dx;
                let y = i32((m / p.w) % p.h) + dy;
                if (x >= 0 && x < i32(p.w) && y >= 0 && y < i32(p.h)) {
                    v = src[u32(i32(m) + dy * i32(p.w) + dx) * p.ic + ic0 + kk];
                }
            }
            As[kk * AS + mm] = v;
        }

        for (var i = t; i < BK * BN; i += THREADS) {
            let nn = i % BN;
            let kk = i / BN;
            Bs[kk * BN + nn] = weights[(k0 + kk) * p.oc + o0 + nn];
        }

        workgroupBarrier();

        for (var kk = 0u; kk < BK; kk++) {
            ${range(tm).map(i => `let a${i} = As[kk * AS + lid.y + ${i * wgy}u];`).join('\n            ')}
            ${range(tn).map(j => `let b${j} = Bs[kk * BN + lid.x + ${j * wgx}u];`).join('\n            ')}
            ${range(tm).flatMap(i => range(tn).map(j => `acc${i}_${j} = fma(a${i}, b${j}, acc${i}_${j});`)).join('\n            ')}
        }

        workgroupBarrier();
    }

    ${range(tm).map(i => `{
        let m = m0 + lid.y + ${i * wgy}u;
        if (m < p.m) {
            ${range(tn).map(j => `{
                let o = o0 + lid.x + ${j * wgx}u;
                let index = m * p.oc + o;
                var v = acc${i}_${j} + bias[o];
                ${residual ? 'v += raw[index]; raw[index] = v;' : ''}
                act[index] = mish(v * scale[o] + shift[o]);
            }`).join('\n            ')}
        }
    }`).join('\n    ')}
}`;
};

/**
 * Same as convShader, with vec4 memory accesses: thread computes tm contiguous positions × tn contiguous channels.
 */
const convShaderVec4 = ({ bm, bn, tm, tn, bk }: Tile, residual: boolean): string => {
    const wgx = bn / tn, wgy = bm / tm, as = bm + 4;
    const quads = range(tn / 4);

    return /* wgsl */ `
struct Params { m: u32, h: u32, w: u32, ic: u32, oc: u32 }
@group(0) @binding(0) var<uniform> p: Params;
@group(0) @binding(1) var<storage, read> src: array<vec4f>;
@group(0) @binding(2) var<storage, read> weights: array<vec4f>;
@group(0) @binding(3) var<storage, read> bias: array<vec4f>;
@group(0) @binding(4) var<storage, read> scale: array<vec4f>;
@group(0) @binding(5) var<storage, read> shift: array<vec4f>;
@group(0) @binding(6) var<storage, read_write> act: array<vec4f>;
${residual ? '@group(0) @binding(7) var<storage, read_write> raw: array<vec4f>;' : ''}

const BM = ${bm}u;
const BN = ${bn}u;
const BK = ${bk}u;
const AS = ${as}u;
const WGX = ${wgx}u;
const THREADS = ${wgx * wgy}u;

// As: k major, positions contiguous, padded against bank conflicts on store
var<workgroup> As: array<f32, ${bk * as}>;
var<workgroup> Bs: array<vec4f, ${bk * bn / 4}>;

fn mish(x: vec4f) -> vec4f {
    let e = exp(min(x, vec4f(20.0)));
    let n = e * (e + 2.0);
    return x * n / (n + 2.0);
}

@compute @workgroup_size(${wgx}, ${wgy})
fn main(@builtin(local_invocation_id) lid: vec3u, @builtin(workgroup_id) wid: vec3u) {
    let t = lid.y * WGX + lid.x;
    let m0 = wid.y * BM;
    let o0 = wid.x * BN;
    let ic4 = p.ic / 4u;
    let oc4 = p.oc / 4u;
    ${range(tm).flatMap(i => quads.map(q => `var acc${i}_${q} = vec4f(0.0);`)).join(' ')}

    for (var k0 = 0u; k0 < 9u * p.ic; k0 += BK) {
        let tap = k0 / p.ic;
        let ic0 = (k0 % p.ic) / 4u;
        let dy = i32(tap / 3u) - 1;
        let dx = i32(tap % 3u) - 1;

        for (var i = t; i < BM * BK / 4u; i += THREADS) {
            let kq = i % (BK / 4u);
            let mm = i / (BK / 4u);
            let m = m0 + mm;
            var v = vec4f(0.0);
            if (m < p.m) {
                let x = i32(m % p.w) + dx;
                let y = i32((m / p.w) % p.h) + dy;
                if (x >= 0 && x < i32(p.w) && y >= 0 && y < i32(p.h)) {
                    v = src[u32(i32(m) + dy * i32(p.w) + dx) * ic4 + ic0 + kq];
                }
            }
            for (var c = 0u; c < 4u; c++) {
                let flat = (4u * kq + c) * AS + mm;
                As[flat] = v[c];
            }
        }

        for (var i = t; i < BK * BN / 4u; i += THREADS) {
            let nq = i % (BN / 4u);
            let kk = i / (BN / 4u);
            Bs[i] = weights[(k0 + kk) * oc4 + o0 / 4u + nq];
        }

        workgroupBarrier();

        for (var kk = 0u; kk < BK; kk++) {
            ${loadATileRows(tm)}
            ${quads.map(q => `let b${q} = Bs[(kk * BN + lid.x * ${tn}u) / 4u + ${q}u];`).join('\n            ')}
            ${range(tm).flatMap(i => quads.map(q => `acc${i}_${q} = fma(vec4f(a${Math.floor(i / 4)}[${i % 4}]), b${q}, acc${i}_${q});`)).join('\n            ')}
        }

        workgroupBarrier();
    }

    ${range(tm).map(i => `{
        let m = m0 + lid.y * ${tm}u + ${i}u;
        if (m < p.m) {
            ${quads.map(q => `{
                let o = o0 / 4u + lid.x * ${tn / 4}u + ${q}u;
                let index = m * oc4 + o;
                var v = acc${i}_${q} + bias[o];
                ${residual ? 'v += raw[index]; raw[index] = v;' : ''}
                act[index] = mish(v * scale[o] + shift[o]);
            }`).join('\n            ')}
        }
    }`).join('\n    ')}
}`;
};

const BN_MISH_SHADER = /* wgsl */ `
@group(0) @binding(0) var<storage, read> src: array<f32>;
@group(0) @binding(1) var<storage, read> scale: array<f32>;
@group(0) @binding(2) var<storage, read> shift: array<f32>;
@group(0) @binding(3) var<storage, read_write> dst: array<f32>;
${MISH}

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) id: vec3u) {
    if (id.x < arrayLength(&dst)) {
        let c = id.x % ${CHANNELS}u;
        dst[id.x] = mish(src[id.x] * scale[c] + shift[c]);
    }
}`;

// GPUBufferUsage
const STORAGE = 0x80, COPY_DST = 0x08, COPY_SRC = 0x04, UNIFORM = 0x40, MAP_READ = 0x01;

type Weights = {
    s0: Float32Array,
    b0: Float32Array,
    blocks: { w1: Float32Array, b1: Float32Array, w2: Float32Array, b2: Float32Array, s: Float32Array, b: Float32Array }[],
};

const readWeights = (buffer: ArrayBuffer): Weights => {
    let offset = 0;
    const next = (n: number): Float32Array => {
        const v = new Float32Array(buffer, offset, n);
        offset += n * 4;
        return v;
    };
    const conv = CHANNELS * CHANNELS * 9;

    return {
        s0: next(CHANNELS),
        b0: next(CHANNELS),
        blocks: range(BLOCKS).map(() => ({
            w1: next(conv), b1: next(CHANNELS), w2: next(conv), b2: next(CHANNELS), s: next(CHANNELS), b: next(CHANNELS),
        })),
    };
};

/**
 * Same weights on GPU for all runs.
 */
const uploadWeights = (device: any, weights: Weights) => {
    const upload = (data: Float32Array) => {
        const buffer = device.createBuffer({ size: data.byteLength, usage: STORAGE | COPY_DST });
        device.queue.writeBuffer(buffer, 0, data);
        return buffer;
    };

    return {
        s0: upload(weights.s0),
        b0: upload(weights.b0),
        ones: upload(new Float32Array(CHANNELS).fill(1)),
        zeros: upload(new Float32Array(CHANNELS)),
        blocks: weights.blocks.map(block => Object.fromEntries(Object.entries(block).map(([name, data]) => [name, upload(data)]))),
    };
};

type Run = (input: Float32Array) => Promise<Float32Array>;

/**
 * Input and output NHWC.
 */
const customRun = (device: any, gpuWeights: ReturnType<typeof uploadWeights>, tile: Tile, n: number, size: number): Run => {
    const m = n * size * size;
    const bytes = m * CHANNELS * 4;
    const buffer = (usage: number) => device.createBuffer({ size: bytes, usage });
    const x = buffer(STORAGE | COPY_DST);
    const a = buffer(STORAGE | COPY_SRC);
    const h = buffer(STORAGE);
    const readback = buffer(MAP_READ | COPY_DST);

    const uniform = device.createBuffer({ size: 32, usage: UNIFORM | COPY_DST });
    device.queue.writeBuffer(uniform, 0, new Uint32Array([m, size, size, CHANNELS, CHANNELS, 0, 0, 0]));

    const pipeline = (code: string) => device.createComputePipeline({
        layout: 'auto',
        compute: { module: device.createShaderModule({ code }), entryPoint: 'main' },
    });
    const bindGroup = (p: any, buffers: any[]) => device.createBindGroup({
        layout: p.getBindGroupLayout(0),
        entries: buffers.map((b, binding) => ({ binding, resource: { buffer: b } })),
    });

    const bnMish = pipeline(BN_MISH_SHADER);
    const shader = tile.vec4 ? convShaderVec4 : convShader;
    const conv = pipeline(shader(tile, false));
    const convResidual = pipeline(shader(tile, true));

    const steps: [any, any, number][] = [[bnMish, bindGroup(bnMish, [x, gpuWeights.s0, gpuWeights.b0, a]), Math.ceil(m * CHANNELS / 256)]];

    for (const block of gpuWeights.blocks) {
        steps.push([conv, bindGroup(conv, [uniform, a, block.w1, block.b1, gpuWeights.ones, gpuWeights.zeros, h]), 0]);
        steps.push([convResidual, bindGroup(convResidual, [uniform, h, block.w2, block.b2, block.s, block.b, a, x]), 0]);
    }

    return async input => {
        device.queue.writeBuffer(x, 0, input);

        const encoder = device.createCommandEncoder();
        const pass = encoder.beginComputePass();

        for (const [p, group, elementwise] of steps) {
            pass.setPipeline(p);
            pass.setBindGroup(0, group);

            if (elementwise) {
                pass.dispatchWorkgroups(elementwise);
            } else {
                pass.dispatchWorkgroups(CHANNELS / tile.bn, Math.ceil(m / tile.bm));
            }
        }

        pass.end();
        encoder.copyBufferToBuffer(a, 0, readback, 0, bytes);
        device.queue.submit([encoder.finish()]);

        await readback.mapAsync(1);
        const output = new Float32Array(readback.getMappedRange().slice(0));
        readback.unmap();

        return output;
    };
};

/*
 * Winograd F(2,3): conv 3×3 as 16 matrix products of [tiles, ic] × [ic, oc], tile is 2×2 output positions.
 * Input transform, batched products, then output transform with same epilogue as conv.
 */

// Previous results, Ampere: input transform fused into products (4 loads per value) not faster
const WINOGRAD_TILES: Tile[] = [
    { bm: 64, bn: 64, tm: 4, tn: 4, bk: 16, vec4: true },
    { bm: 32, bn: 64, tm: 4, tn: 4, bk: 16, vec4: true },
    { bm: 32, bn: 32, tm: 4, tn: 4, bk: 16, vec4: true },
    { bm: 64, bn: 64, tm: 8, tn: 4, bk: 32, vec4: true },
];

const WINOGRAD_PARAMS = 'struct Params { t: u32, h: u32, w: u32, th: u32, tw: u32 }\n@group(0) @binding(0) var<uniform> p: Params;';

const winogradIndex = /* wgsl */ `
    let tx = t % p.tw;
    let ty = (t / p.tw) % p.th;
    let n = t / (p.tw * p.th);`;

/**
 * V = Bᵀ d B of each 4×4 input patch, to [16, tiles, channels].
 */
const winogradInputShader = (channels: number): string => {
    const d = (i: number, j: number) => `d${i}${j}`;
    const e = (i: number, j: number) => `e${i}${j}`;

    return /* wgsl */ `
${WINOGRAD_PARAMS}
@group(0) @binding(1) var<storage, read> src: array<vec4f>;
@group(0) @binding(2) var<storage, read_write> v: array<vec4f>;
const C4 = ${channels / 4}u;

fn load(n: u32, y: i32, x: i32, c: u32) -> vec4f {
    if (y < 0 || x < 0 || y >= i32(p.h) || x >= i32(p.w)) {
        return vec4f(0.0);
    }
    return src[((n * p.h + u32(y)) * p.w + u32(x)) * C4 + c];
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3u) {
    let c = id.x % C4;
    let t = id.x / C4;
    if (t >= p.t) {
        return;
    }
    ${winogradIndex}
    let y0 = i32(2u * ty) - 1;
    let x0 = i32(2u * tx) - 1;
    ${range(4).flatMap(i => range(4).map(j => `let ${d(i, j)} = load(n, y0 + ${i}, x0 + ${j}, c);`)).join('\n    ')}
    ${range(4).flatMap(j => [
        `let ${e(0, j)} = ${d(0, j)} - ${d(2, j)};`,
        `let ${e(1, j)} = ${d(1, j)} + ${d(2, j)};`,
        `let ${e(2, j)} = ${d(2, j)} - ${d(1, j)};`,
        `let ${e(3, j)} = ${d(1, j)} - ${d(3, j)};`,
    ]).join('\n    ')}
    ${range(4).flatMap(i => [
        `v[(${i * 4}u * p.t + t) * C4 + c] = ${e(i, 0)} - ${e(i, 2)};`,
        `v[(${i * 4 + 1}u * p.t + t) * C4 + c] = ${e(i, 1)} + ${e(i, 2)};`,
        `v[(${i * 4 + 2}u * p.t + t) * C4 + c] = ${e(i, 2)} - ${e(i, 1)};`,
        `v[(${i * 4 + 3}u * p.t + t) * C4 + c] = ${e(i, 1)} - ${e(i, 3)};`,
    ]).join('\n    ')}
}`;
};

/**
 * 16 products [tiles, k] × [k, n], one per workgroup z.
 */
const winogradGemmShader = ({ bm, bn, tm, tn, bk }: Tile, k: number, n: number): string => {
    const wgx = bn / tn, wgy = bm / tm, as = bm + 4;
    const quads = range(tn / 4);

    return /* wgsl */ `
${WINOGRAD_PARAMS}
@group(0) @binding(1) var<storage, read> a: array<vec4f>;
@group(0) @binding(2) var<storage, read> b: array<vec4f>;
@group(0) @binding(3) var<storage, read_write> c: array<vec4f>;

const K4 = ${k / 4}u;
const N4 = ${n / 4}u;
const BM = ${bm}u;
const BN = ${bn}u;
const BK = ${bk}u;
const AS = ${as}u;
const WGX = ${wgx}u;
const THREADS = ${wgx * wgy}u;

var<workgroup> As: array<f32, ${bk * as}>;
var<workgroup> Bs: array<vec4f, ${bk * bn / 4}>;

@compute @workgroup_size(${wgx}, ${wgy})
fn main(@builtin(local_invocation_id) lid: vec3u, @builtin(workgroup_id) wid: vec3u) {
    let t = lid.y * WGX + lid.x;
    let m0 = wid.y * BM;
    let o0 = wid.x * BN;
    let aBase = wid.z * p.t * K4;
    let bBase = wid.z * ${k}u * N4;
    let cBase = wid.z * p.t * N4;
    ${range(tm).flatMap(i => quads.map(q => `var acc${i}_${q} = vec4f(0.0);`)).join(' ')}

    for (var k0 = 0u; k0 < ${k}u; k0 += BK) {
        for (var i = t; i < BM * BK / 4u; i += THREADS) {
            let kq = i % (BK / 4u);
            let mm = i / (BK / 4u);
            var v = vec4f(0.0);
            if (m0 + mm < p.t) {
                v = a[aBase + (m0 + mm) * K4 + k0 / 4u + kq];
            }
            for (var j = 0u; j < 4u; j++) {
                let flat = (4u * kq + j) * AS + mm;
                As[flat] = v[j];
            }
        }

        for (var i = t; i < BK * BN / 4u; i += THREADS) {
            let nq = i % (BN / 4u);
            let kk = i / (BN / 4u);
            Bs[i] = b[bBase + (k0 + kk) * N4 + o0 / 4u + nq];
        }

        workgroupBarrier();

        for (var kk = 0u; kk < BK; kk++) {
            ${loadATileRows(tm)}
            ${quads.map(q => `let b${q} = Bs[(kk * BN + lid.x * ${tn}u) / 4u + ${q}u];`).join('\n            ')}
            ${range(tm).flatMap(i => quads.map(q => `acc${i}_${q} = fma(vec4f(a${Math.floor(i / 4)}[${i % 4}]), b${q}, acc${i}_${q});`)).join('\n            ')}
        }

        workgroupBarrier();
    }

    ${range(tm).map(i => `if (m0 + lid.y * ${tm}u + ${i}u < p.t) {
        ${quads.map(q => `c[cBase + (m0 + lid.y * ${tm}u + ${i}u) * N4 + o0 / 4u + lid.x * ${tn / 4}u + ${q}u] = acc${i}_${q};`).join('\n        ')}
    }`).join('\n    ')}
}`;
};

/**
 * Y = Aᵀ M A of each tile, 2×2 output positions, then conv epilogue.
 */
const winogradOutputShader = (channels: number, residual: boolean): string => {
    const m = (i: number, j: number) => `m${i}${j}`;
    const r = (i: number, j: number) => `r${i}${j}`;

    return /* wgsl */ `
${WINOGRAD_PARAMS}
@group(0) @binding(1) var<storage, read> mt: array<vec4f>;
@group(0) @binding(2) var<storage, read> bias: array<vec4f>;
@group(0) @binding(3) var<storage, read> scale: array<vec4f>;
@group(0) @binding(4) var<storage, read> shift: array<vec4f>;
@group(0) @binding(5) var<storage, read_write> act: array<vec4f>;
${residual ? '@group(0) @binding(6) var<storage, read_write> raw: array<vec4f>;' : ''}
const C4 = ${channels / 4}u;

fn mish(x: vec4f) -> vec4f {
    let e = exp(min(x, vec4f(20.0)));
    let n = e * (e + 2.0);
    return x * n / (n + 2.0);
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3u) {
    let o = id.x % C4;
    let t = id.x / C4;
    if (t >= p.t) {
        return;
    }
    ${winogradIndex}
    ${range(4).flatMap(i => range(4).map(j => `let ${m(i, j)} = mt[(${i * 4 + j}u * p.t + t) * C4 + o];`)).join('\n    ')}
    ${range(4).flatMap(j => [
        `let ${r(0, j)} = ${m(0, j)} + ${m(1, j)} + ${m(2, j)};`,
        `let ${r(1, j)} = ${m(1, j)} - ${m(2, j)} - ${m(3, j)};`,
    ]).join('\n    ')}
    let ys = array<vec4f, 4>(
        ${r(0, 0)} + ${r(0, 1)} + ${r(0, 2)}, ${r(0, 1)} - ${r(0, 2)} - ${r(0, 3)},
        ${r(1, 0)} + ${r(1, 1)} + ${r(1, 2)}, ${r(1, 1)} - ${r(1, 2)} - ${r(1, 3)},
    );
    for (var i = 0u; i < 4u; i++) {
        let y = 2u * ty + i / 2u;
        let x = 2u * tx + i % 2u;
        if (y < p.h && x < p.w) {
            let index = ((n * p.h + y) * p.w + x) * C4 + o;
            var v = ys[i] + bias[o];
            ${residual ? 'v += raw[index]; raw[index] = v;' : ''}
            act[index] = mish(v * scale[o] + shift[o]);
        }
    }
}`;
};

/**
 * U = G g Gᵀ of [3, 3, ic, oc] weights, to [16, ic, oc].
 */
const winogradFilter = (w: Float32Array, ic: number, oc: number): Float32Array => {
    const G = [[1, 0, 0], [0.5, 0.5, 0.5], [0.5, -0.5, 0.5], [0, 0, 1]];
    const u = new Float32Array(16 * ic * oc);

    for (let i = 0; i < ic; ++i) {
        for (let o = 0; o < oc; ++o) {
            const g = (y: number, x: number) => w[((y * 3 + x) * ic + i) * oc + o];

            for (let a = 0; a < 4; ++a) {
                for (let b = 0; b < 4; ++b) {
                    let sum = 0;

                    for (let y = 0; y < 3; ++y) {
                        for (let x = 0; x < 3; ++x) {
                            sum += G[a][y] * g(y, x) * G[b][x];
                        }
                    }

                    u[((a * 4 + b) * ic + i) * oc + o] = sum;
                }
            }
        }
    }

    return u;
};

const winogradRun = (device: any, gpuWeights: ReturnType<typeof uploadWeights>, filters: any[][], tile: Tile, n: number, size: number): Run => {
    const m = n * size * size;
    const bytes = m * CHANNELS * 4;
    const th = Math.ceil(size / 2);
    const tiles = n * th * th;
    const buffer = (size: number, usage: number) => device.createBuffer({ size, usage });
    const x = buffer(bytes, STORAGE | COPY_DST);
    const a = buffer(bytes, STORAGE | COPY_SRC);
    const h = buffer(bytes, STORAGE);
    const v = buffer(16 * tiles * CHANNELS * 4, STORAGE);
    const products = buffer(16 * tiles * CHANNELS * 4, STORAGE);
    const readback = buffer(bytes, MAP_READ | COPY_DST);

    const uniform = device.createBuffer({ size: 32, usage: UNIFORM | COPY_DST });
    device.queue.writeBuffer(uniform, 0, new Uint32Array([tiles, size, size, th, th, 0, 0, 0]));

    const pipeline = (code: string) => device.createComputePipeline({
        layout: 'auto',
        compute: { module: device.createShaderModule({ code }), entryPoint: 'main' },
    });
    const bindGroup = (p: any, buffers: any[]) => device.createBindGroup({
        layout: p.getBindGroupLayout(0),
        entries: buffers.map((b, binding) => ({ binding, resource: { buffer: b } })),
    });

    const bnMish = pipeline(BN_MISH_SHADER);
    const input = pipeline(winogradInputShader(CHANNELS));
    const gemm = pipeline(winogradGemmShader(tile, CHANNELS, CHANNELS));
    const output = pipeline(winogradOutputShader(CHANNELS, false));
    const outputResidual = pipeline(winogradOutputShader(CHANNELS, true));
    const elementwise = Math.ceil(tiles * CHANNELS / 4 / 64);
    const gemmWorkgroups = [CHANNELS / tile.bn, Math.ceil(tiles / tile.bm), 16];

    const steps: [any, any, number[]][] = [[bnMish, bindGroup(bnMish, [x, gpuWeights.s0, gpuWeights.b0, a]), [Math.ceil(m * CHANNELS / 256)]]];

    gpuWeights.blocks.forEach((block, i) => {
        const [u1, u2] = filters[i];

        steps.push([input, bindGroup(input, [uniform, a, v]), [elementwise]]);
        steps.push([gemm, bindGroup(gemm, [uniform, v, u1, products]), gemmWorkgroups]);
        steps.push([output, bindGroup(output, [uniform, products, block.b1, gpuWeights.ones, gpuWeights.zeros, h]), [elementwise]]);
        steps.push([input, bindGroup(input, [uniform, h, v]), [elementwise]]);
        steps.push([gemm, bindGroup(gemm, [uniform, v, u2, products]), gemmWorkgroups]);
        steps.push([outputResidual, bindGroup(outputResidual, [uniform, products, block.b2, block.s, block.b, a, x]), [elementwise]]);
    });

    return async inputData => {
        device.queue.writeBuffer(x, 0, inputData);

        const encoder = device.createCommandEncoder();
        const pass = encoder.beginComputePass();

        for (const [p, group, workgroups] of steps) {
            pass.setPipeline(p);
            pass.setBindGroup(0, group);
            pass.dispatchWorkgroups(...workgroups);
        }

        pass.end();
        encoder.copyBufferToBuffer(a, 0, readback, 0, bytes);
        device.queue.submit([encoder.finish()]);

        await readback.mapAsync(1);
        const result = new Float32Array(readback.getMappedRange().slice(0));
        readback.unmap();

        return result;
    };
};

const nchwToNhwc = (data: Float32Array, n: number, c: number, area: number): Float32Array => {
    const out = new Float32Array(data.length);

    for (let i = 0; i < n; ++i) {
        for (let ch = 0; ch < c; ++ch) {
            for (let p = 0; p < area; ++p) {
                out[(i * area + p) * c + ch] = data[(i * c + ch) * area + p];
            }
        }
    }

    return out;
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

const time = async (run: () => Promise<unknown>): Promise<number> => {
    // First runs of a shape are slower
    await run();
    await run();

    const startedAt = performance.now();

    for (let i = 0; i < RUNS; ++i) {
        await run();
    }

    return (performance.now() - startedAt) / RUNS;
};

const report = (label: string, size: number, n: number, ms: number, diff: string): void => {
    const gflops = BLOCKS * 2 * 2 * n * size * size * CHANNELS * CHANNELS * 9 / ms / 1e6;

    addRow([label, `${size}×${size}`, String(n), `${ms.toFixed(1)}ms`, String(Math.round(gflops)), diff]);
    log(`${label}\t${size}×${size}\tbatch ${n}\t${ms.toFixed(1)}ms\t${Math.round(gflops)} GFLOP/s\t${diff}`);
};

$('run').addEventListener('click', async () => {
    const button = $('run') as HTMLButtonElement;

    button.disabled = true;
    $('results').innerHTML = '';
    $('log').textContent = '';

    try {
        const gpu = (navigator as any).gpu;
        const adapter = await gpu.requestAdapter({ powerPreference: 'high-performance' });
        // Bigger tiles need more than default 16KB of workgroup memory
        const device = await adapter.requestDevice({
            requiredLimits: { maxComputeWorkgroupStorageSize: adapter.limits.maxComputeWorkgroupStorageSize },
        });
        log(`GPU: ${adapter.info?.description || adapter.info?.vendor} ${adapter.info?.architecture ?? ''}`);

        device.addEventListener('uncapturederror', (e: any) => log(`GPU error: ${e.error.message}`));

        const [model, weightsBuffer] = await Promise.all([MODEL_URL, WEIGHTS_URL].map(async url => (await fetch(url)).arrayBuffer()));
        const weights = readWeights(weightsBuffer);
        const gpuWeights = uploadWeights(device, weights);
        const upload = (data: Float32Array) => {
            const buffer = device.createBuffer({ size: data.byteLength, usage: STORAGE | COPY_DST });
            device.queue.writeBuffer(buffer, 0, data);
            return buffer;
        };
        const filters = weights.blocks.map(block => [block.w1, block.w2].map(w => upload(winogradFilter(w, CHANNELS, CHANNELS))));

        for (const size of SIZES) {
            for (const n of BATCH_SIZES) {
                const area = size * size;
                const input = new Float32Array(n * CHANNELS * area).map(() => Math.random() * 2 - 1);
                const inputNhwc = nchwToNhwc(input, n, CHANNELS, area);
                $('status').textContent = `${size}×${size}, batch ${n}`;

                const session = await ort.InferenceSession.create(new Uint8Array(model), {
                    executionProviders: ['webgpu'],
                    graphOptimizationLevel: 'all',
                    freeDimensionOverrides: { N: n, H: size, W: size },
                });
                const ortRun = async () => (await session.run({ x: new ort.Tensor('float32', input, [n, CHANNELS, size, size]) })).out.getData();
                const expected = nchwToNhwc(await ortRun() as Float32Array, n, CHANNELS, area);
                const scale = expected.reduce((max, v) => Math.max(max, Math.abs(v)), 0);

                if (only === null || 'onnxruntime'.includes(only)) {
                    report('onnxruntime', size, n, await time(ortRun), '');
                }

                await session.release();

                for (const tile of TILES) {
                    const label = `custom ${tile.vec4 ? 'vec4 ' : ''}${tile.bm}×${tile.bn}, ${tile.tm}×${tile.tn} per thread, k ${tile.bk}`;

                    if (only !== null && !label.includes(only)) {
                        continue;
                    }

                    const run = customRun(device, gpuWeights, tile, n, size);
                    const actual = await run(inputNhwc);
                    const diff = actual.reduce((max, v, i) => Math.max(max, Math.abs(v - expected[i])), 0) / scale;

                    report(label, size, n, await time(() => run(inputNhwc)), diff.toExponential(1));
                }

                for (const tile of WINOGRAD_TILES) {
                    const label = `winograd F(2,3) ${tile.bm}×${tile.bn}, ${tile.tm}×${tile.tn} per thread, k ${tile.bk}`;

                    if (only !== null && !label.includes(only)) {
                        continue;
                    }

                    const run = winogradRun(device, gpuWeights, filters, tile, n, size);
                    const actual = await run(inputNhwc);
                    const diff = actual.reduce((max, v, i) => Math.max(max, Math.abs(v - expected[i])), 0) / scale;

                    report(label, size, n, await time(() => run(inputNhwc)), diff.toExponential(1));
                }
            }
        }

        $('status').textContent = 'Done, copy table or log below';
    } catch (e) {
        log(`failed: ${String(e)}`);
        $('status').textContent = 'Failed';
    }

    button.disabled = false;
});
