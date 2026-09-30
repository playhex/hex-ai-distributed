import { AiJobType, AiTask, Engine } from '../shared/protocol';

/**
 * Task cannot be processed by this engine, retrying on another worker won't help.
 */
export class TaskNotSupportedError extends Error {}

/**
 * Job types this worker knows how to process.
 * Other job types (i.e katahex-mcts-analyze-*) are defined in protocol but not yet implemented.
 */
export const IMPLEMENTED_AI_JOB_TYPES: readonly AiJobType[] = [
    'katahex-intuition-move',
    'katahex-mcts-move',
    'katahex-intuition-analyze-position',
    'katahex-intuition-analyze-move',
    'mohex',
    'davies',
];

export type EngineWorker = {
    version: () => Promise<string>;
    process: (task: AiTask) => Promise<unknown>;
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
            const { analyzeMove } = await import('./task/analyze-move');
            const { analyzePosition } = await import('./task/analyze-position');

            return {
                version: () => katahex.version(),
                process: async task => {
                    switch (task.type) {
                        case 'katahex-intuition-move': return await processJobKatahex(task.data, false);
                        case 'katahex-mcts-move': return await processJobKatahex(task.data, true);
                        case 'katahex-intuition-analyze-move': return await analyzeMove(task.data);
                        case 'katahex-intuition-analyze-position': return await analyzePosition(task.data);
                    }

                    return notSupported(engine, task);
                },
            };
        }

        case 'mohex': {
            const { mohex, processJobMohex } = await import('./task/calculate-move/mohex');

            return {
                version: () => mohex.version(),
                process: async task => task.type === 'mohex'
                    ? await processJobMohex(task.data)
                    : notSupported(engine, task)
                ,
            };
        }

        case 'davies': {
            const { processJobDavies, daviesVersion } = await import('./task/calculate-move/davies');

            return {
                version: async () => daviesVersion,
                process: async task => task.type === 'davies'
                    ? processJobDavies(task.data)
                    : notSupported(engine, task)
                ,
            };
        }
    }
};
