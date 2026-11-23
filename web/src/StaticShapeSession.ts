import * as ort from 'onnxruntime-web/webgpu';
import { MAX_CELLS_PER_RUN } from '../../mcts/Evaluator';

/**
 * Model runs with fixed shapes: WebGPU kernels specialized for shape are ~20% faster
 * (web/experiments.html). One session per board size, batches split and padded to batchSize.
 */
export default class StaticShapeSession
{
    /**
     * By board size, least recently used first. Each one holds weights on GPU.
     */
    private sessions = new Map<number, Promise<ort.InferenceSession>>();

    /**
     * Runs one at a time, so that evicted session is never released while running.
     */
    private queue: Promise<unknown> = Promise.resolve();

    constructor(
        private model: Uint8Array,
        private batchSize = 8,
        private maxSessions = 2,
        private executionProviders: ort.InferenceSession.SessionOptions['executionProviders'] = ['webgpu'],
    ) {}

    /**
     * Creates session of a board size now, i.e to check model.
     */
    async load(size: number): Promise<void>
    {
        await this.session(size);
    }

    /**
     * Smaller on big boards, see MAX_CELLS_PER_RUN.
     */
    private batchFor(size: number): number
    {
        return Math.max(1, Math.min(this.batchSize, Math.floor(MAX_CELLS_PER_RUN / (size * size))));
    }

    private session(size: number): Promise<ort.InferenceSession>
    {
        let session = this.sessions.get(size);

        if (session !== undefined) {
            this.sessions.delete(size);
            this.sessions.set(size, session);

            return session;
        }

        session = ort.InferenceSession.create(this.model, {
            executionProviders: this.executionProviders,
            graphOptimizationLevel: 'all',
            freeDimensionOverrides: { N: this.batchFor(size), H: size, W: size },
        });

        // Try again on next run
        session.catch(() => this.sessions.delete(size));

        this.sessions.set(size, session);

        for (const [evictedSize, evicted] of this.sessions) {
            if (this.sessions.size <= this.maxSessions) {
                break;
            }

            this.sessions.delete(evictedSize);
            void evicted.then(s => s.release()).catch(() => undefined);
        }

        return session;
    }

    run(feeds: { spatial: ort.Tensor, global: ort.Tensor }): Promise<{ policy: ort.Tensor, value: ort.Tensor }>
    {
        const result = this.queue.then(() => this.runNow(feeds));

        this.queue = result.catch(() => undefined);

        return result;
    }

    private async runNow({ spatial, global }: { spatial: ort.Tensor, global: ort.Tensor }): Promise<{ policy: ort.Tensor, value: ort.Tensor }>
    {
        const [n, channels, size] = spatial.dims;
        const globalChannels = global.dims[1];
        const policyStride = size * size + 1;
        const session = await this.session(size);
        const spatialData = spatial.data as Float32Array;
        const globalData = global.data as Float32Array;
        const policy = new Float32Array(n * policyStride);
        const value = new Float32Array(n * 3);
        const b = this.batchFor(size);

        for (let start = 0; start < n; start += b) {
            const count = Math.min(b, n - start);

            // Padding positions are zeros, outputs ignored
            const spatialBatch = new Float32Array(b * channels * size * size);
            const globalBatch = new Float32Array(b * globalChannels);
            spatialBatch.set(spatialData.subarray(start * channels * size * size, (start + count) * channels * size * size));
            globalBatch.set(globalData.subarray(start * globalChannels, (start + count) * globalChannels));

            const outputs = await session.run({
                spatial: new ort.Tensor('float32', spatialBatch, [b, channels, size, size]),
                global: new ort.Tensor('float32', globalBatch, [b, globalChannels]),
            });

            policy.set((outputs.policy.data as Float32Array).subarray(0, count * policyStride), start * policyStride);
            value.set((outputs.value.data as Float32Array).subarray(0, count * 3), start * 3);
        }

        return {
            policy: new ort.Tensor('float32', policy, [n, policyStride]),
            value: new ort.Tensor('float32', value, [n, 3]),
        };
    }

    async release(): Promise<void>
    {
        const sessions = [...this.sessions.values()];

        this.sessions.clear();
        await Promise.all(sessions.map(session => session.then(s => s.release()).catch(() => undefined)));
    }
}
