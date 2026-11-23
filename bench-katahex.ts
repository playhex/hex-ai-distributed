import './config';
import { runBench } from './src/shared/benchTasks';
import { loadEngineWorker } from './src/worker/engines';

/*
 * Durations of bench jobs with local katahex, to compare with web worker (web/stats.html).
 *
 * Run:
 * yarn ts-node bench-katahex.ts
 */

(async () => {
    const worker = await loadEngineWorker('katahex');
    const results = await runBench(task => worker.process(task));

    process.stderr.write(`${await worker.version()}\n`);

    for (const { type, size, durationMs } of results) {
        process.stderr.write(`${type.padEnd(36)} ${String(size).padStart(2)}x${size}  ${(durationMs / 1000).toFixed(2)}s\n`);
    }

    process.exit(0);
})();
