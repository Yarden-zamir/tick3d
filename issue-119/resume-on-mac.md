Resume the video work for tick3d issue #119 and PR #121 on this MacBook.

## Context
- Repo: Yarden-zamir/tick3d (MIT). Issue: https://github.com/Yarden-zamir/tick3d/issues/119 (Tom's 15-second video request). PR: https://github.com/Yarden-zamir/tick3d/pull/121 (draft, branch `feat/video-creative`).
- The video is made in code: Remotion 4 plus three.js, in the `video/` package. `video/creative/` holds the creative docs: brief, script, music, beats.json (the single source of timing), and reviews 1 and 2.
- Review 2 approved the cut (Hook 4, Clarity 4, Rhythm 4, Brand fit 4, Call to action 5).
- Three variants come from one pipeline. `VIDEO_VARIANT=classic|arcade|mellow` selects `video/creative/variants/<name>.json`. Renders go to `video/out/` (classic) or `video/out/variants/<name>/`.
- All three variants render in CI: `.github/workflows/video.yml` runs variant × crop as 6 parallel jobs. On a PR from this repo, a previews job pushes the GIF, stills and MP4s to `pr-assets` at stable URLs, so the posted links update without edits.
- The first matrix run is on head f1e3418 (run 37902196614). The posted comments still say "rendering, added here soon" for mellow.
- The variant posts to edit: issue comment 6071036164 and PR comment 6071036426. Edit them with `gh api -X PATCH repos/Yarden-zamir/tick3d/issues/comments/<id> -f body=@file`. Before each write, check that the body file is not empty.
- Previews live on the `pr-assets` branch under `issue-119/variants/<name>/` (spot.gif, bars.png, portrait.png, both MP4s). `video/scripts/previews.sh` builds them.

## Why we moved
The Linux server renders one variant in both crops in about 20 minutes, with CPU WebGL (`gl: 'swangle'`, concurrency 2). It also ran out of memory. GitHub CI takes about 4.5 minutes. Both are too slow. This Mac has to give fast iteration.

## Steps
1. Set up the repo with the `worktree-repo` skill if it is not set up yet. Check out `feat/video-creative` and pull. Read the last commit message: it says what the server agent left done and not done.
2. Check run 37902196614 (`gh run view 37902196614 -R Yarden-zamir/tick3d`). Report how long the matrix took. If it failed, fix it.
3. Make local renders fast on this Mac, in `video/scripts/render.ts`. It already has `--crop`, `--stills`, `--draft` (half-size JPEG stills) and `--bars 2,5`.
   - Use the GPU: on macOS, use `gl: 'angle'`. Keep `'swangle'` only for Linux without a GPU (CI).
   - Remove the fixed concurrency of 2 outside CI, which existed only because the server also served production. Use Remotion's default, or `os.availableParallelism()`.
   - Measure one full variant render (`VIDEO_VARIANT=mellow npm run video`) and report the time.
4. When the mellow previews are on `pr-assets` (CI or `video/scripts/previews.sh <out-dir> <dest-dir>`), edit the two comments and the PR description to add mellow, with the same layout as classic and arcade.
5. Add the local Mac numbers to the "Fast iteration" note in the README Video section.

## Rules
- Do not merge PR #121. Keep it a draft until Yarden and Tom pick classic, arcade or mellow on the issue or the PR.
- Post previews on BOTH the issue and the PR.
- Every note in the video stays in C major pentatonic (C, D, E, G, A). That is Tom's rule. The hard pitch test in `src/sound.test.ts` checks it, and it must stay green.
- Check `tools/check-beats.ts` and the video tests (`npm run check` in `video/`) before each push. The required CI check runs the full app gate, so do not repeat it locally.
- Use conventional commits. Start each GitHub comment with `<!-- agent -->` and a signature line, for example "🤖 **Reel** · Video build agent".
- Keep PR text short and human. Never print secrets.
