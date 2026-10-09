#!/bin/sh
# Makes the previews of a render for the issue and the pull request, as the previews job of
# .github/workflows/video.yml does: <name>-stills.png (the 8 landscape stills, 4 x 2), <name>-portrait-stills.png
# (the 8 portrait stills in a row), <name>.gif (the landscape MP4 at 360 px wide, 12 fps), and both MP4s as
# <name>-landscape.mp4 and <name>-portrait.mp4. A unique name per render (variant and commit) keeps downloads apart.
# Needs ImageMagick (montage) and ffmpeg on PATH: brew install imagemagick ffmpeg.
# Usage: video/scripts/previews.sh <out-dir> <dest-dir> <name>
#   out-dir: video/out, or video/out/variants/<variant>, after `npm run video`
#   dest-dir: for example <a pr-assets checkout>/issue-119/renders/<sha7>/<variant>
#   name: tick3d-<variant>-<sha7>, for example tick3d-hook-c6ba76d
# Paths must not contain spaces: the still lists are split on them.
set -eu
OUT=${1:?the out dir of a render}
DEST=${2:?the destination dir}
NAME=${3:?the file name prefix, for example tick3d-hook-c6ba76d}
mkdir -p "$DEST"

landscape=''
portrait=''
for n in 1 2 3 4 5 6 7 8; do
  landscape="$landscape $OUT/stills/landscape-bar-$n.png"
  portrait="$portrait $OUT/stills/portrait-bar-$n.png"
done
# shellcheck disable=SC2086
montage $landscape -tile 4x2 -geometry 400x225+4+4 -background '#111' -depth 8 -colors 255 "PNG8:$DEST/$NAME-stills.png"
# shellcheck disable=SC2086
montage $portrait -tile 8x1 -geometry 198x352+4+4 -background '#111' -depth 8 -colors 255 "PNG8:$DEST/$NAME-portrait-stills.png"
ffmpeg -v error -y -i "$OUT/tick3d-15s-landscape.mp4" -vf 'fps=12,scale=360:-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=64[p];[s1][p]paletteuse=dither=bayer:bayer_scale=3' -loop 0 "$DEST/$NAME.gif"
cp "$OUT/tick3d-15s-landscape.mp4" "$DEST/$NAME-landscape.mp4"
cp "$OUT/tick3d-15s-portrait.mp4" "$DEST/$NAME-portrait.mp4"
ls -l "$DEST"
