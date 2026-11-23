import { describe, expect, it } from 'vitest';
import HexBoard, { BLACK, WHITE } from '../HexBoard';
import { rawNnFixtures } from './fixtures';

const boardFromFixture = ({ size, black, white }: typeof rawNnFixtures[number]): HexBoard => {
    const board = new HexBoard(size);

    black.forEach(([x, y]) => board.play(board.index(x, y), BLACK));
    white.forEach(([x, y]) => board.play(board.index(x, y), WHITE));

    return board;
};

describe('HexBoard', () => {
    it('plays same cells as katahex, dead and captured cells excluded', () => {
        for (const fixture of rawNnFixtures) {
            const board = boardFromFixture(fixture);
            const expected: number[] = [];

            fixture.policy.forEach((row, y) => row.forEach((value, x) => {
                if (value !== null) {
                    expected.push(board.index(x, y));
                }
            }));

            expect(board.legalMoves(), JSON.stringify(fixture)).toEqual(expected);
        }
    });

    it('parses and formats moves, letter is x, number is y', () => {
        expect(HexBoard.parseMove('a1', 11)).toBe(0);
        expect(HexBoard.parseMove('c2', 11)).toBe(11 + 2);
        expect(HexBoard.parseMove('aa1', 37)).toBe(26);
        expect(HexBoard.parseMove('ak37', 37)).toBe(36 * 37 + 36);

        for (const index of [0, 5, 26, 27, 36 * 37 + 36, 1000]) {
            expect(HexBoard.parseMove(HexBoard.moveToString(index, 37), 37)).toBe(index);
        }

        expect(() => HexBoard.parseMove('l1', 11)).toThrow();
    });

    it('detects connections: black top to bottom, white left to right', () => {
        const board = new HexBoard(5);

        for (let y = 0; y < 5; ++y) {
            board.play(board.index(1, y), BLACK);
        }

        expect(board.isConnected(BLACK, false)).toBe(true);
        expect(board.isConnected(WHITE)).toBe(false);

        const transposed = new HexBoard(5);

        for (let y = 0; y < 5; ++y) {
            transposed.play(transposed.index(y, 1), WHITE);
        }

        expect(transposed.isConnected(WHITE, false)).toBe(true);
        expect(transposed.isConnected(BLACK)).toBe(false);
    });

    it('counts bridges and 2nd row edge templates as connected, unless intruded', () => {
        // c2 and b4 on 2nd rows of a 5x5 board: edge templates, and bridge through c3 and b3
        const board = new HexBoard(5);

        board.play(board.index(2, 1), BLACK);
        board.play(board.index(1, 3), BLACK);

        expect(board.isConnected(BLACK, false)).toBe(false);
        expect(board.isConnected(BLACK)).toBe(true);

        // Intrusion in the bridge
        board.play(board.index(1, 2), WHITE);

        expect(board.isConnected(BLACK)).toBe(false);
    });

    it('keeps same hash for same position, whatever moves order', () => {
        const a = new HexBoard(7);
        const b = new HexBoard(7);

        a.play(3, BLACK);
        a.play(10, WHITE);
        b.play(10, WHITE);
        b.play(3, BLACK);

        expect(a.hash(BLACK)).toBe(b.hash(BLACK));
        expect(a.hash(BLACK)).not.toBe(a.hash(WHITE));
        expect(a.clone().hash(WHITE)).toBe(a.hash(WHITE));
    });
});
