import { StandardizedPosition } from '../../shared/StandardizedPosition';
import { takeKataRawNBestMoves } from '../../shared/utils';
import GTPClient from '../GTPClient';
import { KatahexCommand } from './types';

export type RawNNOutput = {
    values: number[][];
    whiteWin: number;
};

export type SearchMove = {
    move: string;
    visits: number;

    /**
     * Win rate of player to play after this move.
     */
    winrate: number;

    /**
     * Raw neural network policy of this move.
     */
    prior: number;

    /**
     * Rank of this move, 0 for best move.
     */
    order: number;
};

export type SearchOutput = {
    /**
     * Searched moves, best move first. Pass excluded.
     */
    moves: SearchMove[];

    /**
     * Move chosen by katahex, can be pass ("pss").
     */
    played: string;
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

        await this.setPosition(toStonePairs(standardizedPosition));
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
     * Limit tree search of next searches.
     */
    async setMaxPlayouts(maxPlayouts: number): Promise<void>
    {
        await this.sendCommand('kata-set-param', 'maxPlayouts', maxPlayouts);
    }

    /**
     * Set position with its current player to play.
     *
     * set_position always sets black to play, so when white is to play,
     * set position without a black stone, then play this black stone.
     *
     * Used for tree search instead of mirroring position to make black play:
     * a mirrored position (black to play, with one less stone)
     * is unusual for katahex, which then searches wrong lines.
     */
    async setPositionWithCurrentPlayer(standardizedPosition: StandardizedPosition): Promise<void>
    {
        if ('black' === standardizedPosition.currentPlayer) {
            await this.setStandardizedPosition(standardizedPosition);
            return;
        }

        const position = standardizedPosition.clone();
        const lastBlackCell = position.blackCells.pop();

        await this.setStandardizedPosition(position);
        await this.play('black', lastBlackCell ?? 'pass');
    }

    /**
     * Run a tree search, limited by maxPlayouts param,
     * and returns searched moves and the move katahex would play.
     * Also plays the move on the board.
     *
     * @param color Player to play, must be the one set on board, see setPositionWithCurrentPlayer().
     * @param maxMoves Max number of searched moves to return.
     */
    async searchAnalyze(color: 'black' | 'white', maxMoves: number): Promise<SearchOutput>
    {
        // Without interval, analyze line is printed once, at end of search
        const output = await this.sendCommand('kata-genmove_analyze', color, 'maxmoves', maxMoves);
        const lines = output.split('\n');
        const infoLine = lines.find(line => line.startsWith('info ')) ?? '';
        const playLine = lines.find(line => line.startsWith('play ')) ?? null;

        if (null === playLine) {
            throw new Error('Did not found played move in katahex genmove analyze output');
        }

        const moves = infoLine
            .split(/(?:^| )info /)
            .filter(info => '' !== info)
            .map(info => parseSearchMove(info))
            .filter(searchMove => !isPass(searchMove.move))
            .sort((a, b) => a.order - b.order)
        ;

        return {
            moves,
            played: playLine.substring('play '.length).trim(),
        };
    }

    /**
     * Read neural network output, parse it,
     * and returns values as number[][].
     */
    async parseRawNn(symmetry: number = 0): Promise<RawNNOutput>
    {
        const output = await this.sendCommand('kata-raw-nn', symmetry);

        return parseRawNnBlock(output.split('\n'));
    }

    /**
     * Same as parseRawNn(), for many positions at once, black to play, on current board size.
     * Katahex evaluates them in parallel, so that its neural network evaluates them in batches.
     * Does not change current position.
     *
     * @returns Output of each position, in same order.
     */
    async parseRawNnBatch(positions: StandardizedPosition[], symmetry: number = 0): Promise<RawNNOutput[]>
    {
        if (0 === positions.length) {
            return [];
        }

        const output = await this.sendCommand(
            'kata-raw-nn-batch',
            symmetry,
            positions.map(position => toStonePairs(position)).join(' | '),
        );

        // Split on "position <i>" lines
        const blocks: string[][] = [];

        for (const line of output.split('\n')) {
            if (/^position \d+$/.test(line.trim())) {
                blocks.push([]);
                continue;
            }

            blocks[blocks.length - 1]?.push(line);
        }

        if (blocks.length !== positions.length) {
            throw new Error(`Expected ${positions.length} positions in katahex batch output, got ${blocks.length}`);
        }

        return blocks.map(lines => parseRawNnBlock(lines));
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

    /**
     * Whether this katahex build supports a command, i.e kata-raw-nn-batch, which is not in older builds.
     */
    async supportsCommand(command: KatahexCommand): Promise<boolean>
    {
        return 'true' === (await this.sendCommand('known_command', command)).trim();
    }

    async version(): Promise<string>
    {
        return [
            await this.sendCommand('name'),
            await this.sendCommand('version'),
        ].join(' ');
    }
}

/**
 * Stones of a position, as expected by set_position, like "black a1 black c3 white b2".
 */
const toStonePairs = (standardizedPosition: StandardizedPosition): string => [
    ...standardizedPosition.blackCells.map(cell => `black ${cell}`),
    ...standardizedPosition.whiteCells.map(cell => `white ${cell}`),
].join(' ');

/**
 * Parse output of kata-raw-nn for a single position:
 * global values ("whiteWin 0.42"), then "policy", then policy rows, then "policyPass".
 */
const parseRawNnBlock = (lines: string[]): RawNNOutput => {
    lines = [...lines];
    const globalValues: { [key: string]: number } = {};

    while (lines.length > 0 && lines[0] !== 'policy') {
        const globalValue = lines.shift()?.split(' ');

        if (globalValue && 2 === globalValue.length) {
            globalValues[globalValue[0]] = parseFloatOrZero(globalValue[1]);
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
        values: lines.map(line => line.trim().split(/ +/).map(v => parseFloatOrZero(v))),
        whiteWin: globalValues['whiteWin'],
    };
};

/**
 * Katahex returns "pss" for pass.
 */
export const isPass = (move: string): boolean => /^pa?ss$/.test(move);

/**
 * Parse a move from analyze output, like:
 * "move i7 visits 40 utility 0.99 winrate 0.99 ... prior 0.03 ... order 0 pv i7 g4 c11"
 */
const parseSearchMove = (info: string): SearchMove => {
    const tokens = info.trim().split(/ +/);
    const get = (key: string): string => {
        const index = tokens.indexOf(key);

        if (-1 === index || index + 1 >= tokens.length) {
            throw new Error(`Missing "${key}" in katahex analyze output: "${info}"`);
        }

        return tokens[index + 1];
    };

    return {
        move: get('move'),
        visits: parseInt(get('visits'), 10),
        winrate: parseFloatOrZero(get('winrate')),
        prior: parseFloatOrZero(get('prior')),
        order: parseInt(get('order'), 10),
    };
};

/**
 * Do not return NaN when parsing "N/A",
 * else it will json stringify to null
 */
const parseFloatOrZero = (v: string): number => {
    const n = parseFloat(v);

    return isNaN(n) ? 0 : n;
};
