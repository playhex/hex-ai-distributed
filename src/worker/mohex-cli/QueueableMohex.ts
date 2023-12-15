import Mohex from './Mohex';

type MohexCommand<Result> = (mohex: Mohex) => Promise<Result>;

type Task<Result> = {
    command: MohexCommand<Result>,
    resolve: (value: Result) => void,
    reject: (reason?: unknown) => void,
};

/**
 * Run commands to Mohex sequentially.
 */
export default class QueueableMohex
{
    private tasks: Task<unknown>[] = [];
    private running = false;

    constructor(
        private mohex: Mohex,
    ) {}

    private start(): void
    {
        if (this.running) {
            return;
        }

        this.running = true;

        this.executeNextTask();
    }

    private async executeNextTask(): Promise<void>
    {
        const task = this.tasks.shift();

        if (!task) {
            this.running = false;
            return;
        }

        try {
            task.resolve(await task.command(this.mohex));
        } catch (e) {
            task.reject(e);
        }

        this.executeNextTask();
    }

    async queueCommand<Result>(command: MohexCommand<Result>): Promise<Result>
    {
        const promise = new Promise<Result>((resolve, reject) => {
            const task: Task<Result> = {
                command,
                resolve,
                reject,
            };

            this.tasks.push(task as Task<unknown>);
        });

        this.start();

        return promise;
    }
}
