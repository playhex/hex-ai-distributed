import './config';
import { analyzesQueue } from './src/shared/queue/analyze';
import { workerTasksQueue } from './src/shared/queue/workerTasks';

(async () => {
    await analyzesQueue.obliterate({ force: true });
    await workerTasksQueue.obliterate({ force: true });

    console.log('done');
    process.exit(0);
})();
