import logger from '../../shared/logger';
import GTPClient from '../GTPClient';
import { mirrorMove } from '../mirrorMoves';
import { KatahexCommand } from './types';

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

        if (!move.match(/^pa?ss$/)) {
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
     * Only use raw neural network output to get best move from its intuition.
     * Don't make any tree searching.
     */
    async getBestMoveFromNeuralNetworkOutput(symmetry: number = 0): Promise<string>
    {
        const output = await this.sendCommand('kata-raw-nn', symmetry);
        const lines = output.split('\n');

        while (lines.length > 0 && lines[0] !== 'policy') {
            lines.shift();
        }

        while (lines.length > 0 && !lines[lines.length - 1].startsWith('policyPass')) {
            lines.pop();
        }

        if (lines.length <= 2) {
            throw new Error('Did not found model values in katahex output');
        }

        lines.shift();
        lines.pop();

        const values = lines.map(line => line.trim().split(/ +/).map(v => parseFloat(v)));
        let bestMove: null | { move: Move, value: number } = null;

        for (let row = 0; row < values.length; ++row) {
            for (let col = 0; col < values[row].length; ++col) {
                const value = values[row][col];

                if (isNaN(value)) {
                    continue;
                }

                if (null === bestMove || value > bestMove.value) {
                    bestMove = {
                        move: new Move(row, col),
                        value,
                    };
                }
            }
        }

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


class Move
{
    constructor(
        public row: number,
        public col: number,
    ) {}

    static rowToNumber(row: number): string
    {
        return String(row + 1);
    }

    static colToLetter(col: number): string
    {
        /** letter(4) => "e" */
        const letter = (n: number): string => String.fromCharCode(97 + n);

        return col < 26
            ? letter(col)
            : letter(Math.floor(col / 26) - 1) + letter(col % 26)
        ;
    }

    toString(): string
    {
        return Move.colToLetter(this.col) + Move.rowToNumber(this.row);
    }
}
