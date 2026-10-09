import { AiJobType, AiTask, Engine } from '../shared/protocol';

/**
 * Task cannot be processed by this engine, retrying on another worker won't help.
 */
export class TaskNotSupportedError extends Error {}

/**
 * Job types this worker knows how to process.
 */
export const IMPLEMENTED_AI_JOB_TYPES: readonly AiJobType[] = [
    'katahex-intuition-move',
    'katahex-mcts-move',
    'katahex-intuition-analyze-position',
    'katahex-mcts-analyze-position',
    'katahex-intuition-analyze-game',
    'katahex-mcts-analyze-move',
    'mohex',
    'mohex-solve-position',
    'davies',
];

export type EngineWorker = {
    version: () => Promise<string>;
    process: (task: AiTask) => Promise<unknown>;

    /**
     * Job types this worker cannot process with its engine build,
     * i.e katahex build without kata-raw-nn-batch command cannot analyze games.
     */
    unavailableJobTypes: AiJobType[];
};

const notSupported = (engine: Engine, task: AiTask): never => {
    throw new TaskNotSupportedError(`Engine ${engine} does not support job type "${task.type}"`);
};

/**
 * Loads only the engine this worker runs,
 * other engines binaries are not required.
 */
export const loadEngineWorker = async (engine: Engine): Promise<EngineWorker> => {
    switch (engine) {
        case 'katahex': {
            const { katahex, processJobKatahex } = await import('./task/calculate-move/katahex');
            const { analyzeGame } = await import('./task/analyze-game');
            const { analyzePosition } = await import('./task/analyze-position');
            const { processJobKatahexMcts } = await import('./task/mcts/mcts-move');
            const { analyzeMoveMcts } = await import('./task/mcts/mcts-analyze-move');
            const { analyzePositionMcts } = await import('./task/mcts/mcts-analyze-position');

            const unavailableJobTypes: AiJobType[] = await katahex.supportsCommand('kata-raw-nn-batch')
                ? []
                : ['katahex-intuition-analyze-game']
            ;

            return {
                version: () => katahex.version(),
                unavailableJobTypes,
                process: async task => {
                    switch (task.type) {
                        case 'katahex-intuition-move': return await processJobKatahex(task.data);
                        case 'katahex-mcts-move': return await processJobKatahexMcts(task.data);
                        case 'katahex-intuition-analyze-game': return await analyzeGame(task.data);
                        case 'katahex-mcts-analyze-move': return await analyzeMoveMcts(task.data);
                        case 'katahex-intuition-analyze-position': return await analyzePosition(task.data);
                        case 'katahex-mcts-analyze-position': return await analyzePositionMcts(task.data);
                    }

                    return notSupported(engine, task);
                },
            };
        }

        case 'mohex': {
            const { mohex, processJobMohex } = await import('./task/calculate-move/mohex');
            const { processJobSolvePosition } = await import('./task/solve-position');

            return {
                version: () => mohex.version(),
                unavailableJobTypes: [],
                process: async task => {
                    switch (task.type) {
                        case 'mohex': return await processJobMohex(task.data);
                        case 'mohex-solve-position': return await processJobSolvePosition(task.data);
                    }

                    return notSupported(engine, task);
                },
            };
        }

        case 'davies': {
            const { processJobDavies, daviesVersion } = await import('./task/calculate-move/davies');

            return {
                version: async () => daviesVersion,
                unavailableJobTypes: [],
                process: async task => task.type === 'davies'
                    ? processJobDavies(task.data)
                    : notSupported(engine, task)
                ,
            };
        }
    }
};
