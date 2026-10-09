#!/bin/sh
# Makes the previews of a render for the issue and the pull request: bars.png (the 8 landscape stills, 4 x 2),
# portrait.png (the 8 portrait stills in a row), spot.gif (the landscape MP4 at 360 px wide, 12 fps), and both
# MP4s, copied. The previews job of .github/workflows/video.yml does the same.
# Needs ImageMagick (montage) and ffmpeg on PATH: brew install imagemagick ffmpeg.
# Usage: video/scripts/previews.sh <out-dir> <dest-dir>
#   out-dir: video/out, or video/out/variants/<name>, after `npm run video`
#   dest-dir: for example <a pr-assets checkout>/issue-119/variants/<name>
# Paths must not contain spaces: the still lists are split on them.
set -eu
OUT=${1:?the out dir of a render}
DEST=${2:?the destination dir}
mkdir -p "$DEST"

landscape=''
portrait=''
for n in 1 2 3 4 5 6 7 8; do
  landscape="$landscape $OUT/stills/landscape-bar-$n.png"
  portrait="$portrait $OUT/stills/portrait-bar-$n.png"
done
# shellcheck disable=SC2086
montage $landscape -tile 4x2 -geometry 400x225+4+4 -background '#111' -depth 8 -colors 255 "PNG8:$DEST/bars.png"
# shellcheck disable=SC2086
montage $portrait -tile 8x1 -geometry 198x352+4+4 -background '#111' -depth 8 -colors 255 "PNG8:$DEST/portrait.png"
ffmpeg -v error -y -i "$OUT/tick3d-15s-landscape.mp4" -vf 'fps=12,scale=360:-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=64[p];[s1][p]paletteuse=dither=bayer:bayer_scale=3' -loop 0 "$DEST/spot.gif"
cp "$OUT/tick3d-15s-landscape.mp4" "$OUT/tick3d-15s-portrait.mp4" "$DEST/"
ls -l "$DEST"
