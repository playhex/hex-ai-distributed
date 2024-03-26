# Hex AI distributed

API that process Hex move by sending move calculation to peers.

## Install

```
yarn install
```

## Run

Needs redis, start a local instance with docker:

``` bash
docker run -p 6399:6379 redis
```

Then in `.env`, add:

```
REDIS_URL=0.0.0.0:6399
```

Then run server and/or a worker in separate processes:

```
node dist/server
node dist/worker
```

## With docker

``` bash
cp .env.docker .env

docker compose up
```

- Access bull UI: <http://0.0.0.0:8088/bull>

- To run only server or worker:

``` bash
# only server
docker compose up redis server

# only worker
docker compose up worker
```

- To test with multiple workers:

``` bash
docker compose up --scale worker=2
```

- To empty all redis queues

``` bash
docker compose run server sh -c "cd /app && yarn obliterate"
```

## API

Server can accept this request in order to process an AI move calculation through workers:

```
POST http://0.0.0.0:8088/calculate-move
Content-Type: application/json

{
    "game": {
        "size": 11,
        "currentPlayer": "black",
        "movesHistory": "e4 d6",
        "swapRule": false
    },
    "ai": {
        "engine": "mohex",
        "maxGames": 20
    }
}
```

Result:

```
f7
```

See all the possible HTTP requests in this postman collection:

<https://www.postman.com/alcalyn/workspace/hex/collection/32226212-905e39fc-27b0-4792-9634-88a2dba2de5c>

## Katahex

To use Katahex, you first need to install a pre-trained model, currently downloadable here:

<https://drive.google.com/file/d/1xMvP_75xgo0271nQbmlAJ40rvpKiFTgP/view>

See <https://github.com/selinger/katahex#running>.

Then place the `.bin.gz` model file in this repo, in `katahex/` folder to make it available in Docker.

## Other usages

If you just want to use preinstalled Hex AI engines in docker using command line,
you can run and enter in the worker container with:

``` bash
docker compose run worker bash

# Use Mohex
mohex

# Use Katahex
katahex gtp -config /app/katahex/config.cfg -model /app/katahex/katahex_model_20220618.bin.gz
```

Example:

```
$> docker compose run worker bash
$> mohex
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

## Architecture

- Rest API server (express)

Can request an API move, or game analysis.
This will send the job to the next fastest available peer.

Should be internal, or requires API key to prevent anyone abusing or spamming it.

- TCP server for peers (NodeJs.net)

Allow to a peer client to connect and accept jobs.
While connected, peer will receive jobs, and have to send result back.

Should be public to allow anyone contributing, still with personal api key to block peer sending invalid data.

## Build worker standalone docker image

To run a worker from an image with all inside (source code and katahex model),

- check there is a model in `./katahex/` folder, and is the one configured in `.env`

- then run:

``` bash
# build
docker build -f src/worker/Dockerfile.standalone -t alcalyn/hex-distributed-ai-worker:standalone .

# publish
docker push alcalyn/hex-distributed-ai-worker:standalone
```

## Start a worker

Pull or update worker:

``` bash
docker pull alcalyn/hex-distributed-ai-worker:standalone
```

- start a worker with:

``` bash
docker run -it alcalyn/hex-distributed-ai-worker:standalone

# (ctrl + C to stop it)
```

- start it in background:

``` bash
docker run -d --name hex-worker alcalyn/hex-distributed-ai-worker:standalone

# and stop it with:
docker rm -f hex-worker

# or show logs with:
docker logs -ft hex-worker
```

- run and enter in the container without running a worker:

``` bash
docker run -it alcalyn/hex-distributed-ai-worker:standalone bash
```
