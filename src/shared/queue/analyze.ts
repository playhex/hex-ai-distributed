import { FlowProducer, Processor, Queue, QueueEvents, Worker } from 'bullmq';
import connection from '../connection';
import { WORKER_TASKS_QUEUE_NAME } from './workerTasks';
import { AnalyzeGameInput, AnalyzeGameJobInput, AnalyzeGameJobOutput, AnalyzeGameOutput } from '../model/AnalyzeGame';
import { WorkerTaskJobInput } from '../model/WorkerTask';
import { AnalyzeMoveOutput } from '../model/AnalyzeMove';
import { ResultType } from '../model/ResultType';

export const ANALYZES_QUEUE_NAME = 'analyzes';

export const analyzesQueue = new Queue<AnalyzeGameJobInput, AnalyzeGameJobOutput>(ANALYZES_QUEUE_NAME, { connection });
export const analyzesQueueEvents = new QueueEvents(ANALYZES_QUEUE_NAME, { connection });
const analyzesFlow = new FlowProducer({ connection });

/**
 * Merge all move analyzes back to a single list.
 */
export const reconsolidateMoves: Processor<AnalyzeGameJobInput, AnalyzeGameJobOutput> = async (job) => {
    const analyzeMovesOutput = await job.getChildrenValues<ResultType<AnalyzeMoveOutput>>();
    const data: AnalyzeGameOutput = Array(job.data.movesHistory.split(' ').length).fill(null);

    // Reorder all moves analyze to a single array
    for (const jobKey in analyzeMovesOutput) {
        const moveAnalyze = analyzeMovesOutput[jobKey];

        if (!moveAnalyze.success) {
            continue;
        }

        data[moveAnalyze.data.moveIndex] = moveAnalyze.data;
    }

    // Set whiteWin from next position to previous move
    for (let i = 0; i < data.length; ++i) {
        const position = data[i];
        const nextPosition = data[i + 1];

        if (!position || !nextPosition) {
            continue;
        }

        position.move.whiteWin = nextPosition.whiteWin;

        // If move is in best moves list, also set whiteWin here
        for (let j = 0; j < position.bestMoves.length; ++j) {
            if (position.bestMoves[j].move === position.move.move) {
                position.bestMoves[j].whiteWin = nextPosition.whiteWin;
                break;
            }
        }
    }

    return {
        success: true,
        data,
    };
};

export const splitToWorkerTasks = (analyzeGameInput: AnalyzeGameInput): WorkerTaskJobInput[] => {
    const analyzeMoveJobInputs: WorkerTaskJobInput[] = [];
    const currentHistory: string[] = [];
    const moves = analyzeGameInput.movesHistory.split(' ');

    moves
        .forEach((move, moveIndex) => {
            analyzeMoveJobInputs.push({
                type: 'analyze-move',
                data: {
                    color: 0 === (moveIndex % 2) ? 'black' : 'white',
                    move,
                    moveIndex,
                    movesHistory: currentHistory.join(' '),
                    size: analyzeGameInput.size,
                    isLastMoveOfGame: moveIndex === moves.length - 1,
                },
            });

            currentHistory.push(move);
        })
    ;

    return analyzeMoveJobInputs;
};

export const addAnalyzeToQueue = async (analyzeGameInput: AnalyzeGameInput): Promise<AnalyzeGameJobOutput> => {
    const job = await analyzesFlow.add({
        name: 'analyze-game',
        queueName: ANALYZES_QUEUE_NAME,
        data: analyzeGameInput,
        children: splitToWorkerTasks(analyzeGameInput).map(workerTaskJobInput => ({
            name: 'analyze-move',
            queueName: WORKER_TASKS_QUEUE_NAME,
            data: workerTaskJobInput,
            opts: {
                priority: 20,
            },
        })),
    });

    return await job.job.waitUntilFinished(analyzesQueueEvents);
}

export const createAnalyzeWorker = () => new Worker<AnalyzeGameJobInput, AnalyzeGameJobOutput>(
    ANALYZES_QUEUE_NAME,
    reconsolidateMoves,
    {
        connection,
        concurrency: 1,
    },
);
