import { ChildProcessWithoutNullStreams, spawn } from 'child_process';
import { GameParameters, MohexParameters } from './commandsParameters';
import MohexCommand from './allCommands';
import logger from '../../shared/logger';

const paramStr = (parameter: string | number | boolean): string => {
    if ('boolean' === typeof parameter) {
        return parameter ? '1' : '0';
    }

    return parameter + '';
}

/**
 * Spawn a process from mohex binary,
 * send commands and get result as promise.
 *
 * Each spawned process hold memory (~700Mo RAM),
 * so each active instance of this class use lot of memory.
 *
 * {@link https://github.com/cgao3/benzene-vanilla-cmake} Download and build mohex from this repository.
 */
export default class Mohex
{
    private process: ChildProcessWithoutNullStreams;

    /**
     * Whether a command is currently running,
     * so cannot run another command at same time.
     */
    private hasRunningCommand = false;

    /**
     * Contains chunks of data received from stderr during last command.
     * Is reset before running a new command.
     */
    private lastStdErrChunks: string[] = [];

    /**
     * @param pathToBinary Path to mohex binary. I.e "/home/debian/benzene-vanilla-cmake/build/src/mohex/mohex".
     * @param seed Seed of the program, useful to reproduce same moves. Defaults to random.
     */
    constructor(
        private pathToBinary: string,
        private seed?: number,
    ) {
        const args: string[] = [];

        if (this.seed) {
            args.push('--seed', '' + this.seed);
        }

        logger.info(`Spawn process from ${this.pathToBinary}...`);

        this.process = spawn(this.pathToBinary, args);

        this.process.stderr.on('data', (data: Buffer) => {
            this.lastStdErrChunks.push(data.toString());
        });

        this.showAllLogs();
    }

    private showAllLogs(): void
    {
        this.process.stdout.on('data', (data: Buffer) => {
            //logger.debug('STDOUT: ', data.toString());
        });

        this.process.stderr.on('data', (data: Buffer) => {
            //logger.debug('STDERR: ', data.toString());
        });

        this.process.on('spawn', () => {
            //logger.debug('spawn successfully, ready');
        });

        this.process.on('close', code => {
            //logger.debug('closed with exit status code', code);
        });

        this.process.on('disconnect', () => {
            //logger.debug('disconnected');
        });
    }

    getLastStdErrChunks(): string[]
    {
        return this.lastStdErrChunks;
    }

    async sendCommand(mohexCommand: MohexCommand, ...parameters: (string | number | boolean)[]): Promise<string>
    {
        const command: string = mohexCommand + parameters
            .map(parameter => ` ${paramStr(parameter)}`)
            .join('')
        ;

        return this.doSendCommand(command);
    }

    private async doSendCommand(rawCommand: string): Promise<string>
    {
        if (this.hasRunningCommand) {
            throw new Error('Cannot send command now, another command is already running');
        }

        this.lastStdErrChunks = [];
        this.hasRunningCommand = true;

        const resultPromise = new Promise<string>((resolve, reject) => {
            this.process.stdout.once('data', (data: Buffer) => {
                const result = data.toString().substring(1).trim();

                if (61 === data[0]) {
                    resolve(result);
                } else {
                    reject(result);
                }

                this.hasRunningCommand = false;
            });
        });

        //logger.debug('SEND COMMAND', rawCommand);

        this.process.stdin.write(rawCommand + '\n');

        return resultPromise;
    }

    private async setParameters(command: MohexCommand, parameters: MohexParameters | GameParameters): Promise<void>
    {
        for (const [key, parameter] of Object.entries(parameters)) {
            await this.sendCommand(command, key, parameter);
        }
    }

    async setMohexParameters(parameters: MohexParameters): Promise<void>
    {
        await this.setParameters('param_mohex', parameters);
    }

    async setGameParameters(parameters: GameParameters): Promise<void>
    {
        await this.setParameters('param_game', parameters);
    }

    /**
     * Clear board, and creates a board with new size.
     */
    async setBoardSize(width: number, height?: number): Promise<void>
    {
        if (!height) {
            height = width;
        }

        await this.sendCommand('boardsize', width, height);
    }

    /**
     * Example: playGame('a1 b2 h5')
     */
    async playGame(moves: string): Promise<string>
    {
        return await this.sendCommand('play-game', moves);
    }

    async showboard(): Promise<string>
    {
        return await this.sendCommand('showboard');
    }

    /**
     * Make a move on the current board
     */
    async play(color: 'black' | 'white', move: string): Promise<void>
    {
        await this.sendCommand('play', color, move);
    }

    /**
     * Calculate Mohex best move as black or white
     */
    async generateMove(color: 'black' | 'white'): Promise<string>
    {
        return this.sendCommand('genmove', color);
    }

    async license(): Promise<string>
    {
        return this.sendCommand('benzene-license');
    }
}
