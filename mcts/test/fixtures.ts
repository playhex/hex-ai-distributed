import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Katahex kata-raw-nn outputs, see model-conversion/dump_fixtures.py.
 */
export type RawNnFixture = {
    size: number;
    black: [number, number][];
    white: [number, number][];
    whiteToPlay: boolean;
    whiteWin: number;

    /**
     * Rows (y) of cells (x), null for cells katahex does not play.
     */
    policy: (null | number)[][];

    /**
     * Same with symmetry 1 (180° rotation).
     */
    whiteWin1: number;
    policy1: (null | number)[][];
};

export const rawNnFixtures: RawNnFixture[] = JSON.parse(readFileSync(join(__dirname, 'fixtures/katahex-raw-nn.json'), 'utf-8'));
