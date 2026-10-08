#!/usr/bin/env bash
# Prints the Markdown changelog of a GitHub release: the commits since the previous release tag,
# grouped by conventional commit type, with short hashes. Merge commits are skipped.
# Usage: android/changelog.sh <tag pattern>   (android-v* for releases, android-* for pre-releases too)
# The Play release notes are a different, shorter text: android/release-notes.sh.
set -euo pipefail

pattern=${1:?usage: changelog.sh <tag pattern>}
previous=$(git describe --tags --abbrev=0 --match "$pattern" HEAD^ 2>/dev/null || true)
range=${previous:+$previous..}HEAD

features=() fixes=() other=()
while IFS=$'\t' read -r hash subject; do
  [[ -z "$hash" ]] && continue
  line="- ${subject} (${hash})"
  case "$subject" in
    feat:* | feat\(*) features+=("$line") ;;
    fix:* | fix\(*) fixes+=("$line") ;;
    *) other+=("$line") ;;
  esac
done < <(git log --no-merges --format='%h%x09%s' "$range")

section() {
  local title=$1
  shift
  (( $# == 0 )) && return
  printf '### %s\n\n' "$title"
  printf '%s\n' "$@"
  printf '\n'
}

if [[ -n "$previous" ]]; then printf 'Changes since %s.\n\n' "$previous"; else printf 'All changes so far.\n\n'; fi
section Features "${features[@]}"
section Fixes "${fixes[@]}"
section Other "${other[@]}"
