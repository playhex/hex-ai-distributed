import { DfpnParameters, GameParameters, MohexCommand, MohexParameters, MohexPolicyParameters } from './types';
import GTPClient from '../GTPClient';
import { StandardizedPosition } from '../../shared/StandardizedPosition';

type Stone = { color: 'black' | 'white', cell: string };

/**
 * Order to replay stones of a position on mohex, which searches around the last played move:
 * last stone must belong to the opponent of current player.
 *
 * Alternates colors from the most recent stones, as stones count may differ:
 * after a swap, white has the first stone.
 *
 * Same as game order, unless there is pass moves, which cannot be replayed:
 * then last stone is the most recent opponent stone,
 * or a current player stone if opponent has no stone.
 */
export const getStonesInPlayOrder = ({ blackCells, whiteCells, currentPlayer }: StandardizedPosition): Stone[] => {
    const opponent = 'black' === currentPlayer ? 'white' : 'black';
    const playerCells = 'black' === currentPlayer ? blackCells : whiteCells;
    const opponentCells = 'black' === currentPlayer ? whiteCells : blackCells;
    const stones: Stone[] = [];

    for (let i = Math.max(playerCells.length, opponentCells.length); i > 0; --i) {
        if (i <= playerCells.length) {
            stones.push({ color: currentPlayer, cell: playerCells[playerCells.length - i] });
        }

        if (i <= opponentCells.length) {
            stones.push({ color: opponent, cell: opponentCells[opponentCells.length - i] });
        }
    }

    return stones;
};

/**
 * Whether last stone replayed by getStonesInPlayOrder() is a current player stone,
 * so there is no opponent move to answer to.
 */
export const isLastStoneOwn = (position: StandardizedPosition): boolean =>
    getStonesInPlayOrder(position).at(-1)?.color === position.currentPlayer
;

/**
 * Spawn a process from mohex binary,
 * send commands and get result as promise.
 *
 * {@link https://github.com/playhex/benzene-vanilla-cmake.git} Download and build mohex from this repository.
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

    private async setParameters(command: MohexCommand, parameters: MohexParameters | MohexPolicyParameters | GameParameters | DfpnParameters): Promise<void>
    {
        for (const [key, parameter] of Object.entries(parameters)) {
            await this.sendCommand(command, key, parameter);
        }
    }

    async setMohexParameters(parameters: MohexParameters): Promise<void>
    {
        await this.setParameters('param_mohex', parameters);
    }

    async setMohexPolicyParameters(parameters: MohexPolicyParameters): Promise<void>
    {
        await this.setParameters('param_mohex_policy', parameters);
    }

    async setGameParameters(parameters: GameParameters): Promise<void>
    {
        await this.setParameters('param_game', parameters);
    }

    async setDfpnParameters(parameters: DfpnParameters): Promise<void>
    {
        await this.setParameters('param_dfpn', parameters);
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
        await this.sendCommand('clear_board');

        for (const { color, cell } of getStonesInPlayOrder(standardizedPosition)) {
            await this.play(color, cell);
        }
    }

    /**
     * Sets any position, even not reachable in a game (i.e more white stones than black).
     */
    async setPosition(size: number, black: string[], white: string[]): Promise<void>
    {
        await this.setBoardSize(size);

        for (const cell of black) {
            await this.play('black', cell);
        }

        for (const cell of white) {
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

    async undo(): Promise<void>
    {
        await this.sendCommand('undo');
    }

    /**
     * Solves current position with dfpn solver, color to move.
     *
     * @returns Proven winner, or null if not solved within param_dfpn timelimit
     */
    async solveState(color: 'black' | 'white'): Promise<null | 'black' | 'white'>
    {
        const winner = await this.sendCommand('dfpn-solve-state', color);

        if ('black' === winner || 'white' === winner) {
            return winner;
        }

        if ('empty' === winner) {
            return null;
        }

        throw new Error(`Unexpected dfpn-solve-state response: "${winner}"`);
    }

    /**
     * Principal variation of last solved position, color to move.
     * Empty when position is won by a virtual connection, without search.
     */
    async getDfpnPv(color: 'black' | 'white'): Promise<string[]>
    {
        const pv = await this.sendCommand('dfpn-get-pv', color);

        return pv.split(/\s+/).filter(move => move !== '');
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
