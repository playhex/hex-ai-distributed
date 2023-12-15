import { Express } from 'express';
import { createBullBoard } from '@bull-board/api';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { ExpressAdapter } from '@bull-board/express';
import { Queue } from 'bullmq';


const mountBullUI = (app: Express, path: string, queues: Queue[]) => {
    const serverAdapter = new ExpressAdapter();
    serverAdapter.setBasePath('/bull');

    createBullBoard({
        queues: queues.map(queue => new BullMQAdapter(queue)),
        serverAdapter: serverAdapter,
    });

    app.use(path, serverAdapter.getRouter());
};

export default mountBullUI;
