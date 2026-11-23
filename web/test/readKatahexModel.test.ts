import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { gunzip, readKatahexModel } from '../src/network/readKatahexModel';

/*
 * Requires katahex model downloaded in katahex/, else skipped.
 */
const modelPath = fileURLToPath(new URL('../../katahex/katahex_model_20220618.bin.gz', import.meta.url));

describe.skipIf(!existsSync(modelPath))('readKatahexModel', () => {
    it('reads whole model file', async () => {
        const model = readKatahexModel(await gunzip(readFileSync(modelPath)));
        const { initialConv, initialMatMul, blocks, tipBN } = model.trunk;

        expect(model.numSpatial).toBe(22);
        expect(model.numGlobal).toBe(19);
        expect(initialConv.ic).toBe(22);
        expect(initialConv.w.length).toBe(initialConv.ky * initialConv.kx * initialConv.ic * initialConv.oc);
        expect(initialMatMul.oc).toBe(initialConv.oc);
        expect(blocks.length).toBeGreaterThan(0);
        expect(tipBN.scale.length).toBe(initialConv.oc);
        expect(model.policy.p2Conv.oc).toBe(1);
        expect(model.value.v3Mul.oc).toBe(3);
    });
});
