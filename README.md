# Hex AI distributed

API that process Hex move by sending move calculation to peers.

## Install

```
yarn install
yarn tsc --watch
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
cp src/server/.env.docker src/server/.env
cp src/worker/.env.docker src/worker/.env

docker compose up

# or test with multiple workers
docker compose up --scale worker=2
```

## API

Server can accept this request in order to process an AI move calculation through workers:

```
POST http://0.0.0.0:3434/calculate-move
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

## Architecture

Starts two servers on different ports:

- Rest API server (express)

Can request an API move (or later game analysis).
This will send the job to the next fastest available peer.

Can be internal or requiring API key to prevent anyone abusing it / spamming.

- TCP server for peers (NodeJs.net)

Allow to a peer client to connect and accept jobs.
While connected, peer will receive jobs, and have to send result back.
Job are sent one by one, or maybe queuing max two to prevent waiting back/forth between result and new job ?

Should be public to allow anyone contributing, still with personal api key to block peer sending invalid data.
