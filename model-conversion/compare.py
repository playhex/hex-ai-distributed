"""
Compares ONNX model output with katahex "kata-raw-nn" on random positions.

Usage:
    PYTHONPATH=.deps python3 compare.py KATAHEX_BINARY MODEL.bin.gz MODEL.onnx [--sizes 7 11 19] [--positions 4] [--tolerance 0.05]

Katahex config: out/compare.cfg (see README), with cudaUseFP16 = false to compare with float32.
"""

import argparse
import math
import random
import subprocess

import numpy as np
import onnxruntime as ort

NUM_SPATIAL = 22
NUM_GLOBAL = 19


class Katahex:
    def __init__(self, binary: str, model: str, config: str):
        self.process = subprocess.Popen(
            [binary, 'gtp', '-config', config, '-model', model],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True,
        )

    def command(self, command: str) -> str:
        self.process.stdin.write(command + '\n')
        self.process.stdin.flush()
        lines = []
        while True:
            line = self.process.stdout.readline()
            if line == '':
                raise RuntimeError(f'katahex exited on "{command}"')
            if line.strip() == '' and lines:
                break
            if line.strip() != '':
                lines.append(line.rstrip('\n'))
        if not lines[0].startswith('='):
            raise RuntimeError(f'"{command}" failed: {lines}')
        lines[0] = lines[0][1:].strip()
        return '\n'.join(lines)

    def raw_nn(self, size: int, black: list, white: list, white_to_play: bool, symmetry: int = 0) -> tuple:
        cell = lambda xy: f'({xy[0] + 1},{xy[1] + 1})'
        self.command(f'boardsize {size}')
        self.command('clear_board')

        # set_position always sets black to play: play last black stone to set white to play
        set_black = black[:-1] if white_to_play else black
        stones = [f'black {cell(c)}' for c in set_black] + [f'white {cell(c)}' for c in white]
        if stones:
            self.command('set_position ' + ' '.join(stones))
        if white_to_play:
            self.command(f'play black {cell(black[-1])}')

        output = self.command(f'kata-raw-nn {symmetry}').split('\n')
        white_win = float(next(l for l in output if l.startswith('whiteWin')).split()[1])
        start = output.index('policy') + 1
        policy = np.array([[float(v) for v in row.split()] for row in output[start:start + size]], np.float64)
        return white_win, policy

    def close(self):
        self.process.stdin.write('quit\n')
        self.process.stdin.flush()
        self.process.wait()


def features(size: int, black: list, white: list, white_to_play: bool) -> tuple:
    spatial = np.zeros((1, NUM_SPATIAL, size, size), np.float32)
    glob = np.zeros((1, NUM_GLOBAL), np.float32)
    spatial[0, 0] = 1.0
    pla, opp = (white, black) if white_to_play else (black, white)
    for x, y in pla:
        spatial[0, 1, y, x] = 1.0
    for x, y in opp:
        spatial[0, 2, y, x] = 1.0
    glob[0, 0] = 1.0 if white_to_play else 0.0
    # Same as katahex nneval.cpp: board is transposed when white plays, so player to play always connects top and bottom
    if white_to_play:
        spatial = np.ascontiguousarray(spatial.transpose(0, 1, 3, 2))
    return spatial, glob


def random_position(size: int, rng: random.Random) -> tuple:
    cells = [(x, y) for y in range(size) for x in range(size)]
    rng.shuffle(cells)
    count = rng.randint(0, max(1, size * size // 4))
    white_to_play = count % 2 == 1
    stones = cells[:count]
    return stones[0::2], stones[1::2], white_to_play


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('katahex')
    parser.add_argument('model')
    parser.add_argument('onnx')
    parser.add_argument('--config', default='out/compare.cfg')
    parser.add_argument('--sizes', type=int, nargs='+', default=[5, 7, 11, 14, 19, 27, 32])
    parser.add_argument('--positions', type=int, default=3)
    parser.add_argument('--seed', type=int, default=1)
    parser.add_argument('--tolerance', type=float, default=1e-3, help='Max policy and whiteWin difference, higher for fp16')
    args = parser.parse_args()

    rng = random.Random(args.seed)
    session = ort.InferenceSession(args.onnx, providers=['CPUExecutionProvider'])
    katahex = Katahex(args.katahex, args.model, args.config)

    worst_policy = 0.0
    worst_value = 0.0

    try:
        for size in args.sizes:
            for _ in range(args.positions):
                black, white, white_to_play = random_position(size, rng)
                kata_white_win, kata_policy = katahex.raw_nn(size, black, white, white_to_play)

                spatial, glob = features(size, black, white, white_to_play)
                policy_logits, value_logits = session.run(['policy', 'value'], {'spatial': spatial, 'global': glob})

                # Same postprocessing as katahex nneval.cpp: softmax over cells legal for katahex
                logits = policy_logits[0, :size * size].reshape(size, size).astype(np.float64)
                if white_to_play:
                    logits = logits.T
                legal = ~np.isnan(kata_policy)
                logits = np.where(legal, logits, -np.inf)
                policy = np.exp(logits - logits[legal].max())
                policy /= policy.sum()

                value = np.exp(value_logits[0] - value_logits[0].max())
                value /= value.sum()
                win, loss = value[0], value[1]
                white_win = win if white_to_play else loss

                policy_diff = float(np.abs(policy[legal] - kata_policy[legal]).max())
                value_diff = abs(white_win - kata_white_win)
                worst_policy = max(worst_policy, policy_diff)
                worst_value = max(worst_value, value_diff)

                same_best = np.unravel_index(np.nanargmax(kata_policy), kata_policy.shape) == np.unravel_index(np.argmax(policy), policy.shape)

                print(
                    f'size {size:2} stones {len(black) + len(white):3} {"white" if white_to_play else "black"} to play'
                    f' | whiteWin katahex {kata_white_win:.6f} onnx {white_win:.6f} diff {value_diff:.2e}'
                    f' | policy max diff {policy_diff:.2e} | same best move {same_best}'
                )
    finally:
        katahex.close()

    print(f'Worst policy diff {worst_policy:.2e}, worst whiteWin diff {worst_value:.2e}')

    if not (math.isfinite(worst_policy) and worst_policy < args.tolerance and worst_value < args.tolerance):
        raise SystemExit('Differences too big')


if __name__ == '__main__':
    main()
