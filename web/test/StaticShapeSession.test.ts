import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as ort from 'onnxruntime-web/webgpu';
import { describe, expect, it } from 'vitest';
import StaticShapeSession from '../src/StaticShapeSession';

/*
 * Requires model converted with model-conversion/, else skipped.
 */
const modelPath = fileURLToPath(new URL('../../model-conversion/out/hex27x3.onnx', import.meta.url));

const randomInputs = (n: number, size: number) => {
    const spatial = new Float32Array(n * 22 * size * size).map(() => Math.random() < 0.2 ? 1 : 0);
    const global = new Float32Array(n * 19).map(() => Math.random() < 0.2 ? 1 : 0);

    return {
        spatial: new ort.Tensor('float32', spatial, [n, 22, size, size]),
        global: new ort.Tensor('float32', global, [n, 19]),
    };
};

describe.skipIf(!existsSync(modelPath))('StaticShapeSession', () => {
    it('gives same outputs as dynamic shape session, with split and padded batches', async () => {
        ort.env.wasm.numThreads = 1;
        const model = readFileSync(modelPath);
        const dynamic = await ort.InferenceSession.create(model);

        // Batch of 4: 11 positions are split in 4 + 4 + 3, last one padded
        const session = new StaticShapeSession(model, 4, 1, ['wasm']);

        for (const size of [5, 7, 5]) {
            const feeds = randomInputs(11, size);
            const expected = await dynamic.run(feeds);
            const actual = await session.run(feeds);

            expect(actual.policy.dims).toEqual([11, size * size + 1]);
            expect(actual.value.dims).toEqual([11, 3]);

            for (const output of ['policy', 'value'] as const) {
                const a = actual[output].data as Float32Array;
                const b = expected[output].data as Float32Array;

                expect(Math.max(...a.map((value, i) => Math.abs(value - b[i])))).toBeLessThan(1e-4);
            }
        }

        await session.release();
    });
});
