import './config';
import { katahex } from './ai-client/katahex';


(async () => {
    console.log('Waiting for Katahex to be ready...');
    console.log(await katahex.version());
    console.log('Katahex ready');

    await katahex.transaction(async katahex => {
        await katahex.setBoardSize(14);
        await katahex.showboard();
    });

    await katahex.transaction(async katahex => {
        await katahex.setBoardSize(17);
        await katahex.showboard();
    });

    await katahex.version();

    await katahex.transaction(async katahex => {
        await katahex.setBoardSize(19);
        await katahex.showboard();
    });
})();
