#!/usr/bin/env bash
# Prints the Play release notes for a tag: the feat and fix pull requests that merged into main
# since the previous android-v tag, one line each, at most 500 characters (the Play limit).
# Usage: android/release-notes.sh android-v1.2.0   (needs the tags fetched, and GH_TOKEN for gh)
set -euo pipefail

tag=${1:?usage: release-notes.sh <tag>}
limit=500
previous=$(git describe --tags --abbrev=0 --match 'android-v*' "$tag^" 2>/dev/null || true)
search="is:merged base:main"
if [[ -n "$previous" ]]; then search+=" merged:>$(git log -1 --format=%cI "$previous")"; fi

# "feat(voice): hold a note to place" becomes "Hold a note to place".
lines=$(gh pr list --state merged --search "$search" --limit 200 --json title --jq '.[].title' |
  grep -E '^(feat|fix)(\([^)]*\))?!?: ' |
  sed -E 's/^[a-z]+(\([^)]*\))?!?: //; s/^(.)/\U\1/; s/^/• /' || true)

notes=""
while IFS= read -r line; do
  [[ -z "$line" ]] && continue
  next=${notes:+$notes$'\n'}$line
  (( ${#next} > limit )) && break
  notes=$next
done <<< "$lines"
printf '%s\n' "${notes:-• Small fixes and improvements.}"
