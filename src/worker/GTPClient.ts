import { ChildProcessWithoutNullStreams, spawn } from 'child_process';
import PQueue from 'p-queue';
import logger from '../shared/logger';

class GTPClientError extends Error {}

const paramStr = (parameter: string | number | boolean): string => {
    if ('boolean' === typeof parameter) {
        return parameter ? '1' : '0';
    }

    return parameter + '';
}

/**
 * Spawn a process from a given binary,
 * send commands and get result as promise,
 * in the GTP format ("= result")
 *
 * Each instance of this class spawn a process that can use lot of memory.
 */
export default class GTPClient<Command extends string = string>
{
    private process: ChildProcessWithoutNullStreams;

    /**
     * Queue of transactions to run.
     * Allow running a group of commands sequencially.
     */
    private transactionsQueue = new PQueue({ concurrency: 1 });

    /**
     * Contains chunks of data received from stderr during last command.
     * Is reset before running a new command.
     */
    private lastStdErrChunks: string[] = [];

    private hasRunningCommand = false;

    /**
     * @param runCommand Path to binary. I.e "/bin/mohex --seed 1".
     */
    constructor(
        runCommand: string,
    ) {
        const [binary, ...args] = runCommand.split(' ');

        logger.info(`Spawn process from ${binary}...`);

        this.process = spawn(binary, args);

        this.process.stderr.on('data', (data: Buffer) => {
            this.lastStdErrChunks.push(data.toString());
        });
    }

    getLastStdErrChunks(): string[]
    {
        return this.lastStdErrChunks;
    }

    async sendCommand(gtpCommand: Command, ...parameters: (string | number | boolean)[]): Promise<string>
    {
        const command: string = gtpCommand + parameters
            .map(parameter => ` ${paramStr(parameter)}`)
            .join('')
        ;

        if (this.hasRunningCommand) {
            throw new Error('Another command is already running. Please await previous command result.');
        }

        this.hasRunningCommand = true;

        return new Promise<string>((resolve, reject) => {
            let result = '';
            let timeout: null | NodeJS.Timeout = null;

            const parseResult = () => {
                logger.debug(`command result: ${result}`);

                this.hasRunningCommand = false;

                if ('=' === result[0]) {
                    resolve(result.substring(1).trim());
                } else {
                    reject(new GTPClientError(result));
                }
            };

            const readDataListener = (data: Buffer) => {
                result += data.toString();

                if (null !== timeout) {
                    clearTimeout(timeout);
                }

                timeout = setTimeout(() => {
                    if (null !== timeout) {
                        clearTimeout(timeout);
                    }

                    this.process.stdout.off('data', readDataListener);
                    result = result.trim();
                    parseResult();
                }, 20);
            };

            this.process.stdout.on('data', readDataListener);

            logger.debug(`sending command: ${command}`);

            this.lastStdErrChunks = [];
            this.process.stdin.write(command + '\n');
        });
    }

    async transaction<T>(callback: (gtpClient: GTPClient) => Promise<T>): Promise<T>
    {
        return this.transactionsQueue.add(() => callback(this));
    }
}
