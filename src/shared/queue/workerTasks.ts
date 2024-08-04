import { Queue, QueueEvents, Worker } from 'bullmq';
import connection from '../connection';
import { WorkerInput, WorkerOutput } from '../model/WorkerTask';

export const WORKER_TASKS_QUEUE_NAME = 'worker_tasks';


export const workerTasksQueue = new Queue<WorkerInput, WorkerOutput>(WORKER_TASKS_QUEUE_NAME, {
    connection,
    defaultJobOptions: {
        attempts: 10,
        removeOnComplete: {
            age: 24 * 3600,
            count: 1000,
        },
        removeOnFail: {
            age: 24 * 3600,
            count: 1000,
        },
    },
});

export const workerTasksQueueEvents = new QueueEvents(WORKER_TASKS_QUEUE_NAME, {
    connection,
});

export const createWorkerTasksWorker = () => new Worker<WorkerInput, WorkerOutput>(
    WORKER_TASKS_QUEUE_NAME,
    null,
    {
        connection,
        maxStalledCount: 3,

        // Following values are tripled because katahex take more time
        stalledInterval: 30_000,
        lockDuration: 60_000,
    },
);

export const addWorkerTaskToQueue = async (workerInput: WorkerInput) => {
    const job = await workerTasksQueue.add(workerInput.type, workerInput);

    return await job.waitUntilFinished(workerTasksQueueEvents);
};
