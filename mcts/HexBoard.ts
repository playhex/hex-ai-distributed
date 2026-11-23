/*
 * Hex board with katahex rules (katahex/cpp/game/gamelogic.cpp):
 *  - black connects top and bottom (y), white connects left and right (x)
 *  - a player wins as soon as connected, bridges and edge templates of 2nd row included
 *  - dead or captured cells are not played (when there is another move)
 */

export const EMPTY = 0;
export const BLACK = 1;
export const WHITE = 2;
const WALL = 3;

export type Player = typeof BLACK | typeof WHITE;

export const opponent = (player: Player): Player => player === BLACK ? WHITE : BLACK;

/**
 * Neighbours, in this order, used by capture table and jump connections.
 */
const DXS = [0, 1, 1, 0, -1, -1, 0];
const DYS = [-1, -1, 0, 1, 1, 0, -1];

/**
 * Bridge destinations, between neighbours d and d + 1.
 */
const JUMP_DXS = [1, 2, 1, -1, -2, -1];
const JUMP_DYS = [-2, -1, 1, 2, 1, -1];

/**
 * By 6 neighbours colors (2 bits each): 0 not dead, 1 dead, 2 captured.
 * Port of Board::initCaptureTable().
 */
const CAPTURE_TABLE = ((): Uint8Array => {
    const table = new Uint8Array(4096);
    const toId = (t: number[]): number => t[0] + t[1] * 4 + t[2] * 16 + t[3] * 64 + t[4] * 256 + t[5] * 1024;

    // 3 basic dead shapes, "#" any of empty, black or white
    const shapes: [number[], [number, number]][] = [
        [[1, 1, 1, 1, 0, 0], [4, 5]],
        [[1, 1, 1, 0, 2, 0], [3, 5]],
        [[1, 1, 0, 2, 2, 0], [2, 5]],
    ];

    for (const [shape, [i, j]] of shapes) {
        for (let a = 0; a < 3; ++a) {
            for (let b = 0; b < 3; ++b) {
                const t = [...shape];
                t[i] = a;
                t[j] = b;
                table[toId(t)] = 1;
            }
        }
    }

    // 6 rotations
    for (let id = 0; id < 4096; ++id) {
        if (table[id] !== 1) {
            continue;
        }

        let t = id;

        for (let rot = 0; rot < 6; ++rot) {
            t = 1024 * (t % 4) + Math.floor(t / 4);
            table[t] = 1;
        }
    }

    // Color inverse
    for (let id = 0; id < 4096; ++id) {
        if (table[id] !== 1) {
            continue;
        }

        const t: number[] = [];

        for (let i = 0, a = id; i < 6; ++i, a = Math.floor(a / 4)) {
            const c = a % 4;
            t.push(c === 1 ? 2 : c === 2 ? 1 : 0);
        }

        table[toId(t)] = 1;
    }

    // Captured: a dead shape with one stone removed
    for (let id = 0; id < 4096; ++id) {
        if (table[id] !== 1) {
            continue;
        }

        for (let i = 0; i < 6; ++i) {
            const id2 = id & ~(3 << (2 * i));

            if (table[id2] === 0) {
                table[id2] = 2;
            }
        }
    }

    // Wall (3) matches any color
    for (let id = 0; id < 4096; ++id) {
        if (table[id] === 0) {
            continue;
        }

        for (let k = 0; k < 64; ++k) {
            let c = 0;

            for (let i = 0, m = k; i < 6; ++i, m = Math.floor(m / 2)) {
                c *= 4;

                if (m % 2) {
                    c |= 3;
                }
            }

            const id2 = id | c;

            if (table[id2] === 0) {
                table[id2] = table[id];
            } else if (table[id2] === 2 && table[id] === 1) {
                table[id2] = 1;
            }
        }
    }

    return table;
})();

/**
 * Random 53 bits numbers by cell and color, for position hashes.
 */
const zobrist = (() => {
    let seed = 0x9e3779b9;
    const random32 = (): number => {
        seed = (seed + 0x6d2b79f5) | 0;
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return (t ^ (t >>> 14)) >>> 0;
    };
    const cache = new Map<number, Float64Array>();

    /**
     * Hash parts are xored as two 32 bits parts, see HexBoard.hash.
     */
    return (size: number): Float64Array => {
        let table = cache.get(size);

        if (table === undefined) {
            table = new Float64Array(size * size * 3 * 2);

            for (let i = 0; i < table.length; ++i) {
                table[i] = random32();
            }

            cache.set(size, table);
        }

        return table;
    };
})();

export default class HexBoard
{
    /**
     * By cell index y * size + x.
     */
    readonly cells: Uint8Array;

    private hashLow = 0;
    private hashHigh = 0;

    private zobrist: Float64Array;

    constructor(
        readonly size: number,
    ) {
        if (size < 4) {
            // Katahex connection check requires at least 4 rows
            throw new Error(`Board size must be at least 4, got ${size}`);
        }

        this.cells = new Uint8Array(size * size);
        this.zobrist = zobrist(size);
    }

    clone(): HexBoard
    {
        const board = new HexBoard(this.size);

        board.cells.set(this.cells);
        board.hashLow = this.hashLow;
        board.hashHigh = this.hashHigh;

        return board;
    }

    index(x: number, y: number): number
    {
        return y * this.size + x;
    }

    /**
     * Position hash, with player to play.
     */
    hash(player: Player): number
    {
        // 32 + 21 bits, safe integer
        return (this.hashHigh & 0x1fffff) * 0x100000000 + ((this.hashLow ^ player) >>> 0);
    }

    play(index: number, player: Player): void
    {
        if (this.cells[index] !== EMPTY) {
            throw new Error(`Cell ${index} is not empty`);
        }

        this.cells[index] = player;
        this.hashLow = (this.hashLow ^ this.zobrist[(index * 3 + player) * 2]) >>> 0;
        this.hashHigh = (this.hashHigh ^ this.zobrist[(index * 3 + player) * 2 + 1]) >>> 0;
    }

    private colorAround(x: number, y: number): number
    {
        const { size } = this;

        if (x >= 0 && x < size && y >= 0 && y < size) {
            return this.cells[y * size + x];
        }

        // Edges count as stones of the player owning them, corners as walls
        if (x === -1) {
            return y >= 1 && y < size ? WHITE : WALL;
        }

        if (x === size) {
            return y >= 0 && y < size - 1 ? WHITE : WALL;
        }

        if (y === -1) {
            return x >= 1 && x < size ? BLACK : WALL;
        }

        if (y === size) {
            return x >= 0 && x < size - 1 ? BLACK : WALL;
        }

        return WALL;
    }

    /**
     * Port of Board::isDeadOrCaptured(): occupied, or empty but useless to play.
     */
    isDeadOrCaptured(index: number): boolean
    {
        if (this.cells[index] !== EMPTY) {
            return true;
        }

        const x0 = index % this.size;
        const y0 = (index - x0) / this.size;
        let surroundings = 0;

        for (let d = 0; d < 6; ++d) {
            surroundings = surroundings * 4 + this.colorAround(x0 + DXS[d], y0 + DYS[d]);
        }

        return CAPTURE_TABLE[surroundings] !== 0;
    }

    /**
     * Cells katahex considers playable: empty and not dead or captured,
     * or all empty cells if they are all dead.
     */
    legalMoves(): number[]
    {
        const moves: number[] = [];
        const empty: number[] = [];

        for (let i = 0; i < this.cells.length; ++i) {
            if (this.cells[i] !== EMPTY) {
                continue;
            }

            empty.push(i);

            if (!this.isDeadOrCaptured(i)) {
                moves.push(i);
            }
        }

        return moves.length > 0 ? moves : empty;
    }

    /**
     * Port of Board::checkConnection(): whether player connects its two edges,
     * with bridges and 2nd row edge templates if includeJumpConnection.
     */
    isConnected(player: Player, includeJumpConnection = true): boolean
    {
        // 0 empty, 1 player, 2 opponent or bridge gap, 3 reached from top, 4 bottom
        // Always connect along y: transposed for white
        const size = this.size;
        const buf = new Int8Array(size * size);

        for (let y = 0; y < size; ++y) {
            for (let x = 0; x < size; ++x) {
                const c = player === BLACK ? this.cells[y * size + x] : this.cells[x * size + y];
                buf[y * size + x] = c === player ? 1 : c === EMPTY ? 0 : 2;
            }
        }

        const get = (x: number, y: number): number => x < 0 || x >= size || y < 0 || y >= size ? 2 : buf[x + y * size];

        for (let x = 0; x < size; ++x) {
            if (buf[(size - 1) * size + x] === 1) {
                buf[(size - 1) * size + x] = 4;
            }
        }

        if (includeJumpConnection) {
            for (let x = 1; x < size; ++x) {
                if (buf[(size - 2) * size + x] === 1 && buf[(size - 1) * size + x] === 0 && buf[(size - 1) * size + x - 1] === 0) {
                    buf[(size - 2) * size + x] = 4;
                }
            }
        }

        // Iterative version of checkConnectionHelper(), same visit order
        const search = (startX: number, startY: number): boolean => {
            type Frame = { x: number, y: number, step: number };
            const stack: Frame[] = [{ x: startX, y: startY, step: 0 }];
            buf[startX + startY * size] = 3;

            while (stack.length > 0) {
                const frame = stack[stack.length - 1];
                const { x: x0, y: y0 } = frame;

                if (frame.step < 6) {
                    const d = frame.step++;
                    const x = x0 + DXS[d];
                    const y = y0 + DYS[d];
                    const c = get(x, y);

                    if (c === 4) {
                        return true;
                    }

                    if (c === 1) {
                        buf[x + y * size] = 3;
                        stack.push({ x, y, step: 0 });
                    }

                    continue;
                }

                if (includeJumpConnection && frame.step < 12) {
                    const d = frame.step++ - 6;
                    const x = x0 + JUMP_DXS[d];
                    const y = y0 + JUMP_DYS[d];
                    const c = get(x, y);
                    const gapsEmpty = get(x0 + DXS[d], y0 + DYS[d]) === 0 && get(x0 + DXS[d + 1], y0 + DYS[d + 1]) === 0;

                    if (c === 4 && gapsEmpty) {
                        return true;
                    }

                    if (c === 1 && gapsEmpty) {
                        buf[x0 + DXS[d] + size * (y0 + DYS[d])] = 2;
                        buf[x0 + DXS[d + 1] + size * (y0 + DYS[d + 1])] = 2;
                        buf[x + y * size] = 3;
                        stack.push({ x, y, step: 0 });
                    }

                    continue;
                }

                stack.pop();
            }

            return false;
        };

        for (let x = 0; x < size; ++x) {
            if (buf[x] === 1 && search(x, 0)) {
                return true;
            }
        }

        if (includeJumpConnection) {
            for (let x = 0; x < size - 1; ++x) {
                if (buf[size + x] === 1 && buf[x] === 0 && buf[x + 1] === 0 && search(x, 1)) {
                    return true;
                }
            }
        }

        return false;
    }

    /**
     * Cell index from a move like "c4", "aa12": letter is x (column), number is y (row).
     */
    static parseMove(move: string, size: number): number
    {
        const match = move.match(/^([a-z]{1,2})(\d{1,2})$/);

        if (match === null) {
            throw new Error(`Invalid move "${move}"`);
        }

        const [, letters, number] = match;
        const x = letters.length === 1
            ? letters.charCodeAt(0) - 97
            : (letters.charCodeAt(0) - 97 + 1) * 26 + letters.charCodeAt(1) - 97;
        const y = parseInt(number, 10) - 1;

        if (x < 0 || x >= size || y < 0 || y >= size) {
            throw new Error(`Move "${move}" out of board of size ${size}`);
        }

        return y * size + x;
    }

    static moveToString(index: number, size: number): string
    {
        const x = index % size;
        const y = (index - x) / size;
        const letter = (n: number): string => String.fromCharCode(97 + n);

        return (x < 26 ? letter(x) : letter(Math.floor(x / 26) - 1) + letter(x % 26)) + String(y + 1);
    }
}
