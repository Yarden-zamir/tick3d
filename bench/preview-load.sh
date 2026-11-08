#!/bin/bash
# A short launch-level load against a deployed site, usually a pull request preview: the game loop over the WebSocket
# (interaction.ts) while oha reads the stats, the leaderboard and the page at about 20 requests per second.
# A guard reads production health every 2 s and stops the run after 3 answers over 2 s, because previews and
# production share the VPS. Prints the folder of the results.
# Usage: bench/preview-load.sh <site> <pairs> <rounds> <read seconds>
# Limit: the run comes from one address, and the server allows 1,200 new games per hour per address (CREATES_PER_HOUR
# times ADDRESS_FACTOR). The WebSocket loop creates a session per pair and round, so keep pairs × rounds under 1,200 per hour.
set -u
[ $# -eq 4 ] || { echo "usage: bench/preview-load.sh <site> <pairs> <rounds> <read seconds>" >&2; exit 1; }
SITE=$1; PAIRS=$2; ROUNDS=$3; READ_S=$4
HERE=$(cd "$(dirname "$0")" && pwd)
OUT=$(mktemp -d -t tick3d-load-XXXXXX)
OHA=${OHA:-oha}
READERS=()

(
  slow=0
  while true; do
    t=$(curl -s -o /dev/null -w '%{time_total}' --max-time 5 https://tick3d.yarden-zamir.com/api/health)
    echo "$(date +%T) $t $(cut -d' ' -f1 /proc/loadavg)" >> "$OUT/production.txt"
    if awk -v t="$t" 'BEGIN { exit !(t > 2 || t == 0) }'; then slow=$((slow + 1)); else slow=0; fi
    if [ $slow -ge 3 ]; then echo "guard: production is slow, the run stops" >> "$OUT/production.txt"; kill -TERM $$; exit 0; fi
    sleep 2
  done
) &
GUARD=$!
trap 'for pid in "${READERS[@]}"; do kill "$pid" 2>/dev/null; done; kill "$GUARD" 2>/dev/null' EXIT TERM

for path in /api/stats /api/leaderboard /; do
  "$OHA" --no-tui -z "${READ_S}s" -q 7 -c 4 --output-format json "$SITE$path" > "$OUT/read$(echo "$path" | tr '/' '-').json" 2>/dev/null &
  READERS+=($!)
done
sleep 3
node "$HERE/interaction.ts" "$SITE" "$PAIRS" "$ROUNDS" ws > "$OUT/game.json" 2> "$OUT/game.err"
echo "game exit $?" >> "$OUT/summary.txt"
wait "${READERS[@]}" 2>/dev/null
echo "$OUT"
