# Web worker

A page anyone can open to contribute GPU to PlayHex: it runs Katahex tree search in the browser,
for `katahex-mcts-*` jobs (bot moves with tree search, deep analyses), then `katahex-intuition-*` jobs (raw neural network output).

Published on GitHub Pages from `docs/`: https://playhex.github.io/hex-ai-distributed/

- Player logs in with PlayHex OAuth (scope `read:ai-worker-keys`) to get their AI worker keys.
- Model `hex27x3` converted to ONNX (see `../model-conversion/`), run with onnxruntime-web and WebGPU (float16 if supported, else float32). A hardware GPU is required: tree search is too slow on CPU.
- Tree search from `../mcts/`, job logic shared with the docker worker (`../src/worker/task/mcts/` and `../src/worker/task/intuition/`).
- Stats are only kept in this browser (localStorage).

## Develop

``` bash
cd web
pnpm install
cp .env.dist .env   # local PlayHex on port 13000, only for pnpm dev

pnpm dev
```

Requires on PlayHex:

- an OAuth public client, with redirect uri the page url:

    ``` bash
    pnpm hex oauth:create-client --client-id hex-web-worker --name "PlayHex web worker" --author PlayHex \
        --logo https://playhex.org/images/logo-transparent.svg --public \
        --redirect-uri http://localhost:5180/ --redirect-uri https://playhex.github.io/hex-ai-distributed/ \
        --scope "openid read:ai-worker-keys"
    ```

- models in `var/katahex-models/` (served at `/katahex-models/`): `hex27x3.fp16.onnx`,
  `hex27x3.onnx` (float32, for GPUs without float16), and the page origin in `CORS_ALLOWED_ORIGINS`.

## Test

``` bash
pnpm test   # mcts/ and web/ tests, model tests skipped if model-conversion/out/hex27x3.onnx is missing

# Compare tree search with native katahex
KATAHEX_BIN=/path/to/katahex KATAHEX_MODEL=/path/to/hex27x3.bin.gz pnpm test compareKatahexSearch
```

## Benchmark

"Run benchmark" on `stats.html`: one job of each type on 11×11, same positions on every computer.

Same jobs with local katahex, from repository root with KATAHEX_BIN in .env:

``` bash
yarn ts-node bench-katahex.ts
```

## Publish

``` bash
pnpm build:playhex   # to ../docs, with .env.playhex.prod only
```

Commit `docs/`, GitHub Pages serves it from master branch, `/docs` folder.
onnxruntime wasm is loaded from jsdelivr, model from PlayHex.
