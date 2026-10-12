#!/bin/sh
# Builds the toys of a checkout into <out>/<folder>/, for a pull request preview (Dockerfile, stage toys).
# A toy is a top-level folder whose package.json has a "toy" script. That script builds the toy into the
# folder's dist/ with relative addresses, because the preview serves it at /toys/<folder>/.
# <out>/index.html lists the toys. With exactly one toy, it opens that toy at once.
# Limit: every pull request preview builds every toy on its branch, also when the pull request is not a toy.
# Revisit when a toy build gets slow, or when there are enough toys that the index needs more than a list.
set -eu

out=$1
mkdir -p "$out"
toys=""
for manifest in */package.json; do
  [ -f "$manifest" ] || continue
  folder=${manifest%/package.json}
  node -e 'process.exit(require(process.argv[1]).scripts?.toy ? 0 : 1)' "./$manifest" || continue
  # A failed toy build fails the preview, so a broken toy never looks fine.
  (cd "$folder" && npm ci --no-audit --no-fund && npm run toy)
  [ -f "$folder/dist/index.html" ] || { echo "toy $folder: npm run toy made no dist/index.html" >&2; exit 1; }
  cp -R "$folder/dist" "$out/$folder"
  toys="$toys $folder"
done

{
  echo '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Toys</title>'
  set -- $toys
  [ $# -eq 1 ] && echo "<meta http-equiv=\"refresh\" content=\"0; url=$1/\">"
  echo '</head><body><h1>Toys</h1><ul>'
  for folder in $toys; do echo "<li><a href=\"$folder/\">$folder</a></li>"; done
  [ $# -eq 0 ] && echo '<li>This branch has no toys.</li>'
  echo '</ul></body></html>'
} > "$out/index.html"
echo "toys:${toys:- none}"
