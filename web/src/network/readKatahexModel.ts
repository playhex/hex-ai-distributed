/*
 * Katahex model file (.bin, model version <= 11), same as model-conversion/bin_to_onnx.py read_model().
 * Weights kept in file order: conv [ky, kx, ic, oc], matmul [ic, oc].
 */

export type Activation = 'ACTIVATION_IDENTITY' | 'ACTIVATION_RELU' | 'ACTIVATION_MISH';

export type Conv = { name: string, ky: number, kx: number, ic: number, oc: number, dilation: [number, number], w: Float32Array };

/**
 * Batch norm merged as x * scale + bias.
 */
export type BatchNorm = { name: string, scale: Float32Array, bias: Float32Array };

export type MatMul = { ic: number, oc: number, w: Float32Array };

export type Block =
    | { kind: 'ordinary_block', preBN: BatchNorm, preAct: Activation, regularConv: Conv, midBN: BatchNorm, midAct: Activation, finalConv: Conv }
    | {
        kind: 'gpool_block', preBN: BatchNorm, preAct: Activation, regularConv: Conv,
        gpoolConv: Conv, gpoolBN: BatchNorm, gpoolAct: Activation, gpoolToBiasMul: MatMul,
        midBN: BatchNorm, midAct: Activation, finalConv: Conv,
    }
    | {
        kind: 'nested_bottleneck_block', preBN: BatchNorm, preAct: Activation, preConv: Conv,
        blocks: Block[], postBN: BatchNorm, postAct: Activation, postConv: Conv,
    };

export type KatahexModel = {
    name: string,
    version: number,
    numSpatial: number,
    numGlobal: number,
    trunk: { initialConv: Conv, initialMatMul: MatMul, blocks: Block[], tipBN: BatchNorm, tipAct: Activation },
    policy: {
        p1Conv: Conv, g1Conv: Conv, g1BN: BatchNorm, g1Act: Activation, gpoolToBiasMul: MatMul,
        p1BN: BatchNorm, p1Act: Activation, p2Conv: Conv, gpoolToPassMul: MatMul,
    },
    value: {
        v1Conv: Conv, v1BN: BatchNorm, v1Act: Activation, v2Mul: MatMul, v2Bias: Float32Array, v2Act: Activation,
        v3Mul: MatMul, v3Bias: Float32Array,
    },
};

const SPACE = new Set([0x20, 0x09, 0x0d, 0x0a]);
const BIN = [0x40, 0x42, 0x49, 0x4e, 0x40]; // @BIN@

class Reader
{
    private pos = 0;

    constructor(private data: Uint8Array) {}

    token(): string
    {
        while (SPACE.has(this.data[this.pos])) {
            ++this.pos;
        }

        const start = this.pos;

        while (this.pos < this.data.length && !SPACE.has(this.data[this.pos])) {
            ++this.pos;
        }

        return new TextDecoder().decode(this.data.subarray(start, this.pos));
    }

    int(): number
    {
        return parseInt(this.token(), 10);
    }

    float(): number
    {
        return parseFloat(this.token());
    }

    bool(): boolean
    {
        return this.int() !== 0;
    }

    floats(n: number, name: string): Float32Array
    {
        const at = this.data.indexOf(0x40, this.pos);

        if (at < 0 || at - this.pos > 100 || BIN.some((byte, i) => this.data[at + i] !== byte)) {
            throw new Error(`${name}: expected binary float block`);
        }

        const start = at + BIN.length;
        this.pos = start + 4 * n;

        // Copy: binary blocks are not 4 bytes aligned
        const values = new Float32Array(this.data.slice(start, this.pos).buffer);

        if (values.length !== n || values.some(v => !Number.isFinite(v))) {
            throw new Error(`${name}: truncated or non finite weights`);
        }

        return values;
    }

    rest(): Uint8Array
    {
        return this.data.subarray(this.pos);
    }
}

const readConv = (r: Reader): Conv => {
    const name = r.token();
    const [ky, kx, ic, oc, dy, dx] = [r.int(), r.int(), r.int(), r.int(), r.int(), r.int()];

    return { name, ky, kx, ic, oc, dilation: [dy, dx], w: r.floats(ky * kx * ic * oc, name) };
};

const readBN = (r: Reader): BatchNorm => {
    const name = r.token();
    const c = r.int();
    const eps = r.float();
    const hasScale = r.bool();
    const hasBias = r.bool();
    const mean = r.floats(c, name);
    const variance = r.floats(c, name);
    const scale = hasScale ? r.floats(c, name) : new Float32Array(c).fill(1);

    // Same as katahex: missing bias defaults to 1
    const bias = hasBias ? r.floats(c, name) : new Float32Array(c).fill(1);
    const mergedScale = scale.map((s, i) => s / Math.sqrt(variance[i] + eps));

    return { name, scale: mergedScale, bias: bias.map((b, i) => b - mergedScale[i] * mean[i]) };
};

const readAct = (r: Reader, version: number): Activation => {
    r.token(); // name

    return version >= 11 ? r.token() as Activation : 'ACTIVATION_RELU';
};

const readMatMul = (r: Reader): MatMul => {
    const name = r.token();
    const ic = r.int(), oc = r.int();

    return { ic, oc, w: r.floats(ic * oc, name) };
};

const readMatBias = (r: Reader): Float32Array => {
    const name = r.token();

    return r.floats(r.int(), name);
};

const readBlocks = (r: Reader, version: number, count: number): Block[] => {
    const blocks: Block[] = [];

    for (let i = 0; i < count; ++i) {
        const kind = r.token();
        r.token(); // name

        if (kind === 'ordinary_block') {
            blocks.push({
                kind,
                preBN: readBN(r), preAct: readAct(r, version), regularConv: readConv(r),
                midBN: readBN(r), midAct: readAct(r, version), finalConv: readConv(r),
            });
        } else if (kind === 'gpool_block') {
            blocks.push({
                kind,
                preBN: readBN(r), preAct: readAct(r, version), regularConv: readConv(r),
                gpoolConv: readConv(r), gpoolBN: readBN(r), gpoolAct: readAct(r, version), gpoolToBiasMul: readMatMul(r),
                midBN: readBN(r), midAct: readAct(r, version), finalConv: readConv(r),
            });
        } else if (kind === 'nested_bottleneck_block') {
            const n = r.int();
            const preBN = readBN(r), preAct = readAct(r, version), preConv = readConv(r);
            const inner = readBlocks(r, version, n);

            blocks.push({ kind, preBN, preAct, preConv, blocks: inner, postBN: readBN(r), postAct: readAct(r, version), postConv: readConv(r) });
        } else {
            throw new Error(`Unknown block kind ${kind}`);
        }
    }

    return blocks;
};

/**
 * @param data Uncompressed .bin file
 */
export const readKatahexModel = (data: Uint8Array): KatahexModel => {
    const r = new Reader(data);
    const name = r.token();
    const version = r.int();

    if (!(version <= 11)) {
        throw new Error(`Model version ${version} not supported`);
    }

    const numSpatial = r.int();
    const numGlobal = r.int();

    r.token(); // trunk name
    const numBlocks = r.int();

    for (let i = 0; i < 5; ++i) {
        r.int(); // trunk, mid, regular, dilated, gpool channels
    }

    const trunk = {
        initialConv: readConv(r),
        initialMatMul: readMatMul(r),
        blocks: readBlocks(r, version, numBlocks),
        tipBN: readBN(r),
        tipAct: readAct(r, version),
    };

    r.token(); // policy head name
    const policy = {
        p1Conv: readConv(r), g1Conv: readConv(r), g1BN: readBN(r), g1Act: readAct(r, version),
        gpoolToBiasMul: readMatMul(r), p1BN: readBN(r), p1Act: readAct(r, version),
        p2Conv: readConv(r), gpoolToPassMul: readMatMul(r),
    };

    r.token(); // value head name
    const value = {
        v1Conv: readConv(r), v1BN: readBN(r), v1Act: readAct(r, version),
        v2Mul: readMatMul(r), v2Bias: readMatBias(r), v2Act: readAct(r, version),
        v3Mul: readMatMul(r), v3Bias: readMatBias(r),
    };

    // Score value and ownership heads, not used
    readMatMul(r);
    readMatBias(r);
    readConv(r);

    if (r.rest().some(byte => !SPACE.has(byte))) {
        throw new Error('Unexpected data after value head');
    }

    if (policy.p2Conv.oc !== 1) {
        throw new Error('Only models with a single policy output are supported');
    }

    return { name, version, numSpatial, numGlobal, trunk, policy, value };
};

/**
 * Model file is gzipped .bin.
 */
export const gunzip = async (data: Uint8Array): Promise<Uint8Array> =>
    new Uint8Array(await new Response(new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
