import assert from 'assert';
import path from 'path';
import GTPClient, { GTPClientError, GTPEngineError } from '../GTPClient';

const fakeEngine = `node ${path.join(__dirname, 'fake-gtp-engine.js')}`;

describe('GTPClient', () => {
    let gtpClient: GTPClient;

    beforeEach(() => {
        gtpClient = new GTPClient(fakeEngine, 500);
    });

    afterEach(() => {
        gtpClient.kill();
    });

    it('waits for full response when received in multiple chunks', async () => {
        assert.strictEqual(await gtpClient.sendCommand('echo', 'hello', 'world'), 'hello world');
    });

    it('returns multiline responses', async () => {
        assert.strictEqual(await gtpClient.sendCommand('multiline'), 'line1\nline2');
    });

    it('rejects on engine error response', async () => {
        await assert.rejects(gtpClient.sendCommand('fail'), GTPClientError);
    });

    it('rejects when engine does not answer in time, and spawns engine again on next command', async () => {
        await assert.rejects(gtpClient.sendCommand('sleep'), GTPEngineError);
        assert.strictEqual(await gtpClient.sendCommand('echo', 'back'), 'back');
    });

    it('rejects when engine crashes, and spawns engine again on next command', async () => {
        await assert.rejects(gtpClient.sendCommand('crash'), GTPEngineError);
        assert.strictEqual(await gtpClient.sendCommand('echo', 'back'), 'back');
    });
});
