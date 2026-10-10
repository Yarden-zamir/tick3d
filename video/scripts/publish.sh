#!/bin/bash
# Renders every take of the spot and both paces of the tutorial on this machine, and publishes their previews to the pr-assets
# branch in issue-119/renders/<sha7>/<take>/: a GIF, a stills sheet per crop and both MP4s, each named
# tick3d-<take>-<sha7>-… so downloads never collide. Prints the base URL of the folder. Pull request previews
# come from here, not from CI (maintainer decision on #119).
# Needs ImageMagick and ffmpeg on PATH, and a committed, pushed HEAD: the folder name is the commit.
# Usage: video/scripts/publish.sh    (PR_ASSETS=<dir> keeps the pr-assets checkout elsewhere)
set -euo pipefail
cd "$(dirname "$0")/.."
TAKES=(spot classic)
PR_ASSETS=${PR_ASSETS:-$HOME/.cache/tick3d-pr-assets}

[ -z "$(git status --porcelain)" ] || { echo "publish.sh: commit first, the folder name is the commit" >&2; exit 1; }
[ "$(git rev-parse HEAD)" = "$(git rev-parse '@{u}')" ] || { echo "publish.sh: push first, the links name the commit" >&2; exit 1; }
sha=$(git rev-parse --short=7 HEAD)
folder=issue-119/renders/$sha

for take in "${TAKES[@]}"; do VIDEO_VARIANT=$take npm run video; done
npm run tutorial
TUTORIAL_PACE=short npm run tutorial

# A sparse checkout of pr-assets that holds only the new folder, so it never downloads the older renders.
if [ ! -d "$PR_ASSETS/.git" ]; then
  git clone --filter=blob:none --no-checkout --single-branch --branch pr-assets "$(git remote get-url origin)" "$PR_ASSETS"
fi
git -C "$PR_ASSETS" fetch -q origin pr-assets
git -C "$PR_ASSETS" sparse-checkout set --no-cone "/$folder/"
git -C "$PR_ASSETS" checkout -q -B pr-assets origin/pr-assets

# ImageMagick on macOS has no default font for montage. The sheets have no labels, but montage still loads one.
font=()
[ -f /System/Library/Fonts/Helvetica.ttc ] && font=(-font /System/Library/Fonts/Helvetica.ttc)
gif() { ffmpeg -v error -y -i "$1" -vf 'fps=12,scale=360:-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=64[p];[s1][p]paletteuse=dither=bayer:bayer_scale=3' -loop 0 "$2"; }
sheet() { local out=$1 tile=$2 geometry=$3; shift 3; montage "${font[@]}" "$@" -tile "$tile" -geometry "$geometry" -background '#111' -depth 8 -colors 255 "PNG8:$out"; }

for take in "${TAKES[@]}"; do
  out=out; [ "$take" = spot ] || out=out/variants/$take
  dest=$PR_ASSETS/$folder/$take
  name=tick3d-$take-$sha
  mkdir -p "$dest"
  sheet "$dest/$name-stills.png" 4x2 400x225+4+4 "$out"/stills/landscape-bar-{1..8}.png
  sheet "$dest/$name-portrait-stills.png" 8x1 198x352+4+4 "$out"/stills/portrait-bar-{1..8}.png
  gif "$out/tick3d-15s-landscape.mp4" "$dest/$name.gif"
  cp "$out/tick3d-15s-landscape.mp4" "$dest/$name-landscape.mp4"
  cp "$out/tick3d-15s-portrait.mp4" "$dest/$name-portrait.mp4"
done

# The tutorial at both paces: one still per section, in order by their numbered names.
for cut in tutorial tutorial-short; do
  out=out/$cut
  dest=$PR_ASSETS/$folder/$cut
  name=tick3d-$cut-$sha
  mkdir -p "$dest"
  sheet "$dest/$name-stills.png" 5x3 400x225+4+4 "$out"/stills/landscape-*.png
  sheet "$dest/$name-portrait-stills.png" 7x2 198x352+4+4 "$out"/stills/portrait-*.png
  gif "$out/tick3d-$cut-landscape.mp4" "$dest/$name.gif"
  cp "$out/tick3d-$cut-landscape.mp4" "$dest/$name-landscape.mp4"
  cp "$out/tick3d-$cut-portrait.mp4" "$dest/$name-portrait.mp4"
done

git -C "$PR_ASSETS" add "$folder"
git -C "$PR_ASSETS" commit -q -m "docs: previews of the spot and the tutorial at $sha, rendered locally"
for _ in 1 2 3; do
  if git -C "$PR_ASSETS" push -q origin pr-assets; then
    echo "https://raw.githubusercontent.com/Yarden-zamir/tick3d/pr-assets/$folder"
    exit 0
  fi
  git -C "$PR_ASSETS" pull -q --rebase origin pr-assets
done
echo "publish.sh: the push to pr-assets failed 3 times" >&2
exit 1
