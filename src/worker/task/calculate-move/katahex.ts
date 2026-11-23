import Katahex from '../../katahex-cli/Katahex';

const { KATAHEX_BIN } = process.env;

if (!KATAHEX_BIN) {
    throw new Error('Requires KATAHEX_BIN=... in .env file');
}

export const katahex = new Katahex(KATAHEX_BIN);
