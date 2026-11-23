"""
Dumps katahex "kata-raw-nn" outputs on random positions, as test fixtures for mcts/ (legal moves, features).

Usage:
    PYTHONPATH=.deps python3 dump_fixtures.py KATAHEX_BINARY MODEL.bin.gz ../mcts/test/fixtures/katahex-raw-nn.json
"""

import argparse
import json
import math
import random

from compare import Katahex, random_position


def to_json(policy) -> list:
    return [[None if math.isnan(v) else round(float(v), 6) for v in row] for row in policy]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('katahex')
    parser.add_argument('model')
    parser.add_argument('output')
    parser.add_argument('--config', default='out/compare.cfg')
    parser.add_argument('--sizes', type=int, nargs='+', default=[5, 7, 9, 11, 14, 19])
    parser.add_argument('--positions', type=int, default=6)
    parser.add_argument('--seed', type=int, default=2)
    args = parser.parse_args()

    rng = random.Random(args.seed)
    katahex = Katahex(args.katahex, args.model, args.config)
    fixtures = []

    try:
        for size in args.sizes:
            for _ in range(args.positions):
                black, white, white_to_play = random_position(size, rng)
                white_win, policy = katahex.raw_nn(size, black, white, white_to_play)
                white_win_1, policy_1 = katahex.raw_nn(size, black, white, white_to_play, symmetry=1)
                fixtures.append({
                    'size': size,
                    'black': black,
                    'white': white,
                    'whiteToPlay': white_to_play,
                    'whiteWin': round(white_win, 6),
                    # Rows (y) of cells (x), null for cells katahex does not play
                    'policy': to_json(policy),
                    # Same with symmetry 1 (180° rotation)
                    'whiteWin1': round(white_win_1, 6),
                    'policy1': to_json(policy_1),
                })
    finally:
        katahex.close()

    with open(args.output, 'w') as f:
        json.dump(fixtures, f, separators=(',', ':'))

    print(f'Wrote {len(fixtures)} positions to {args.output}')


if __name__ == '__main__':
    main()
