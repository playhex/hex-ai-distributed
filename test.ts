import './config';
import { analyzeGame } from './src/worker/task/analyze-game';
import { analyzeMoveMcts } from './src/worker/task/mcts/mcts-analyze-move';
import { analyzePositionMcts } from './src/worker/task/mcts/mcts-analyze-position';
import { processJobKatahexMcts } from './src/worker/task/mcts/mcts-move';

/*
 * For testing while development.
 *
 * Run:
 * yarn ts-node test.ts
 *
 * Run with docker:
 * docker compose run katahex sh -c "cd /app && yarn ts-node test.ts"
 */

(async () => {
    const analyzeMoveInput = {
        color: 'black' as const,
        move: 'i5',
        moveIndex: 30,
        isLastMoveOfGame: false,
        movesHistory: 'h12 swap-pieces d11 e4 f4 e9 c10 d8 e8 d9 g8 f13 g11 e12 f10 h12 g13 g5 j5 c13 b10 b13 g12 g10 i9 h7 g7 h8 f11 h3',
        size: 14,
    };

    console.log('intuition game', await analyzeGame({ size: 14, movesHistory: `${analyzeMoveInput.movesHistory} ${analyzeMoveInput.move}` }));
    console.log('mcts', await analyzeMoveMcts({ ...analyzeMoveInput, maxPlayouts: 400 }));

    console.log('mcts position', await analyzePositionMcts({
        size: 13,
        color: 'white',
        black: 'c2 b5 b8 k10 j11',
        white: 'd11 k4 e10 k11',
        maxPlayouts: 400,
    }));

    console.log('mcts move', await processJobKatahexMcts({
        game: {
            size: 13,
            movesHistory: 'c2 d11 b5 k4 b8 e10 k10 k11 j11',
            currentPlayer: 'white',
            swapRule: true,
        },
        maxPlayouts: 400,
    }));

    console.log('done');
    process.exit(0);
})();
