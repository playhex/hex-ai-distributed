import { StandardizedPosition } from '../../shared/StandardizedPosition';
import logger from '../../shared/logger';
import { takeKataRawNBestMoves } from '../../shared/utils';
import GTPClient from '../GTPClient';
import { KatahexCommand } from './types';

export type RawNNOutput = {
    values: number[][];
    whiteWin: number;
};

export default class Katahex
{
    private gtpClient: GTPClient<KatahexCommand>;

    /**
     * @param runCommand Path to katahex binary. I.e "katahex gtp -config /app/katahex/config.cfg -model /app/katahex/katahex_model_20220618.bin.gz".
     */
    constructor(
        runCommand: string,
    ) {
        this.gtpClient = new GTPClient(runCommand);
    }

    async sendCommand(gtpCommand: KatahexCommand, ...parameters: (string | number | boolean)[]): Promise<string>
    {
        return this.gtpClient.sendCommand(gtpCommand, ...parameters);
    }

    async transaction<T>(callback: (katahex: Katahex) => Promise<T>): Promise<T>
    {
        return this.gtpClient.transaction(() => callback(this));
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
        if ('' === moves) {
            return;
        }

        const position = moves
            .split(' ')
            .map((move,index) => `${['black', 'white'][index % 2]} ${move}`)
            .join(' ')
        ;

        await this.sendCommand('set_position', position);
    }

    /**
     * Ex:
     *  await setPosition('black a2 white d4');
     */
    async setPosition(position: string): Promise<void>
    {
        await this.sendCommand('set_position', position);
    }

    async setStandardizedPosition(standardizedPosition: StandardizedPosition): Promise<void>
    {
        if (0 === standardizedPosition.blackCells.length && 0 === standardizedPosition.whiteCells.length) {
            await this.sendCommand('clear_board');
            return;
        }

        const black = standardizedPosition
            .blackCells
            .map(cell => `black ${cell}`)
            .join(' ')
        ;

        const white = standardizedPosition
            .whiteCells
            .map(cell => `white ${cell}`)
            .join(' ')
        ;

        await this.setPosition(black + (black && white ? ' ' : '') + white);
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
     * Calculate best move as black or white.
     * Warning: can return "pass" when Katahex feels he is too winning or too losing.
     *
     * Use getBestNonPassingMoveFromTreeSearch() instead.
     */
    async generateMove(color: 'black' | 'white'): Promise<string>
    {
        return this.sendCommand('genmove', color);
    }

    async getBestNonPassingMoveFromTreeSearch(color: 'black' | 'white'): Promise<string>
    {
        const move = await this.sendCommand('genmove_debug', color);

        if (!move.match(/^pa?ss$/)) { // katahex returns "pss"
            return move;
        }

        // In case of "pass" move, returns first non-pass move from best moves
        logger.debug('Katahex returned "pass", searching best non-pass move in genmove_debug');
        const genmoveDebug = this.gtpClient.getLastStdErrChunks().join('');
        logger.debug(genmoveDebug);
        const match = genmoveDebug.match(/^([a-z]+\d+) *:/m);

        if (null === match || match.length < 2) {
            logger.error('Did not found best move in katahex genmove debug');
            return 'resign';
        }

        return match[1];
    }

    /**
     * Read neural network output, parse it,
     * and returns values as number[][].
     */
    async parseRawNn(symmetry: number = 0): Promise<RawNNOutput>
    {
        const output = await this.sendCommand('kata-raw-nn', symmetry);
        const lines = output.split('\n');
        const globalValues: { [key: string]: number } = {};

        while (lines.length > 0 && lines[0] !== 'policy') {
            const globalValue = lines.shift()?.split(' ');

            if (globalValue && 2 === globalValue.length) {
                globalValues[globalValue[0]] = parseFloat(globalValue[1]);
            }
        }

        while (lines.length > 0 && !lines[lines.length - 1].startsWith('policyPass')) {
            lines.pop();
        }

        if (lines.length <= 2) {
            throw new Error('Did not found model values in katahex output');
        }

        lines.shift();
        lines.pop();

        return {
            values: lines.map(line => line.trim().split(/ +/).map(v => parseFloat(v))),
            whiteWin: globalValues['whiteWin'],
        };
    }

    /**
     * Only use raw neural network output to get best move from its intuition.
     * Don't make any tree searching.
     * Returns best move for black.
     */
    async getBestMoveFromNeuralNetworkOutput(symmetry: number = 0): Promise<string>
    {
        const rawNNOutput = await this.parseRawNn(symmetry);
        const bestMove = takeKataRawNBestMoves(rawNNOutput.values, 1).pop() ?? null;

        if (null === bestMove) {
            throw new Error('Did not found best move');
        }

        return bestMove.move.toString();
    }

    async version(): Promise<string>
    {
        return [
            await this.sendCommand('name'),
            await this.sendCommand('version'),
        ].join(' ');
    }
}
