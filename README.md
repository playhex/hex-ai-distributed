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

## Other usages

If you just want to use preinstalled Hex AI engines in docker using command line,
you can run and enter in the worker container with:

``` bash
docker compose run worker bash

# then you can use AI engines
mohex genmove black
```

output:

```
MoHex 2.0.CMake Dec 14 2023
Copyright (C) 2007-2012 by the authors of the Benzene project.
...
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
