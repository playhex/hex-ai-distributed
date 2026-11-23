import HexBoard, { opponent, Player } from './HexBoard';
import { Evaluator } from './Evaluator';

/*
 * Tree search (PUCT), close to katahex search with hex-ai-distributed katahex/config.cfg.
 * Not implemented: graph search, noise pruning, LCB move selection, subtree value bias.
 */

export type SearchParams = {
    cpuctExploration: number;
    cpuctExplorationLog: number;
    cpuctExplorationBase: number;
    cpuctUtilityStdevPrior: number;
    cpuctUtilityStdevPriorWeight: number;
    cpuctUtilityStdevScale: number;
    fpuReductionMax: number;
    rootFpuReductionMax: number;

    /**
     * Leaves evaluated together by neural network, with virtual losses.
     * Like katahex numSearchThreads.
     */
    batchSize: number;

    /**
     * Batches evaluated at same time: GPU computes one while CPU selects leaves of next one.
     */
    pipelinedBatches: number;
};

/**
 * From katahex/config.cfg, and katahex gtp defaults (program/setup.cpp) for others.
 */
export const DEFAULT_SEARCH_PARAMS: SearchParams = {
    cpuctExploration: 0.9,
    cpuctExplorationLog: 0.6,
    cpuctExplorationBase: 500,
    cpuctUtilityStdevPrior: 0.40,
    cpuctUtilityStdevPriorWeight: 2.0,
    cpuctUtilityStdevScale: 0.85,
    fpuReductionMax: 0.2,
    rootFpuReductionMax: 0.1,
    batchSize: 8,
    pipelinedBatches: 2,
};

class Node
{
    /**
     * Legal moves, null until evaluated.
     */
    moves: null | number[] = null;
    priors: Float32Array = new Float32Array(0);
    children: (undefined | Node)[] = [];

    visits = 0;

    /**
     * Sums of utilities, from perspective of player to play at this node.
     */
    utilitySum = 0;
    utilitySqSum = 0;

    /**
     * Pending playouts through this node, counted as losses for player who moved here.
     */
    virtualLosses = 0;

    /**
     * Set when player who moved here won, utility from perspective of player to play here.
     */
    terminalUtility: null | number = null;

    sumChildVisits(): number
    {
        let sum = 0;

        for (const child of this.children) {
            if (child !== undefined) {
                sum += child.visits + child.virtualLosses;
            }
        }

        return sum;
    }
}

export type SearchedMove = {
    /**
     * Cell index.
     */
    move: number;
    visits: number;

    /**
     * Win rate of root player after this move.
     */
    winrate: number;

    /**
     * Neural network policy of this move.
     */
    prior: number;

    /**
     * Principal variation, starting with this move.
     */
    pv: number[];
};

export type SearchResult = {
    /**
     * Root children searched at least once, most visited first.
     */
    moves: SearchedMove[];

    /**
     * Win rate of root player, from root node value.
     */
    winrate: number;

    playouts: number;
};

export type SearchOptions = {
    maxPlayouts: number;
    signal?: AbortSignal;

    /**
     * Called after each batch.
     */
    onProgress?: (playouts: number) => void;
};

type Leaf = {
    path: Node[];
    board: HexBoard;
    player: Player;
};

const toWinrate = (utility: number): number => (utility + 1) / 2;

/**
 * Tree search from a position, player to play.
 */
export class Search
{
    private root = new Node();

    constructor(
        private evaluator: Evaluator,
        private board: HexBoard,
        private player: Player,
        private params: SearchParams = DEFAULT_SEARCH_PARAMS,
    ) {}

    async run({ maxPlayouts, signal, onProgress }: SearchOptions): Promise<SearchResult>
    {
        const { root } = this;
        let playouts = 0;
        let done = 0;

        if (root.moves === null) {
            await this.evaluateAndBackup([{ path: [root], board: this.board, player: this.player }]);
        }

        // Leaves being evaluated, by all batches in flight
        const pending = new Set<Node>();
        const inFlight: Promise<void>[] = [];

        try {
            while (playouts < maxPlayouts && (root.moves?.length ?? 0) > 0) {
                signal?.throwIfAborted();

                const { leaves, terminals } = this.selectLeaves(Math.min(this.params.batchSize, maxPlayouts - playouts), pending);

                playouts += leaves.length + terminals;

                if (terminals > 0) {
                    done += terminals;
                    onProgress?.(done);
                }

                if (leaves.length > 0) {
                    inFlight.push(this.evaluateAndBackup(leaves).then(() => {
                        leaves.forEach(leaf => pending.delete(leaf.path[leaf.path.length - 1]));
                        done += leaves.length;
                        onProgress?.(done);
                    }));
                }

                // Also when all selected leaves are being evaluated by previous batch
                if (inFlight.length >= this.params.pipelinedBatches || (leaves.length === 0 && inFlight.length > 0)) {
                    await inFlight.shift();
                }
            }

            await Promise.all(inFlight);
        } finally {
            // On error or abort: no backup running after search ended
            await Promise.allSettled(inFlight);
        }

        return this.result(playouts);
    }

    /**
     * Selects leaves to evaluate, applying virtual losses so that each one is different.
     * Terminal leaves are backed up directly, and counted as playouts like katahex:
     * else search would never end once a win is found.
     */
    private selectLeaves(count: number, pending: Set<Node>): { leaves: Leaf[], terminals: number }
    {
        const leaves: Leaf[] = [];
        let terminals = 0;

        for (let i = 0; i < count; ++i) {
            const leaf = this.descend();

            if (leaf.path[leaf.path.length - 1].terminalUtility !== null) {
                this.backup(leaf.path, leaf.path[leaf.path.length - 1].terminalUtility!);
                ++terminals;
                continue;
            }

            const node = leaf.path[leaf.path.length - 1];

            // Collision with a leaf being evaluated: evaluate what we already have
            if (pending.has(node)) {
                this.removeVirtualLosses(leaf.path);
                break;
            }

            pending.add(node);
            leaves.push(leaf);
        }

        return { leaves, terminals };
    }

    private descend(): Leaf
    {
        const board = this.board.clone();
        let player = this.player;
        let node = this.root;
        const path = [node];

        while (node.moves !== null && node.terminalUtility === null && node.moves.length > 0) {
            const i = this.selectChild(node, node === this.root);
            const move = node.moves[i];

            board.play(move, player);

            let child = node.children[i];

            if (child === undefined) {
                child = new Node();

                // Same as katahex: player wins as soon as connected, bridges and edge templates included
                if (board.isConnected(player)) {
                    child.terminalUtility = -1;
                }

                node.children[i] = child;
            }

            child.virtualLosses++;
            path.push(child);
            node = child;
            player = opponent(player);
        }

        return { path, board, player };
    }

    private selectChild(node: Node, isRoot: boolean): number
    {
        const p = this.params;
        const moves = node.moves!;
        const totalChildWeight = node.sumChildVisits();

        const cpuct = p.cpuctExploration + p.cpuctExplorationLog * Math.log((totalChildWeight + p.cpuctExplorationBase) / p.cpuctExplorationBase);

        const weight = node.visits;
        const average = weight > 0 ? node.utilitySum / weight : 0;
        const variancePrior = p.cpuctUtilityStdevPrior * p.cpuctUtilityStdevPrior;
        const stdev = weight <= 1
            ? p.cpuctUtilityStdevPrior
            : Math.sqrt(Math.max(0, ((node.utilitySqSum / weight - average * average) * weight + variancePrior * p.cpuctUtilityStdevPriorWeight) / (weight + p.cpuctUtilityStdevPriorWeight - 1)));
        const stdevFactor = 1 + p.cpuctUtilityStdevScale * (stdev / p.cpuctUtilityStdevPrior - 1);

        const exploreScaling = cpuct * Math.sqrt(totalChildWeight + 0.01) * stdevFactor;

        let policyMassVisited = 0;

        for (let i = 0; i < moves.length; ++i) {
            const child = node.children[i];

            if (child !== undefined && child.visits + child.virtualLosses > 0) {
                policyMassVisited += node.priors[i];
            }
        }

        const fpuValue = average - (isRoot ? p.rootFpuReductionMax : p.fpuReductionMax) * Math.sqrt(policyMassVisited);

        let best = 0;
        let bestScore = -Infinity;

        for (let i = 0; i < moves.length; ++i) {
            const child = node.children[i];
            const childWeight = child === undefined ? 0 : child.visits + child.virtualLosses;

            // Child utility is from opponent perspective, virtual losses are losses for player to play here
            const q = childWeight === 0
                ? fpuValue
                : -(child!.utilitySum + child!.virtualLosses) / childWeight;

            const score = q + exploreScaling * node.priors[i] / (1 + childWeight);

            if (score > bestScore) {
                bestScore = score;
                best = i;
            }
        }

        return best;
    }

    private async evaluateAndBackup(leaves: Leaf[]): Promise<void>
    {
        const toEvaluate = leaves.map(({ board, player }) => ({ board, player, moves: board.legalMoves() }));
        const evaluations = await this.evaluator.evaluate(toEvaluate);

        leaves.forEach((leaf, i) => {
            const node = leaf.path[leaf.path.length - 1];

            if (node.moves === null) {
                node.moves = toEvaluate[i].moves;
                node.priors = evaluations[i].policy;
                node.children = new Array(node.moves.length);
            }

            this.removeVirtualLosses(leaf.path);
            this.backup(leaf.path, evaluations[i].utility);
        });
    }

    private removeVirtualLosses(path: Node[]): void
    {
        for (let i = 1; i < path.length; ++i) {
            path[i].virtualLosses--;
        }
    }

    /**
     * @param utility From perspective of player to play at leaf.
     */
    private backup(path: Node[], utility: number): void
    {
        if (path[path.length - 1].terminalUtility !== null) {
            this.removeVirtualLosses(path);
        }

        for (let i = path.length - 1; i >= 0; --i) {
            const node = path[i];

            node.visits++;
            node.utilitySum += utility;
            node.utilitySqSum += utility * utility;
            utility = -utility;
        }
    }

    private principalVariation(node: Node, firstMove: number): number[]
    {
        const pv = [firstMove];

        while (node.moves !== null && node.children.length > 0) {
            let best = -1;

            for (let i = 0; i < node.children.length; ++i) {
                if ((node.children[i]?.visits ?? 0) > (best < 0 ? 0 : node.children[best]!.visits)) {
                    best = i;
                }
            }

            if (best < 0) {
                break;
            }

            pv.push(node.moves[best]);
            node = node.children[best]!;
        }

        return pv;
    }

    private result(playouts: number): SearchResult
    {
        const { root } = this;
        const moves: SearchedMove[] = [];

        (root.moves ?? []).forEach((move, i) => {
            const child = root.children[i];

            if (child === undefined || child.visits === 0) {
                return;
            }

            moves.push({
                move,
                visits: child.visits,
                winrate: toWinrate(-child.utilitySum / child.visits),
                prior: root.priors[i],
                pv: this.principalVariation(child, move),
            });
        });

        moves.sort((a, b) => b.visits - a.visits || b.prior - a.prior);

        return {
            moves,
            winrate: toWinrate(root.visits > 0 ? root.utilitySum / root.visits : 0),
            playouts,
        };
    }
}
