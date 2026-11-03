#!/bin/bash
# Node against Rust on the same seeded database and the same machine. Prints one JSON line per measurement.
# Usage: bench/run.sh <node app dir> <rust binary> <libduckdb dir> [repetitions]
# - The node app dir holds server/ and a node_modules with every server package (the Node API runs from it).
# - Both servers run on CPUs 0-1, the load tools on CPUs 2-3, so they do not compete for a core.
# - Run it through the shared lock on the VPS: nice -n 19 flock /tmp/tick3d-heavy.lock bench/run.sh ...
set -euo pipefail
NODE_APP=$1; RUST_BIN=$2; DUCKDB_LIB=$3; REPS=${4:-3}
HERE=$(cd "$(dirname "$0")" && pwd); WORK=$(mktemp -d -t tick3d-bench-XXXXXX); PORT=18600
OHA=${OHA:-oha}; SERVER_CPUS=0,1; CLIENT_CPUS=2,3
trap 'stop; rm -rf "$WORK"' EXIT
PID=""

start() { # <node|rust> <db file>
  local db=$2 began; began=$(date +%s%N)
  if [ "$1" = node ]; then
    (cd "$NODE_APP" && DB_PATH=$db PORT=$PORT exec taskset -c $SERVER_CPUS node --preserve-symlinks --preserve-symlinks-main server/main.ts) > "$WORK/$1.log" 2>&1 &
  else
    (cd "$WORK" && DB_PATH=$db PORT=$PORT LD_LIBRARY_PATH=$DUCKDB_LIB exec taskset -c $SERVER_CPUS "$RUST_BIN") > "$WORK/$1.log" 2>&1 &
  fi
  PID=$!
  until curl -fs -o /dev/null "http://127.0.0.1:$PORT/api/health"; do sleep 0.02; done
  echo "{\"server\":\"$1\",\"measure\":\"startup\",\"ms\":$(( ($(date +%s%N) - began) / 1000000 )),\"rssKb\":$(rss)}"
}
stop() { if [ -n "$PID" ]; then kill -TERM "$PID" 2>/dev/null || true; wait "$PID" 2>/dev/null || true; PID=""; fi; }
rss() { awk '/VmRSS/ {print $2}' "/proc/$PID/status"; }
peak() { awk '/VmHWM/ {print $2}' "/proc/$PID/status"; }
# The CPU time of the server in clock ticks (user + system).
ticks() { awk '{print $14 + $15}' "/proc/$PID/stat"; }

# ONLY="stats-mine history" measures only these; SERVERS="rust" runs only these servers. Both default to all.
ONLY=${ONLY:-}; SERVERS=${SERVERS:-node rust}
wanted() { [ -z "$ONLY" ] || [[ " $ONLY " == *" $1 "* ]]; }

load() { # <server> <name> <connections> <path> [header]
  local server=$1 name=$2 connections=$3 path=$4 header=${5:-x-bench: 1}
  wanted "$name" || return 0
  # Warmup, not measured: fills caches and snapshots, and wakes the JIT of Node.
  taskset -c $CLIENT_CPUS "$OHA" --no-tui -z 3s -c "$connections" -H "$header" "http://127.0.0.1:$PORT$path" > /dev/null
  for rep in $(seq 1 "$REPS"); do
    local before; before=$(ticks)
    taskset -c $CLIENT_CPUS "$OHA" --no-tui -z 10s -c "$connections" -H "$header" --output-format json "http://127.0.0.1:$PORT$path" > "$WORK/oha.json"
    uv run - "$WORK/oha.json" "$server" "$name" "$connections" "$rep" "$(( $(ticks) - before ))" "$(getconf CLK_TCK)" <<'PY'
import json, sys
d = json.load(open(sys.argv[1])); s = d["summary"]; p = d["latencyPercentiles"]
codes = d.get("statusCodeDistribution", {})
ticks, hz = int(sys.argv[6]), int(sys.argv[7])
print(json.dumps({"server": sys.argv[2], "measure": sys.argv[3], "connections": int(sys.argv[4]), "rep": int(sys.argv[5]),
  # No percentile when no request finished inside the window (a very slow route): then the value is null.
  "rps": round(s["requestsPerSec"], 1), **{f"{k}ms": None if p.get(k) is None else round(p[k] * 1000, 3) for k in ("p50", "p90", "p99")},
  "ok": s["successRate"], "codes": codes, "serverCpuSeconds": round(ticks / hz, 2)}))
PY
  done
}

interaction() { # <server> <channel>
  wanted "interaction-$2" || return 0
  local before; before=$(ticks)
  local line; line=$(taskset -c $CLIENT_CPUS node "$HERE/interaction.ts" "http://127.0.0.1:$PORT" 20 10 "$2")
  echo "{\"server\":\"$1\",\"measure\":\"interaction-$2\",\"serverCpuSeconds\":$(awk -v t="$(( $(ticks) - before ))" -v hz="$(getconf CLK_TCK)" 'BEGIN { printf "%.2f", t / hz }'),\"result\":$line}"
}

# The game loop while 4 connections load personal stats: shows whether heavy reads hold up the moves of other players.
mixed() { # <server>
  wanted mixed || return 0
  local token; token=$(node -e "import('$HERE/tokens.ts').then((m) => console.log(m.tokenOf(7)))")
  taskset -c $CLIENT_CPUS "$OHA" --no-tui -z 60s -c 4 -H "x-player: $token" "http://127.0.0.1:$PORT/api/stats?scope=mine" > /dev/null &
  local loader=$!
  sleep 2
  local line; line=$(taskset -c $CLIENT_CPUS node "$HERE/interaction.ts" "http://127.0.0.1:$PORT" 20 10 sse)
  kill "$loader" 2>/dev/null || true; wait "$loader" 2>/dev/null || true
  echo "{\"server\":\"$1\",\"measure\":\"interaction-sse-under-stats-load\",\"result\":$line}"
}

# One seed, made once through the Rust server, then copied for each run, so both servers read the same file.
# SEED_FILE keeps the seed between runs: seeding 40,000 games takes a few minutes.
SEED_FILE=${SEED_FILE:-}
if [ -n "$SEED_FILE" ] && [ -f "$SEED_FILE" ]; then
  cp "$SEED_FILE" "$WORK/seed.duckdb"
else
  start rust "$WORK/seed.duckdb" > /dev/null
  taskset -c $CLIENT_CPUS node "$HERE/seed.ts" "http://127.0.0.1:$PORT" 400 100 >&2
  stop
  if [ -n "$SEED_FILE" ]; then cp "$WORK/seed.duckdb" "$SEED_FILE"; fi
fi

for server in $SERVERS; do
  cp "$WORK/seed.duckdb" "$WORK/$server.duckdb"
  start "$server" "$WORK/$server.duckdb"
  load "$server" health 32 /api/health
  load "$server" stats-everyone 32 /api/stats
  load "$server" leaderboard 32 /api/leaderboard
  load "$server" stats-mine 4 "/api/stats?scope=mine" "x-player: $(node -e "import('$HERE/tokens.ts').then((m) => console.log(m.tokenOf(7)))")"
  load "$server" history 16 /api/me/history "x-player: $(node -e "import('$HERE/tokens.ts').then((m) => console.log(m.tokenOf(7)))")"
  interaction "$server" sse
  interaction "$server" poll
  mixed "$server"
  echo "{\"server\":\"$server\",\"measure\":\"memory\",\"rssKb\":$(rss),\"peakRssKb\":$(peak)}"
  stop
done
