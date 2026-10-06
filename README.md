# Hex AI workers

Workers computing Hex AI tasks for [PlayHex](https://playhex.org): bot moves, game analyses, Hexplorer position analyses.

Each worker runs one engine (Katahex, Mohex or Davies), pulls jobs from a PlayHex server over HTTPS, and sends results back.
Run more workers to process more jobs, from any machine: no port to open, no VPN.

```
PlayHex server, one queue per job type          <-- HTTPS long-polling, api key --

  [katahex-intuition-move]              ─┐
  [katahex-intuition-analyze-position]   ├──  worker katahex (x N)
  [katahex-intuition-analyze-game]      ─┘
  [katahex-mcts-move]                   ─┐
  [katahex-mcts-analyze-position]        ├··  only workers with AI_JOB_TYPES including them
  [katahex-mcts-analyze-move]           ─┘
  [mohex]                               ────  worker mohex   (x N)
  [davies]                              ────  worker davies  (x N)
```

A worker processes default job types of its engine, or the ones listed in `AI_JOB_TYPES`.
Tree search job types (`katahex-mcts-*`) require more computing power: they are not processed by default,
list them explicitly on a powerful computer:

``` bash
docker run --rm -e AI_WORKER_KEY=<key> -e AI_JOB_TYPES=katahex-intuition-move,katahex-mcts-move,katahex-intuition-analyze-position,katahex-mcts-analyze-position,katahex-intuition-analyze-game,katahex-mcts-analyze-move playhex/worker-katahex
```

Tree search is limited by the `maxPlayouts` sent by the server in each `katahex-mcts-*` job.

Server gives jobs by job type priority (bot moves, then Hexplorer positions, then game analyzes), then oldest first.
A job type without any worker does not block other job types.

## Contribute computing power

1. Ask PlayHex admins for a key. Your keys are shown in your PlayHex settings, "AI workers" panel.
2. Run a worker with Docker:

``` bash
docker run --rm -e AI_WORKER_KEY=<key> playhex/worker-katahex
```

Or with docker compose, from this repo:

``` bash
echo "AI_WORKER_KEY=<key>" > .env

docker compose up katahex

# Run 3 katahex workers and a mohex worker
docker compose up --scale katahex=3 katahex mohex
```

Stop a worker with Ctrl+C: it finishes its current job before stopping.
Press Ctrl+C again to stop immediately, the job is then given to another worker.

A killed worker is fine too: server gives its job to another worker after 30 seconds without heartbeat.

### Without Docker, with your own Katahex build

Useful to run Katahex on a GPU: Docker image uses the CPU backend (Eigen), much slower.

Requires Node 22 and yarn.

1. Compile Katahex:

``` bash
git clone https://github.com/playhex/katahex
cd katahex/
mkdir build && cd build

# Choose one backend:
cmake -DUSE_BACKEND=CUDA -DMAX_BOARD_LEN=32 ../cpp      # NVIDIA GPU, requires CUDA and cuDNN
cmake -DUSE_BACKEND=TENSORRT -DMAX_BOARD_LEN=32 ../cpp  # NVIDIA GPU, faster, requires CUDA and TensorRT
cmake -DUSE_BACKEND=OPENCL -DMAX_BOARD_LEN=32 ../cpp    # Any GPU (AMD, Intel, NVIDIA), requires OpenCL (i.e ocl-icd-opencl-dev)
cmake -DUSE_BACKEND=EIGEN -DMAX_BOARD_LEN=32 ../cpp     # CPU only, requires libeigen3-dev

make -j4
```

Build also requires `libzip-dev` and `zlib1g-dev`.
See [KataGo compiling instructions](https://github.com/lightvector/KataGo/blob/master/Compiling.md) for backends dependencies.

Check it answers, with the model (see [Katahex](#katahex) to download it):

``` bash
./katahex gtp -config <this repo>/katahex/config.cfg -model <this repo>/katahex/katahex_model_20220618.bin.gz

version
boardsize 11
genmove b
quit
```

2. Install the worker, from this repo:

``` bash
yarn install
cp .env.dist .env
```

3. In `.env`, set your key, and the command to run your Katahex build (absolute paths):

``` bash
ENGINE=katahex
HEX_URL=https://playhex.org
AI_WORKER_KEY=<key> # Ai worker key, ask PlayHex admin, or for a local instance, generate one, see playhex Readme: ### Play with AI
KATAHEX_BIN="/path/to/katahex/build/katahex gtp -config /path/to/hex-ai-distributed/katahex/config.cfg -model /path/to/hex-ai-distributed/katahex/katahex_model_20220618.bin.gz"

# Make your worker accept all jobs (or only "-intuition-" and/or "-mcts-" ones):
AI_JOB_TYPES=katahex-intuition-move,katahex-mcts-move,katahex-intuition-analyze-position,katahex-mcts-analyze-position,katahex-intuition-analyze-game,katahex-mcts-analyze-move
```

Values in `.env` override env vars set in your shell.

4. Build and run the worker:

``` bash
yarn build
node dist/src/worker
```

`yarn build` copies `.env` into `dist/`: build again after changing `.env`.

Adjust `katahex/config.cfg` to your computer: `numSearchThreads`, `nnCacheSizePowerOfTwo` (memory),
`nnMaxBatchSize` (positions evaluated at once by the GPU when analyzing a game),
and for multiple GPUs `numNNServerThreadsPerModel` and `gpuToUseThread*`.

Game analyzes (`katahex-intuition-analyze-game`) require a Katahex build with the `kata-raw-nn-batch` command, from the [playhex fork](https://github.com/playhex/katahex).
With an older build, the worker logs a warning and does not process them.

## Development

Requires Node 22.

``` bash
yarn install
cp .env.dist .env
```

In `.env`, set the engine to run, the hex server url, and a key.
Create a key from the hex repo with `pnpm hex ai-worker-key:create <player id or slug>`.

Then run a worker:

``` bash
yarn worker

# Or override engine
ENGINE=mohex yarn worker
```

Engines binaries must be installed locally (see `MOHEX_BIN` and `KATAHEX_BIN` in `.env`),
except Davies which is a javascript library.

Run tests with:

``` bash
yarn test
```

## Build and publish Docker images

There is one image per engine, built from the same `Dockerfile` with a different target:

| Engine  | Target    | Image                    |
|---------|-----------|--------------------------|
| Katahex | `katahex` | `playhex/worker-katahex` |
| Mohex   | `mohex`   | `playhex/worker-mohex`   |
| Davies  | `davies`  | `playhex/worker-davies`  |

Mohex version is pinned in `Dockerfile` (`MOHEX_COMMIT`):
it is the last working commit, more recent ones are buggy.

Katahex image requires the model file in `katahex/` folder, see [Katahex](#katahex) below.

### Build

``` bash
docker build --target katahex -t playhex/worker-katahex .
docker build --target mohex -t playhex/worker-mohex .
docker build --target davies -t playhex/worker-davies .

# Or build all
docker compose build
```

First build compiles Mohex and Katahex, it takes several minutes. Next builds use Docker cache.

Check the images before publishing:

``` bash
# Engines start and answer
printf 'name\nversion\nboardsize 5\ngenmove b\nquit\n' | docker run --rm -i playhex/worker-mohex mohex
printf 'name\nversion\nquit\n' | docker run --rm -i playhex/worker-katahex katahex gtp -config /app/katahex/config.cfg -model /app/katahex/katahex_model_20220618.bin.gz

# Workers connect to a local hex server and process jobs
docker run --rm --network host -e HEX_URL=http://localhost:3000 -e AI_WORKER_KEY=<key> playhex/worker-katahex
```

### Publish

Log in to Docker Hub with an account allowed to push to the `playhex` organization:

``` bash
docker login
```

Tag each image with a version (here the git commit) and `latest`, then push both tags:

``` bash
VERSION=$(git rev-parse --short HEAD)

for ENGINE in katahex mohex davies; do
    docker build --target $ENGINE -t playhex/worker-$ENGINE:$VERSION -t playhex/worker-$ENGINE:latest .
    docker push playhex/worker-$ENGINE:$VERSION
    docker push playhex/worker-$ENGINE:latest
done
```

Contributors get the new version with `docker pull playhex/worker-katahex` (or `docker compose pull`), then restart their worker.
To rollback, push again an older version as `latest`:

``` bash
docker pull playhex/worker-katahex:<old version>
docker tag playhex/worker-katahex:<old version> playhex/worker-katahex:latest
docker push playhex/worker-katahex:latest
```

### Publish for ARM (Apple Silicon, Raspberry Pi...)

Images above are built for your machine architecture (usually `linux/amd64`).
They still run on ARM computers through emulation, but slowly.
To publish multi-architecture images, use buildx (building ARM on amd64 is emulated, so it takes a long time):

``` bash
docker buildx create --use --name playhex-builder

for ENGINE in katahex mohex davies; do
    docker buildx build --platform linux/amd64,linux/arm64 --target $ENGINE \
        -t playhex/worker-$ENGINE:$VERSION -t playhex/worker-$ENGINE:latest --push .
done
```

## Katahex

To use Katahex, you first need to install a pre-trained model, currently downloadable here:

<https://drive.google.com/file/d/1xMvP_75xgo0271nQbmlAJ40rvpKiFTgP/view>

See <https://github.com/selinger/katahex#running>.

Then place the `.bin.gz` model file in `katahex/` folder, it is required to build the katahex image.

## Use engines from command line

``` bash
docker run --rm -it playhex/worker-mohex mohex

docker run --rm -it playhex/worker-katahex katahex gtp -config /app/katahex/config.cfg -model /app/katahex/katahex_model_20220618.bin.gz
```

Example:

```
$> docker run --rm -it playhex/worker-mohex mohex
MoHex 2.0.CMake Dec 14 2023
Copyright (C) 2007-2012 by the authors of the Benzene project.
...

boardsize 5
=

showboard
=

  e1275ef128b3b312
  a  b  c  d  e
 1\.  .  .  .  .\1
  2\.  .  .  .  .\2
   3\.  .  .  .  .\3
    4\.  .  .  .  .\4
     5\.  .  .  .  .\5
        a  b  c  d  e

```

## Protocol

See `src/shared/protocol.ts`, copied from hex repo (`src/server/ai-jobs/protocol.ts`).

- `POST /api/ai-workers/jobs/next`: get next job among job types sent in `types`. Server holds the request up to 25 seconds when there is no job, then responds 204.
- `POST /api/ai-workers/jobs/:jobId/heartbeat`: every 10 seconds while processing a job, else job is given to another worker.
- `POST /api/ai-workers/jobs/:jobId/result`: send result. Server validates it (legal move...).
- `POST /api/ai-workers/jobs/:jobId/fail`: task could not be processed. `retryable: true` to give it to another worker.

Server responds 409 if job has been given to another worker meanwhile, and 401 if key is invalid or revoked.
