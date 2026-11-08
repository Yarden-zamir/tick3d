# API benchmarks

`run.sh` runs one or more builds of the API server (`rust/server`) on the same seeded database and the same machine, for example the main branch against a change. It prints one JSON line per measurement, with the file name of each binary as `server`.

## Run it

```sh
cd rust && cargo build --release -p tick3d-server && cd ..
cp rust/target/release/tick3d-server /tmp/change
LIB=$(ls -td rust/target/release/build/libduckdb-sys-*/out | head -1)
SEED_FILE=/tmp/bench-seed.duckdb OHA=~/.cargo/bin/oha \
  nice -n 19 flock /tmp/tick3d-heavy.lock bench/run.sh "$LIB" 3 /tmp/main /tmp/change
```

- Build each binary from its own checkout, and give each one its own file name.
- `ONLY="stats-mine mixed"` measures only these.
- `SEED_FILE` keeps the seed between runs. Seeding takes about 3 minutes.
- The VPS is noisy. For an A/B comparison, run the binaries in turn several times, and compare the pairs.

## The units of a move, in process (2026-11-08)

`rust/server/src/benches.rs` measures each unit of a move inside the server process: no network, no proxy, and no limit per address. Run them in release mode, one at a time:

```sh
cd rust && BENCH_GAMES=1000 cargo test --release -p tick3d-server bench_ -- --ignored --nocapture --test-threads 1
```

Each game is 7 moves; the 7th ends the game. Three runs on the VPS (load average 2 to 9 from other work):

| Unit | p50 | p90 | p99 | Rate |
|---|---|---|---|---|
| Rules (`rust/core`): one move on a document | 2 µs | 3–4 µs | 4–21 µs | 260,000–580,000 / s |
| Store: one move (load, rules, save in memory, view), through the store thread | 136 µs | 0.6 ms | 5.7 ms | 2,070 / s |
| Router: one move request (body, checks, handler, store, JSON) | 208 µs | 2.4 ms | 18.6 ms | 735 / s, one at a time |
| Store or router: the move that ends a game | 380–390 ms | 570–640 ms | 0.9–1.0 s | its answer waits for the result batch |
| Fan-out: one move to 10 open pages | 1.7–9 ms | | 25 ms | |
| Fan-out: to 100 open pages | 62–75 ms | | 141 ms | |
| Fan-out: to 1,000 open pages | 3.9–4.5 s | | 6.0 s | |

What the numbers say:

- The rules cost nothing next to the rest. A move spends most of its time in the store job (the session load, the save and the view) and in the request around it.
- One store thread handles about 2,000 moves per second. All the online play of the launch fits in that by a wide margin.
- The move that ends a game answers after the finished game is in DuckDB (the result batch waits up to 200 ms, then writes). Its opponent gets the view at once; only the mover waits.
- Limit: the fan-out grows with the square of the open pages of one session. Each page with its own token gets its own view, and each view lists every watcher, so 1,000 watchers of one game cost about 4 s per move. 100 watchers cost about 70 ms. Revisit when one game draws hundreds of watchers: send one view to all watchers without a seat.

## Launch load without the network (2026-11-08)

`run.sh` runs the release server on the seeded database (40,000 games) on this machine. Each pair of players has its own address, so no limit takes part. `PAIRS` and `ROUNDS` set the size of the game loop; every pair moves without a pause, which is far harsher than real players.

```sh
PAIRS=200 ROUNDS=3 ONLY=interaction-ws SEED_FILE=/tmp/bench-seed.duckdb bench/run.sh "$LIB" 1 /tmp/main
```

| Pairs (players) | Moves | Moves/s | Move p50 / p90 / p99 | Delivery p50 / p90 / p99 | Server CPU | Peak memory |
|---|---|---|---|---|---|---|
| 20 (40) | 420 | 93 | 24 / 365 / 911 ms | 36 / 56 / 312 ms | 1.6 s in 4.5 s | 118 MB |
| 200 (400) | 4,200 | 394 | 134 / 403 / 1,723 ms | 175 / 389 / 1,570 ms | 8.3 s in 10.7 s | 213 MB |

- 400 players who all move at once still get a median answer of 134 ms; the server used less than one core of four.
- The load average of the VPS was 5 to 6.6 from other work during the run, so the numbers are worse than on a quiet machine.

## Launch load on a preview (2026-11-05)

`preview-load.sh` runs the game loop over the WebSocket against a deployed site while `oha` reads the stats, the leaderboard and the page at about 20 requests per second. It is the end-to-end check through Cloudflare and Caddy. It stops when production health slows down. The client ran on the VPS, so each request went out to Cloudflare and back.

```sh
OHA=~/.cargo/bin/oha bench/preview-load.sh https://tick3d-pr-279.yarden-zamir.com 50 1 60
```

| Measure | Result |
|---|---|
| 50 online games at the same time (100 players), 350 moves over the WebSocket | all done, 56 moves/s |
| Move answer p50 / p90 / p99 | 66 / 549 / 752 ms |
| Delivery to the opponent p50 / p90 / p99 | 70 / 321 / 752 ms |
| Reads at 21 requests/s: stats, leaderboard, page p50 / p99 | 36–48 / 300–476 ms, all 200 |
| Production health during the run | median 0.20 s, max 0.40 s; the guard did not stop the run |

All 50 games started in the same second and moved without a pause, which is harsher than real players.

Limits:

- The limits count per player since #293, with 20 times as much per address. One machine can still start only 1,200 games per hour per site, so a larger end-to-end test needs more client addresses.
- The counts live in memory and reset with each deploy (`rust/server/src/limits.rs`).
- Previews and production share the 4 cores of the VPS.

The results below compare the Node API, which this repository removed after the Rust server went live on 2026-11-04, with the Rust API. They stay as the record of that switch.

## Method

| Item | Value |
|---|---|
| Machine | The tick3d VPS: 4 cores, 16 GB. Production runs on it too, so the numbers have noise. |
| CPUs | Servers on CPUs 0-1, load tools on CPUs 2-3 (`taskset`). Everything at `nice 19` under the shared lock. |
| Builds | Node 24 with type stripping, DuckDB 2.0.0 (`@duckdb/node-api` 2.0.0-r.1). Rust release build, duckdb crate 1.20000.1 (DuckDB 2.0.0). |
| Data | 400 players with 100 finished games each (40,000 results), from `seed.ts`. One seed file, copied for each server. |
| HTTP load | `oha` 1.15.0. 3 s warmup (not counted), then 3 runs of 10 s. Tables show the median run. |
| Game loop | `interaction.ts`: 20 pairs play 10 online games each (1,400 moves) at the same time. "move" is a move request until its answer. "delivery" is a move request start until the opponent's event stream or long poll shows the new version. |
| Mixed | The game loop while 4 connections load `GET /api/stats?scope=mine`. |
| Resources | Startup: from spawn to the first 200 of `/api/health`. RSS and peak RSS from `/proc/<pid>/status`. Server CPU seconds from `/proc/<pid>/stat`. |

## Results (2026-11-03, commit after 7b303c9)

| Measure | Node | Rust |
|---|---|---|
| Startup to first health 200 | 1,963 to 4,575 ms | 341 to 883 ms |
| RSS after start | 177 to 184 MB | 71 to 72 MB |
| Peak RSS over the run | 570 to 600 MB | 235 to 268 MB |
| `GET /api/health`, 32 connections | 3,945 rps, p50 5.6 ms, p99 36 ms | 16,586 rps, p50 0.77 ms, p99 16 ms |
| `GET /api/stats` Everyone (cached), 32 connections | 172 rps, p50 164 ms, p99 593 ms | 5,407 rps, p50 3.8 ms, p99 45 ms (600 rps, p50 45 ms before byte snapshots) |
| `GET /api/leaderboard` (cached), 32 connections | 484 rps, p50 57 ms | 3,954 rps, p50 4.9 ms (447 rps, p50 60 ms before byte snapshots) |
| `GET /api/me/history`, 16 connections | 15.8 rps, p50 995 ms | 17.7 rps, p50 902 ms |
| `GET /api/stats?scope=mine`, 4 connections | 0.6 to 1.5 rps, p50 2.7 to 9.6 s | 7.8 rps, p50 439 ms (2026-11-04, counted in Rust; 2.2 to 2.6 rps, p50 1.5 to 2.1 s with the SQL path) |
| Game loop, event stream: moves/s | 102 to 182 | 114 to 187 |
| Game loop, event stream: move p50 / p90 / p99 | 39-66 / 318-381 / 468-673 ms | 32-58 / 326-367 / 420-800 ms |
| Game loop, event stream: delivery p50 / p90 / p99 (2026-11-04) | 32 / 72 / 154 ms | 28-48 / 65-187 / 150-322 ms |
| Game loop, long poll: moves/s | 154 to 196 | 113 to 171 |
| **Mixed: moves/s** | **19 to 20** | **66 to 125** |
| **Mixed: move p90 / p99** | **564-3,214 / 5,435-6,232 ms** | **328-442 / 583-1,181 ms** |
| Mixed: delivery p90 / p99 (2026-11-04) | 464-2,770 / 6,210-12,386 ms | 107-256 / 446-807 ms |

Ranges are the values of separate runs. The raw JSON lines of every run are in `results.jsonl`.

## Transport: WebSocket against the event stream (2026-11-04, PR #275 at 64806e3)

The game loop on the Rust server only, 3 runs per channel on fresh copies of the same seed. `ws`: one socket per player
for the moves and the views; create and join stay on HTTP, because the limit of new games counts per address. `sse`: a
request per move and an event stream per player, as the page did before. `poll`: the agent API.

| Channel | Moves/s (3 runs) | Move p50 / p90 / p99 | Delivery p50 / p90 / p99 | Server CPU |
|---|---|---|---|---|
| WebSocket | 134 (102, 134, 152) | 21 / 421 / 769 ms | 32 / 74 / 293 ms | 7.4 s |
| Event stream and HTTP moves | 113 (99, 113, 135) | 58 / 368 / 777 ms | 50 / 166 / 321 ms | 5.9 s |
| Long poll | 138 (129, 138, 150) | 52 / 355 / 576 ms | 53 / 155 / 346 ms | 4.2 s |

- The socket cuts the median move answer from 58 to 21 ms, and the median delivery from 50 to 32 ms (p90 166 to 74 ms).
- Moves per second show no reliable difference: the ranges of the runs overlap.
- The p90 and p99 of a move stay about the same in every channel: they come from the move that ends a game, which waits
  for the 200 ms result batch.
- The socket used about 27 % more server CPU in these runs: each action goes through the router a second time. One test,
  with a wide spread.
- Long polls serve the agent API about as well as the event stream does.

## What the numbers say

- Rust starts about 4 to 5 times faster and uses about half the memory.
- Small answers are about 4 times faster. Cached answers were only 1 to 3.5 times faster while Rust rebuilt the JSON on every request; the snapshots now keep the serialized bytes, which makes the Everyone stats about 30 times and the leaderboard about 8 times faster than Node.
- The biggest gain is architectural. Node runs personal stats on its one store queue, so about 0.5 s of queries hold up the moves of every player. Rust runs them on a second connection (the reader). Under stats load, the move p99 drops from 5.4 s to 0.8 s.
- Personal stats were slow in both servers: about 0.5 s of DuckDB queries per answer (about 30 statements of 10 to 40 ms each). A cached prepare did not change it. Rust now reads the player's games once and counts in memory (store/personal.rs): about 3 times more answers per second than its SQL path, and about 10 times more than Node. A test compares both paths on the same data. History is still slow in both servers.
- The plain game loop shows no reliable difference: the ranges of separate runs overlap, and in one run on 2026-11-04 Node did more moves per second than Rust.
- Delivery to the opponent is much faster than the move answer: p90 65 to 190 ms against about 330 ms. Only the move that ends a game waits for the result batch, and only its own answer waits.
- The move p90 of about 350 ms in both servers comes from the move that ends a game: its answer waits up to 200 ms for the result batch. A commit per finished game made it worse (moves/s halved, p50 doubled), so the batch stays.

## Caveats

- One shared VPS with production on it. Single runs vary a lot (health: 6,259 to 22,234 rps in one series).
- The game loop runs once per series, not 3 times.
- Before 2026-11-04, `interaction.ts` took the delivery time after the move answer, so the earlier delivery numbers were too high. Only the rows marked 2026-11-04 use the fixed client.
- The load client of the game loop runs on Node. It is the same client for every server.
- The Node server ran from a folder of symlinks with `--preserve-symlinks`.
