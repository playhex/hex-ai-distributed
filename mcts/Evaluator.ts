import HexBoard, { Player } from './HexBoard';
import { fillInputs, NUM_GLOBAL_FEATURES, NUM_SPATIAL_FEATURES, Symmetry, toNetworkIndex } from './features';

export type EvaluationRequest = {
    board: HexBoard;
    player: Player;

    /**
     * Cells policy is computed for, see HexBoard.legalMoves().
     */
    moves: number[];
};

export type Evaluation = {
    /**
     * Probability of each move of request, same order.
     */
    policy: Float32Array;

    /**
     * Win probability of player to play.
     */
    win: number;

    /**
     * Win minus loss probability of player to play, in [-1, 1].
     */
    utility: number;
};

export interface Evaluator
{
    evaluate(requests: EvaluationRequest[]): Promise<Evaluation[]>;
}

/*
 * Minimal onnxruntime types, so this module works with onnxruntime-web or onnxruntime-node.
 */
export type OrtTensor = { data: unknown, dims: readonly number[] };
export type OrtTensorConstructor = new (type: 'float32', data: Float32Array, dims: number[]) => OrtTensor;
export type OrtSession = {
    run(feeds: { [name: string]: OrtTensor }): Promise<{ [name: string]: OrtTensor }>;
};

/**
 * katahex/config.cfg nnPolicyTemperature, "slightly broader".
 */
export const NN_POLICY_TEMPERATURE = 1.1;

/**
 * Max positions × board cells per model run. Bigger runs need GPU buffers
 * over WebGPU limits (128MB by default), which breaks the session.
 */
export const MAX_CELLS_PER_RUN = 8192;

/**
 * Evaluates positions with the onnx model from model-conversion/.
 * Same postprocessing as katahex nneval.cpp.
 */
export class OnnxEvaluator implements Evaluator
{
    constructor(
        private session: OrtSession,
        private Tensor: OrtTensorConstructor,
        private policyTemperature = NN_POLICY_TEMPERATURE,
        private random: () => number = Math.random,
    ) {}

    async evaluate(requests: EvaluationRequest[]): Promise<Evaluation[]>
    {
        if (requests.length === 0) {
            return [];
        }

        const batchSize = Math.max(1, Math.floor(MAX_CELLS_PER_RUN / requests[0].board.size ** 2));
        const evaluations: Evaluation[] = [];

        for (let i = 0; i < requests.length; i += batchSize) {
            evaluations.push(...await this.run(requests.slice(i, i + batchSize)));
        }

        return evaluations;
    }

    private async run(requests: EvaluationRequest[]): Promise<Evaluation[]>
    {
        const size = requests[0].board.size;
        const area = size * size;
        const n = requests.length;

        if (requests.some(request => request.board.size !== size)) {
            throw new Error('All positions of a batch must have same board size');
        }

        const spatial = new Float32Array(n * NUM_SPATIAL_FEATURES * area);
        const global = new Float32Array(n * NUM_GLOBAL_FEATURES);

        // Random symmetry for each evaluation, like katahex
        const symmetries: Symmetry[] = requests.map(() => this.random() < 0.5 ? 0 : 1);

        requests.forEach(({ board, player }, i) => {
            fillInputs(board, player, symmetries[i], spatial, i * NUM_SPATIAL_FEATURES * area, global, i * NUM_GLOBAL_FEATURES);
        });

        const outputs = await this.session.run({
            spatial: new this.Tensor('float32', spatial, [n, NUM_SPATIAL_FEATURES, size, size]),
            global: new this.Tensor('float32', global, [n, NUM_GLOBAL_FEATURES]),
        });

        const policyLogits = outputs.policy.data as Float32Array;
        const valueLogits = outputs.value.data as Float32Array;
        const policyStride = area + 1;

        return requests.map(({ moves, player }, i) => {
            const policy = new Float32Array(moves.length);
            let max = -Infinity;

            for (let m = 0; m < moves.length; ++m) {
                const logit = policyLogits[i * policyStride + toNetworkIndex(moves[m], size, player, symmetries[i])] / this.policyTemperature;
                policy[m] = logit;
                max = Math.max(max, logit);
            }

            let sum = 0;

            for (let m = 0; m < moves.length; ++m) {
                policy[m] = Math.exp(policy[m] - max);
                sum += policy[m];
            }

            for (let m = 0; m < moves.length; ++m) {
                policy[m] = sum > 0 ? policy[m] / sum : 1 / moves.length;
            }

            const [winLogit, lossLogit, noResultLogit] = [valueLogits[i * 3], valueLogits[i * 3 + 1], valueLogits[i * 3 + 2]];
            const maxValue = Math.max(winLogit, lossLogit, noResultLogit);
            const win = Math.exp(winLogit - maxValue);
            const loss = Math.exp(lossLogit - maxValue);
            const noResult = Math.exp(noResultLogit - maxValue);
            const total = win + loss + noResult;

            return {
                policy,
                win: win / total,
                utility: (win - loss) / total,
            };
        });
    }
}

/**
 * Keeps evaluations of last positions, by position hash.
 * Kept between searches, i.e when analyzing a move then position after it.
 */
export class CachedEvaluator implements Evaluator
{
    private cache = new Map<string, Evaluation>();

    /**
     * Positions found in cache, or evaluated, for benchmark.
     */
    hits = 0;
    misses = 0;

    constructor(
        private evaluator: Evaluator,
        private maxSize = 5000,
    ) {}

    private key({ board, player }: EvaluationRequest): string
    {
        return `${board.size}:${board.hash(player)}`;
    }

    async evaluate(requests: EvaluationRequest[]): Promise<Evaluation[]>
    {
        const results: (undefined | Evaluation)[] = requests.map(request => this.cache.get(this.key(request)));
        const missing = requests.filter((_, i) => results[i] === undefined);
        this.hits += requests.length - missing.length;
        this.misses += missing.length;
        const evaluated = await this.evaluator.evaluate(missing);

        let next = 0;

        return requests.map((request, i) => {
            const cached = results[i];

            if (cached !== undefined) {
                // Map keeps insertion order: move to end, oldest are removed first
                const key = this.key(request);
                this.cache.delete(key);
                this.cache.set(key, cached);

                return cached;
            }

            const evaluation = evaluated[next++];

            this.cache.set(this.key(request), evaluation);

            if (this.cache.size > this.maxSize) {
                this.cache.delete(this.cache.keys().next().value!);
            }

            return evaluation;
        });
    }

    clear(): void
    {
        this.cache.clear();
    }
}
