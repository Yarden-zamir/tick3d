# API benchmarks: Node against Rust

`run.sh` runs the Node API (`server/`) and the Rust API (`rust/server`) on the same seeded database and the same machine. It prints one JSON line per measurement.

## Run it

```sh
cd rust && cargo build --release -p tick3d-server && cd ..
LIB=$(ls -td rust/target/release/build/libduckdb-sys-*/out | head -1)
SEED_FILE=/tmp/bench-seed.duckdb OHA=~/.cargo/bin/oha \
  nice -n 19 flock /tmp/tick3d-heavy.lock bench/run.sh <node app dir> rust/target/release/tick3d-server "$LIB" 3
```

- The node app dir holds `server/`, `src/` and a `node_modules` with every server package.
- `ONLY="stats-mine mixed"` measures only these. `SERVERS=rust` runs only one server.
- `SEED_FILE` keeps the seed between runs. Seeding takes about 3 minutes.

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
| `GET /api/stats?scope=mine`, 4 connections | 0.6 to 1.5 rps, p50 2.7 to 9.6 s | 2.2 to 2.6 rps, p50 1.5 to 2.1 s |
| Game loop, event stream: moves/s | 102 to 182 | 114 to 187 |
| Game loop, event stream: move p50 / p90 / p99 | 39-66 / 318-381 / 468-673 ms | 32-58 / 326-367 / 420-800 ms |
| Game loop, event stream: delivery p50 / p90 / p99 (2026-11-04) | 32 / 72 / 154 ms | 28-48 / 65-187 / 150-322 ms |
| Game loop, long poll: moves/s | 154 to 196 | 113 to 171 |
| **Mixed: moves/s** | **19 to 20** | **66 to 86** |
| **Mixed: move p90 / p99** | **1,971-3,214 / 5,435-6,173 ms** | **435-442 / 784-1,181 ms** |
| Mixed: delivery p90 / p99 (2026-11-04) | 2,770 / 6,210 ms | 256 / 807 ms |

Ranges are the values of separate runs. The raw JSON lines of every run are in `results.jsonl`.

## What the numbers say

- Rust starts about 4 to 5 times faster and uses about half the memory.
- Small answers are about 4 times faster. Cached answers were only 1 to 3.5 times faster while Rust rebuilt the JSON on every request; the snapshots now keep the serialized bytes, which makes the Everyone stats about 30 times and the leaderboard about 8 times faster than Node.
- The biggest gain is architectural. Node runs personal stats on its one store queue, so about 0.5 s of queries hold up the moves of every player. Rust runs them on a second connection (the reader). Under stats load, the move p99 drops from 5.4 s to 0.8 s.
- Personal stats and history are still slow in both servers: about 0.5 s of DuckDB queries per answer (about 30 statements of 10 to 40 ms each). A cached prepare did not change it. Next step: read the player's rows once and count in Rust.
- The plain game loop shows no reliable difference: the ranges of separate runs overlap, and in one run on 2026-11-04 Node did more moves per second than Rust.
- Delivery to the opponent is much faster than the move answer: p90 65 to 190 ms against about 330 ms. Only the move that ends a game waits for the result batch, and only its own answer waits.
- The move p90 of about 350 ms in both servers comes from the move that ends a game: its answer waits up to 200 ms for the result batch. A commit per finished game made it worse (moves/s halved, p50 doubled), so the batch stays.

## Caveats

- One shared VPS with production on it. Single runs vary a lot (health: 6,259 to 22,234 rps in one series).
- The game loop runs once per series, not 3 times.
- Before 2026-11-04, `interaction.ts` took the delivery time after the move answer, so the earlier delivery numbers were too high. Only the rows marked 2026-11-04 use the fixed client.
- The load client of the game loop is Node. It is the same client for both servers.
- The Node server runs from a folder of symlinks with `--preserve-symlinks`, as in the parity scripts.
