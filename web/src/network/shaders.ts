import type { Activation } from './readKatahexModel';

/*
 * WGSL shaders of WebGpuNetwork. Tensors are NHWC, channels contiguous, float32.
 * Benchmarked in web/kernels.html.
 */

/**
 * Same for all shaders, written before each run.
 */
export const PARAMS = /* wgsl */ `
struct Params { m: u32, h: u32, w: u32, n: u32, sizeScale: f32, tiles: u32, th: u32, tw: u32 }
@group(0) @binding(0) var<uniform> p: Params;`;

const activation = (act: Activation, type: string): string => {
    switch (act) {
        case 'ACTIVATION_IDENTITY': return `fn act(x: ${type}) -> ${type} { return x; }`;
        case 'ACTIVATION_RELU': return `fn act(x: ${type}) -> ${type} { return max(x, ${type}(0.0)); }`;
        case 'ACTIVATION_MISH': return /* wgsl */ `
fn act(x: ${type}) -> ${type} {
    // tanh(softplus(x)) = n / (n + 2), n = e^x (e^x + 2)
    let e = exp(min(x, ${type}(20.0)));
    let n = e * (e + 2.0);
    return x * n / (n + 2.0);
}`;
    }
};

const range = (n: number): number[] => [...Array(n).keys()];

// Each loader writes its own scalar slot in As. Gather vectors after the workgroup barrier.
export const loadATileRows = (tm: number): string => range(tm / 4).flatMap(r => [
    `let aBase${r} = kk * AS + lid.y * ${tm}u + ${4 * r}u;`,
    `let a${r} = vec4f(As[aBase${r}], As[aBase${r} + 1u], As[aBase${r} + 2u], As[aBase${r} + 3u]);`,
]).join('\n            ');

export type ConvOptions = {
    kernel: 1 | 3,
    ic: number,
    oc: number,

    /**
     * Raw output: none, written, or added to (residual).
     */
    raw: 'none' | 'write' | 'add',

    /**
     * Per position bias [n, oc], i.e from global pooling.
     */
    batchBias: boolean,

    /**
     * Activated output: act(v * scale + shift), v = conv + bias [+ batch bias] [+ residual].
     */
    act: Activation,

    /**
     * Tile for many positions, see convTile.
     */
    large: boolean,
};

/**
 * Runs with at least this many positions use large tile.
 */
export const LARGE_TILE_MIN_CELLS = 1500;

/**
 * Workgroup tile, bm positions × bn channels, tm × tn per thread. Best ones on Ampere in kernels.html:
 * 4×4 k 16 for 11×11 batch 8, 8×4 k 32 from ~1500 positions.
 */
export const convTile = (ic: number, oc: number, large: boolean) => {
    const bn = oc % 64 === 0 ? 64 : oc % 32 === 0 ? 32 : 16;

    return large && ic % 32 === 0 ? { bm: 64, bn, tm: 8, tn: 4, bk: 32 } : { bm: 64, bn, tm: 4, tn: 4, bk: 16 };
};

/**
 * Conv as tiled matrix product of [m, kernel² × ic] positions × [kernel² × ic, oc] weights.
 * Bindings: 1 src, 2 weights, 3 bias, 4 scale, 5 shift, 6 act, 7 raw, 8 batch bias.
 */
export const convShader = ({ kernel, ic, oc, raw, batchBias, act, large }: ConvOptions): string => {
    const { bm, bn, tm, tn, bk } = convTile(ic, oc, large);
    const wgx = bn / tn, wgy = bm / tm, as = bm + 4;
    const quads = range(tn / 4);

    if (ic % bk !== 0 || oc % 4 !== 0) {
        throw new Error(`Conv ${ic} -> ${oc} channels not supported`);
    }

    return /* wgsl */ `
${PARAMS}
@group(0) @binding(1) var<storage, read> src: array<vec4f>;
@group(0) @binding(2) var<storage, read> weights: array<vec4f>;
@group(0) @binding(3) var<storage, read> bias: array<vec4f>;
@group(0) @binding(4) var<storage, read> scale: array<vec4f>;
@group(0) @binding(5) var<storage, read> shift: array<vec4f>;
@group(0) @binding(6) var<storage, read_write> out: array<vec4f>;
${raw !== 'none' ? '@group(0) @binding(7) var<storage, read_write> raw: array<vec4f>;' : ''}
${batchBias ? '@group(0) @binding(8) var<storage, read> batchBias: array<vec4f>;' : ''}

const IC = ${ic}u;
const IC4 = ${ic / 4}u;
const OC4 = ${oc / 4}u;
const BM = ${bm}u;
const BN = ${bn}u;
const BK = ${bk}u;
const AS = ${as}u;
const WGX = ${wgx}u;
const THREADS = ${wgx * wgy}u;

// As: k major, positions contiguous, padded against bank conflicts on store
var<workgroup> As: array<f32, ${bk * as}>;
var<workgroup> Bs: array<vec4f, ${bk * bn / 4}>;
${activation(act, 'vec4f')}

@compute @workgroup_size(${wgx}, ${wgy})
fn main(@builtin(local_invocation_id) lid: vec3u, @builtin(workgroup_id) wid: vec3u) {
    let t = lid.y * WGX + lid.x;
    let m0 = wid.y * BM;
    let o0 = wid.x * BN;
    ${range(tm).flatMap(i => quads.map(q => `var acc${i}_${q} = vec4f(0.0);`)).join(' ')}

    for (var k0 = 0u; k0 < ${kernel * kernel}u * IC; k0 += BK) {
        // BK divides IC: whole step on same kernel tap
        let tap = k0 / IC;
        let ic0 = (k0 % IC) / 4u;
        let dy = ${kernel === 3 ? 'i32(tap / 3u) - 1' : '0'};
        let dx = ${kernel === 3 ? 'i32(tap % 3u) - 1' : '0'};

        for (var i = t; i < BM * BK / 4u; i += THREADS) {
            let kq = i % (BK / 4u);
            let mm = i / (BK / 4u);
            let m = m0 + mm;
            var v = vec4f(0.0);
            if (m < p.m) {
                let x = i32(m % p.w) + dx;
                let y = i32((m / p.w) % p.h) + dy;
                if (x >= 0 && x < i32(p.w) && y >= 0 && y < i32(p.h)) {
                    v = src[u32(i32(m) + dy * i32(p.w) + dx) * IC4 + ic0 + kq];
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
            Bs[i] = weights[(k0 + kk) * OC4 + o0 / 4u + nq];
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
                let index = m * OC4 + o;
                var v = acc${i}_${q} + bias[o];
                ${batchBias ? 'v += batchBias[(m / (p.h * p.w)) * OC4 + o];' : ''}
                ${raw === 'add' ? 'v += raw[index];' : ''}
                ${raw !== 'none' ? 'raw[index] = v;' : ''}
                out[index] = act(v * scale[o] + shift[o]);
            }`).join('\n            ')}
        }
    }`).join('\n    ')}
}`;
};

/**
 * Global pooling of [n, h, w, c] to [n, 3c]: mean, mean × size scale, then max (gpool)
 * or mean × (size scale² - 0.1) (value head). One thread per position and channel.
 */
export const poolShader = (c: number, kind: 'gpool' | 'value'): string => /* wgsl */ `
${PARAMS}
@group(0) @binding(1) var<storage, read> src: array<f32>;
@group(0) @binding(2) var<storage, read_write> out: array<f32>;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3u) {
    let c = id.x % ${c}u;
    let n = id.x / ${c}u;
    if (n >= p.n) {
        return;
    }
    let area = p.h * p.w;
    var sum = 0.0;
    var maximum = -3.4e38;
    for (var i = 0u; i < area; i++) {
        let v = src[(n * area + i) * ${c}u + c];
        sum += v;
        maximum = max(maximum, v);
    }
    let mean = sum / f32(area);
    out[n * ${3 * c}u + c] = mean;
    out[n * ${3 * c}u + ${c}u + c] = mean * p.sizeScale;
    out[n * ${3 * c}u + ${2 * c}u + c] = ${kind === 'gpool' ? 'maximum' : 'mean * (p.sizeScale * p.sizeScale - 0.1)'};
}`;

/**
 * [n, ic] × [ic, oc] + bias, activated. One thread per output.
 */
export const matMulShader = (ic: number, oc: number, act: Activation): string => /* wgsl */ `
${PARAMS}
@group(0) @binding(1) var<storage, read> src: array<f32>;
@group(0) @binding(2) var<storage, read> weights: array<f32>;
@group(0) @binding(3) var<storage, read> bias: array<f32>;
@group(0) @binding(4) var<storage, read_write> out: array<f32>;
${activation(act, 'f32')}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3u) {
    let o = id.x % ${oc}u;
    let n = id.x / ${oc}u;
    if (n >= p.n) {
        return;
    }
    var sum = bias[o];
    for (var k = 0u; k < ${ic}u; k++) {
        sum = fma(src[n * ${ic}u + k], weights[k * ${oc}u + o], sum);
    }
    out[n * ${oc}u + o] = act(sum);
}`;

/**
 * 1×1 conv to a single channel: [m, c] · [c]. One thread per position.
 */
export const dotShader = (c: number): string => /* wgsl */ `
${PARAMS}
@group(0) @binding(1) var<storage, read> src: array<f32>;
@group(0) @binding(2) var<storage, read> weights: array<f32>;
@group(0) @binding(3) var<storage, read_write> out: array<f32>;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3u) {
    if (id.x >= p.m) {
        return;
    }
    var sum = 0.0;
    for (var k = 0u; k < ${c}u; k++) {
        sum = fma(src[id.x * ${c}u + k], weights[k], sum);
    }
    out[id.x] = sum;
}`;

/*
 * Winograd F(2,3) for conv 3×3, ~1.5× faster (kernels.html): 16 matrix products of [tiles, ic] × [ic, oc],
 * tile is 2×2 output positions. Input transform, batched products, then output transform with conv epilogue.
 */

/**
 * Tiles of all positions of a run, at most: bigger runs use direct conv.
 */
export const WINOGRAD_MAX_TILES = 3072;

export const winogradTile = (ic: number, oc: number, large: boolean) => {
    const bn = oc % 64 === 0 ? 64 : oc % 32 === 0 ? 32 : 16;

    return large && ic % 32 === 0 ? { bm: 64, bn, tm: 8, tn: 4, bk: 32 } : { bm: 64, bn, tm: 4, tn: 4, bk: 16 };
};

const tileIndex = /* wgsl */ `
    let tx = t % p.tw;
    let ty = (t / p.tw) % p.th;
    let n = t / (p.tw * p.th);`;

/**
 * V = Bᵀ d B of each 4×4 input patch, to [16, tiles, c].
 */
export const winogradInputShader = (c: number): string => {
    const d = (i: number, j: number) => `d${i}${j}`;
    const e = (i: number, j: number) => `e${i}${j}`;

    return /* wgsl */ `
${PARAMS}
@group(0) @binding(1) var<storage, read> src: array<vec4f>;
@group(0) @binding(2) var<storage, read_write> v: array<vec4f>;
const C4 = ${c / 4}u;

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
    if (t >= p.tiles) {
        return;
    }
    ${tileIndex}
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
        `v[(${i * 4}u * p.tiles + t) * C4 + c] = ${e(i, 0)} - ${e(i, 2)};`,
        `v[(${i * 4 + 1}u * p.tiles + t) * C4 + c] = ${e(i, 1)} + ${e(i, 2)};`,
        `v[(${i * 4 + 2}u * p.tiles + t) * C4 + c] = ${e(i, 2)} - ${e(i, 1)};`,
        `v[(${i * 4 + 3}u * p.tiles + t) * C4 + c] = ${e(i, 1)} - ${e(i, 3)};`,
    ]).join('\n    ')}
}`;
};

/**
 * 16 products [tiles, ic] × [ic, oc], one per workgroup z.
 */
export const winogradGemmShader = (ic: number, oc: number, large: boolean): string => {
    const { bm, bn, tm, tn, bk } = winogradTile(ic, oc, large);
    const wgx = bn / tn, wgy = bm / tm, as = bm + 4;
    const quads = range(tn / 4);

    if (ic % bk !== 0 || oc % 4 !== 0) {
        throw new Error(`Winograd conv ${ic} -> ${oc} channels not supported`);
    }

    return /* wgsl */ `
${PARAMS}
@group(0) @binding(1) var<storage, read> a: array<vec4f>;
@group(0) @binding(2) var<storage, read> b: array<vec4f>;
@group(0) @binding(3) var<storage, read_write> c: array<vec4f>;

const K4 = ${ic / 4}u;
const N4 = ${oc / 4}u;
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
    let aBase = wid.z * p.tiles * K4;
    let bBase = wid.z * ${ic}u * N4;
    let cBase = wid.z * p.tiles * N4;
    ${range(tm).flatMap(i => quads.map(q => `var acc${i}_${q} = vec4f(0.0);`)).join(' ')}

    for (var k0 = 0u; k0 < ${ic}u; k0 += BK) {
        for (var i = t; i < BM * BK / 4u; i += THREADS) {
            let kq = i % (BK / 4u);
            let mm = i / (BK / 4u);
            var v = vec4f(0.0);
            if (m0 + mm < p.tiles) {
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

    ${range(tm).map(i => `if (m0 + lid.y * ${tm}u + ${i}u < p.tiles) {
        ${quads.map(q => `c[cBase + (m0 + lid.y * ${tm}u + ${i}u) * N4 + o0 / 4u + lid.x * ${tn / 4}u + ${q}u] = acc${i}_${q};`).join('\n        ')}
    }`).join('\n    ')}
}`;
};

/**
 * Y = Aᵀ M A of each tile, 2×2 output positions, then same epilogue as convShader.
 * Bindings: 1 products, 3 bias, 4 scale, 5 shift, 6 act, 7 raw, 8 batch bias.
 */
export const winogradOutputShader = ({ oc, raw, batchBias, act }: Pick<ConvOptions, 'oc' | 'raw' | 'batchBias' | 'act'>): string => {
    const m = (i: number, j: number) => `m${i}${j}`;
    const r = (i: number, j: number) => `r${i}${j}`;

    return /* wgsl */ `
${PARAMS}
@group(0) @binding(1) var<storage, read> products: array<vec4f>;
@group(0) @binding(3) var<storage, read> bias: array<vec4f>;
@group(0) @binding(4) var<storage, read> scale: array<vec4f>;
@group(0) @binding(5) var<storage, read> shift: array<vec4f>;
@group(0) @binding(6) var<storage, read_write> out: array<vec4f>;
${raw !== 'none' ? '@group(0) @binding(7) var<storage, read_write> raw: array<vec4f>;' : ''}
${batchBias ? '@group(0) @binding(8) var<storage, read> batchBias: array<vec4f>;' : ''}
const OC4 = ${oc / 4}u;
${activation(act, 'vec4f')}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3u) {
    let o = id.x % OC4;
    let t = id.x / OC4;
    if (t >= p.tiles) {
        return;
    }
    ${tileIndex}
    ${range(4).flatMap(i => range(4).map(j => `let ${m(i, j)} = products[(${i * 4 + j}u * p.tiles + t) * OC4 + o];`)).join('\n    ')}
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
            let index = ((n * p.h + y) * p.w + x) * OC4 + o;
            var v = ys[i] + bias[o];
            ${batchBias ? 'v += batchBias[n * OC4 + o];' : ''}
            ${raw === 'add' ? 'v += raw[index];' : ''}
            ${raw !== 'none' ? 'raw[index] = v;' : ''}
            out[index] = act(v * scale[o] + shift[o]);
        }
    }
}`;
};

/**
 * U = G g Gᵀ of [3, 3, ic, oc] weights, to [16, ic, oc].
 */
export const winogradFilter = (w: Float32Array, ic: number, oc: number): Float32Array => {
    const G = [[1, 0, 0], [0.5, 0.5, 0.5], [0.5, -0.5, 0.5], [0, 0, 1]];
    const u = new Float32Array(16 * ic * oc);

    for (let a = 0; a < 4; ++a) {
        for (let b = 0; b < 4; ++b) {
            for (let y = 0; y < 3; ++y) {
                for (let x = 0; x < 3; ++x) {
                    const factor = G[a][y] * G[b][x];

                    if (factor === 0) {
                        continue;
                    }

                    const from = (y * 3 + x) * ic * oc;
                    const to = (a * 4 + b) * ic * oc;

                    for (let k = 0; k < ic * oc; ++k) {
                        u[to + k] += factor * w[from + k];
                    }
                }
            }
        }
    }

    return u;
};
