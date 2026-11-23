import HexBoard, { Player, WHITE } from './HexBoard';

/*
 * Neural network inputs, port of katahex NNInputs::fillRowV7() for Hex,
 * with default search params (no policy local focus, no max moves).
 * See model-conversion/README.md.
 */

export const NUM_SPATIAL_FEATURES = 22;
export const NUM_GLOBAL_FEATURES = 19;

/**
 * 0: identity, 1: 180° rotation. Hex board has no other symmetry.
 */
export type Symmetry = 0 | 1;

/**
 * Cell index in network input/output, from board cell index.
 * Board is transposed when white plays (katahex nneval.cpp), so that player to play connects along y.
 * Involution: also gives board cell from network cell.
 */
export const toNetworkIndex = (index: number, size: number, player: Player, symmetry: Symmetry): number => {
    let x = index % size;
    let y = (index - x) / size;

    if (player === WHITE) {
        [x, y] = [y, x];
    }

    if (symmetry === 1) {
        x = size - 1 - x;
        y = size - 1 - y;
    }

    return y * size + x;
};

/**
 * Fills inputs of one position, NCHW, at given offsets of batch buffers.
 * Buffers must be zeroed.
 */
export const fillInputs = (
    board: HexBoard,
    player: Player,
    symmetry: Symmetry,
    spatial: Float32Array,
    spatialOffset: number,
    global: Float32Array,
    globalOffset: number,
): void => {
    const { size, cells } = board;
    const area = size * size;

    for (let i = 0; i < area; ++i) {
        const n = spatialOffset + toNetworkIndex(i, size, player, symmetry);

        // On board
        spatial[n] = 1;

        if (cells[i] === player) {
            spatial[n + area] = 1;
        } else if (cells[i] !== 0) {
            spatial[n + 2 * area] = 1;
        }
    }

    global[globalOffset] = player === WHITE ? 1 : 0;
};

