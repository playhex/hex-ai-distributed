import './config';
import { analyzeMove } from './src/worker/task/analyze-move';

/*
 * For testing while development.
 *
 * Run:
 * yarn ts-node test.ts
 *
 * Run with docker:
 * docker compose run worker sh -c "cd /app && yarn ts-node test.ts"
 */

(async () => {
    const output = await analyzeMove({
        color: 'black',
        move: 'i5',
        moveIndex: 30,
        isLastMoveOfGame: false,
        movesHistory: 'h12 swap-pieces d11 e4 f4 e9 c10 d8 e8 d9 g8 f13 g11 e12 f10 h12 g13 g5 j5 c13 b10 b13 g12 g10 i9 h7 g7 h8 f11 h3',
        size: 14,
    });

    console.log(output);

    console.log('done');
    process.exit(0);
})();
