/// <reference types="vitest" />
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';

const consoleLogger = fileURLToPath(new URL('./src/consoleLogger.ts', import.meta.url));

/**
 * onnxruntime wasm (~30MB) is loaded from jsdelivr instead, see worker.ts.
 */
const excludeOrtWasm = (): Plugin => ({
    name: 'exclude-ort-wasm',
    generateBundle(_, bundle) {
        for (const name of Object.keys(bundle)) {
            if (/ort-wasm.*\.wasm$/.test(name)) {
                delete bundle[name];
            }
        }
    },
});

/**
 * Variables of .env.<mode> only: build must not depend on developer .env.
 */
const modeEnv = (mode: string): Record<string, string> => {
    const lines = readFileSync(fileURLToPath(new URL(`./.env.${mode}`, import.meta.url)), 'utf8').split('\n');

    return Object.fromEntries(lines
        .map(line => line.trim())
        .filter(line => line !== '' && !line.startsWith('#'))
        .map(line => [`import.meta.env.${line.slice(0, line.indexOf('=')).trim()}`, JSON.stringify(line.slice(line.indexOf('=') + 1).trim())]));
};

export default defineConfig(({ command, mode }) => ({
    // Published on GitHub Pages: https://playhex.github.io/hex-ai-distributed/
    base: './',

    // .env in development, build:playhex reads .env.playhex.prod only
    envDir: command === 'build' ? false : '.',
    define: command === 'build' ? modeEnv(mode) : {},

    build: {
        outDir: '../docs',
        emptyOutDir: true,
        target: 'es2022',
        rollupOptions: {
            input: {
                main: fileURLToPath(new URL('./index.html', import.meta.url)),
                stats: fileURLToPath(new URL('./stats.html', import.meta.url)),
            },
        },
    },
    resolve: {
        alias: [
            // Shared worker code logs with winston, not available in browsers
            { find: /^.*\/shared\/logger$/, replacement: consoleLogger },
        ],
    },
    server: {
        // Fixed port, registered as OAuth redirect uri
        port: 5180,
        strictPort: true,
        fs: {
            // Shared code from ../src and ../mcts
            allow: ['..'],
        },
    },
    worker: {
        format: 'es',
        plugins: () => [excludeOrtWasm()],
    },
    plugins: [excludeOrtWasm()],
    optimizeDeps: {
        exclude: ['onnxruntime-web'],
    },
    test: {
        dir: '..',
        include: ['mcts/test/**/*.test.ts', 'web/test/**/*.test.ts'],
        testTimeout: 120_000,
    },
}));
