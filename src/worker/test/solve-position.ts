import assert from 'assert';
import { SolverEngine, solvePosition } from '../task/solve-position';

type Color = 'black' | 'white';

/**
 * Fake solver: winner and pv given by position, as "black-stones|white-stones|color".
 * Unknown positions are not proven.
 */
const createFakeSolver = (results: { [position: string]: { winner: null | Color, pv?: string[] } }) => {
    let black: string[] = [];
    let white: string[] = [];
    const played: string[] = [];
    const timelimits: string[] = [];

    const key = (color: Color) => [[...black].sort().join(','), [...white].sort().join(','), color].join('|');

    const solver: SolverEngine = {
        setGameParameters: async () => {},
        setDfpnParameters: async parameters => {
            if (parameters.timelimit !== undefined) {
                timelimits.push(parameters.timelimit);
            }
        },
        setPosition: async (size, b, w) => {
            black = [...b];
            white = [...w];
        },
        play: async (color, move) => {
            (color === 'black' ? black : white).push(move);
            played.push(move);
        },
        undo: async () => {
            const move = played.pop()!;
            black = black.filter(cell => cell !== move);
            white = white.filter(cell => cell !== move);
        },
        solveState: async color => results[key(color)]?.winner ?? null,
        getDfpnPv: async color => results[key(color)]?.pv ?? [],
    };

    return { solver, timelimits };
};

describe('solvePosition', () => {
    it('solves position only', async () => {
        const { solver } = createFakeSolver({
            'a1|b1|black': { winner: 'black', pv: ['a2', 'b2'] },
        });

        const output = await solvePosition(solver, { size: 2, black: ['a1'], white: ['b1'], color: 'black', timeLimitSeconds: 5 });

        assert.deepStrictEqual(output, { winner: 'black', pv: ['a2', 'b2'] });
    });

    it('solves all children, best move first', async () => {
        const { solver } = createFakeSolver({
            'a1|b1|black': { winner: 'black', pv: ['b2'] },
            'a1,b2|b1|white': { winner: 'black', pv: ['a2'] },
            'a1,a2|b1|white': { winner: 'white', pv: ['b2'] },
        });

        const output = await solvePosition(solver, {
            size: 2, black: ['a1'], white: ['b1'], color: 'black', timeLimitSeconds: 5, children: { maxTimeSeconds: 60 },
        });

        assert.deepStrictEqual(Object.keys(output.children!), ['b2', 'a2']);
        assert.deepStrictEqual(output.children, {
            b2: { winner: 'black', pv: ['a2'] },
            a2: { winner: 'white', pv: ['b2'] },
        });
    });

    it('marks all children as lost without solving them when player to move loses', async () => {
        const { solver, timelimits } = createFakeSolver({
            '||black': { winner: 'white' },
        });

        const output = await solvePosition(solver, {
            size: 2, black: [], white: [], color: 'black', timeLimitSeconds: 5, children: { maxTimeSeconds: 60 },
        });

        assert.strictEqual(Object.keys(output.children!).length, 4);
        assert.ok(Object.values(output.children!).every(child => child.winner === 'white'));
        assert.deepStrictEqual(timelimits, ['5']);
    });

    it('stops solving children when time runs out', async () => {
        const { solver, timelimits } = createFakeSolver({
            '|a1|black': { winner: 'black', pv: ['a2'] },
            'a2|a1|white': { winner: 'black' },
        });

        let time = 0;

        const output = await solvePosition(solver, {
            size: 2, black: [], white: ['a1'], color: 'black', timeLimitSeconds: 5, children: { maxTimeSeconds: 8 },
        }, () => {
            const current = time;
            time += 3000;
            return current;
        });

        // Started at 0, deadline at 8s: first child gets 5s, second the remaining 2s, then no time left
        assert.deepStrictEqual(timelimits, ['5', '5', '2']);
        assert.deepStrictEqual(output.children, {
            a2: { winner: 'black', pv: [] },
            b1: { winner: null, pv: [] },
            b2: { winner: null, pv: [] },
        });
    });

    it('refuses too large boards', async () => {
        const { solver } = createFakeSolver({});

        await assert.rejects(solvePosition(solver, { size: 15, black: [], white: [], color: 'black', timeLimitSeconds: 5 }));
    });
});
