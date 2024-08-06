import { GameParameters, MohexCommand, MohexParameters } from './types';
import GTPClient from '../GTPClient';
import { StandardizedPosition } from '../../shared/StandardizedPosition';

/**
 * Spawn a process from mohex binary,
 * send commands and get result as promise.
 *
 * {@link https://github.com/cgao3/benzene-vanilla-cmake} Download and build mohex from this repository.
 */
export default class Mohex
{
    private gtpClient: GTPClient<MohexCommand>;

    /**
     * @param runCommand Path to mohex binary. I.e "/bin/mohex --seed 1".
     */
    constructor(
        runCommand: string,
    ) {
        this.gtpClient = new GTPClient(runCommand);
    }

    async sendCommand(mohexCommand: MohexCommand, ...parameters: (string | number | boolean)[]): Promise<string>
    {
        return this.gtpClient.sendCommand(mohexCommand, ...parameters);
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
    async playGame(moves: string): Promise<void>
    {
        await this.sendCommand('play-game', moves);
    }

    async setStandardizedPosition(standardizedPosition: StandardizedPosition): Promise<void>
    {
        const { blackCells, whiteCells } = standardizedPosition;

        if (0 === blackCells.length && 0 === whiteCells.length) {
            await this.sendCommand('clear_board');
            return;
        }

        const playGame = [];
        let i = 0;

        while (i < blackCells.length && i < whiteCells.length) {
            playGame.push(blackCells[i]);
            playGame.push(whiteCells[i]);

            ++i;
        }

        if (blackCells.length > i) {
            playGame.push(blackCells[i]);
        }

        if (playGame.length > 0) {
            await this.playGame(playGame.join(' '));
        }

        for (const cell of blackCells.slice(i + 1)) {
            await this.play('black', cell);
        }

        for (const cell of whiteCells.slice(i)) {
            await this.play('white', cell);
        }
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

    async version(): Promise<string>
    {
        return [
            await this.sendCommand('name'),
            await this.sendCommand('version'),
        ].join(' ');
    }
}
