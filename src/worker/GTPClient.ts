import { ChildProcessWithoutNullStreams, spawn } from 'child_process';
import PQueue from 'p-queue';
import logger from '../shared/logger';

/**
 * Engine answered with an error ("? message").
 */
export class GTPClientError extends Error {}

/**
 * Engine process exited, or did not answer in time.
 * Not related to the task itself, so it can be retried, i.e on another worker.
 */
export class GTPEngineError extends Error {}

const paramStr = (parameter: string | number | boolean): string => {
    if ('boolean' === typeof parameter) {
        return parameter ? '1' : '0';
    }

    return parameter + '';
};

/**
 * Default max time for a command to answer.
 * Long enough for tree searches.
 */
const DEFAULT_COMMAND_TIMEOUT_MS = 5 * 60_000;

type RunningCommand = {
    resolve: (result: string) => void;
    reject: (error: Error) => void;
    timeout: NodeJS.Timeout;
};

/**
 * Spawn a process from a given binary,
 * send commands and get result as promise,
 * in the GTP format ("= result\n\n" or "? error\n\n").
 *
 * If the process exits or does not answer in time,
 * running command fails, and process is spawned again on next command.
 *
 * Each instance of this class spawns a process that can use lot of memory.
 */
export default class GTPClient<Command extends string = string>
{
    private process: null | ChildProcessWithoutNullStreams = null;

    /**
     * Queue of transactions to run.
     * Allow running a group of commands sequentially.
     */
    private transactionsQueue = new PQueue({ concurrency: 1 });

    /**
     * Contains chunks of data received from stderr during last command.
     * Is reset before running a new command.
     */
    private lastStdErrChunks: string[] = [];

    /**
     * Stdout received and not yet parsed as a full response.
     */
    private stdoutBuffer = '';

    private runningCommand: null | RunningCommand = null;

    /**
     * @param runCommand Path to binary. I.e "/bin/mohex --seed 1".
     * @param commandTimeoutMs Engine process is killed if it does not answer a command in this time.
     */
    constructor(
        private runCommand: string,
        private commandTimeoutMs = DEFAULT_COMMAND_TIMEOUT_MS,
    ) {}

    private getProcess(): ChildProcessWithoutNullStreams
    {
        if (null !== this.process) {
            return this.process;
        }

        const [binary, ...args] = this.runCommand.split(' ').filter(arg => '' !== arg);

        logger.info(`Spawn process from ${binary}...`);

        const engineProcess = spawn(binary, args);

        this.process = engineProcess;
        this.stdoutBuffer = '';

        engineProcess.stdout.on('data', (data: Buffer) => {
            this.stdoutBuffer += data.toString().replace(/\r/g, '');
            this.parseResponses();
        });

        engineProcess.stderr.on('data', (data: Buffer) => {
            this.lastStdErrChunks.push(data.toString());
        });

        engineProcess.on('error', error => {
            logger.error('Engine process error', { binary, message: error.message });
            this.onProcessEnded(engineProcess, `Engine process error: ${error.message}`);
        });

        engineProcess.on('exit', (code, signal) => {
            logger.warning('Engine process exited', { binary, code, signal });
            this.onProcessEnded(engineProcess, `Engine process exited with code ${code}, signal ${signal}`);
        });

        return engineProcess;
    }

    private onProcessEnded(engineProcess: ChildProcessWithoutNullStreams, reason: string): void
    {
        if (this.process !== engineProcess) {
            return;
        }

        this.process = null;
        this.finishCommand(new GTPEngineError(reason));
    }

    /**
     * A GTP response ends with an empty line.
     */
    private parseResponses(): void
    {
        let end: number;

        while ((end = this.stdoutBuffer.indexOf('\n\n')) >= 0) {
            const response = this.stdoutBuffer.substring(0, end).trim();
            this.stdoutBuffer = this.stdoutBuffer.substring(end + 2);

            logger.debug(`command result: ${response}`);

            if (response.startsWith('=')) {
                this.finishCommand(null, response.substring(1).trim());
            } else {
                this.finishCommand(new GTPClientError(response));
            }
        }
    }

    private finishCommand(error: null | Error, result = ''): void
    {
        const runningCommand = this.runningCommand;

        if (null === runningCommand) {
            if (null === error) {
                logger.warning('Received a response while no command is running, ignoring it', { result });
            }

            return;
        }

        this.runningCommand = null;
        clearTimeout(runningCommand.timeout);

        if (null !== error) {
            runningCommand.reject(error);
        } else {
            runningCommand.resolve(result);
        }
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

        if (null !== this.runningCommand) {
            throw new Error('Another command is already running. Please await previous command result.');
        }

        const engineProcess = this.getProcess();

        return new Promise<string>((resolve, reject) => {
            const timeout = setTimeout(() => {
                logger.error('Engine did not answer in time, killing it', { command, timeoutMs: this.commandTimeoutMs });

                // Will be spawned again on next command
                this.process = null;
                engineProcess.kill('SIGKILL');

                this.finishCommand(new GTPEngineError(`Engine did not answer in time to command "${gtpCommand}"`));
            }, this.commandTimeoutMs);

            this.runningCommand = { resolve, reject, timeout };

            logger.debug(`sending command: ${command}`);

            this.lastStdErrChunks = [];
            engineProcess.stdin.write(command + '\n');
        });
    }

    async transaction<T>(callback: (gtpClient: GTPClient) => Promise<T>): Promise<T>
    {
        return this.transactionsQueue.add(() => callback(this));
    }

    /**
     * Stops engine process.
     */
    kill(): void
    {
        const engineProcess = this.process;

        this.process = null;
        engineProcess?.kill();
        this.finishCommand(new GTPEngineError('Engine killed'));
    }
}
