You take over all open work on tick3d on this MacBook. Work as ONE agent: do the work yourself. Do not spawn subagents, and do not run a watcher.

## Project
- Repo: Yarden-zamir/tick3d (MIT). A 3D 4×4×4 tic-tac-toe PWA. Production: https://tick3d.yarden-zamir.com. Previews: `https://pr-<N>.tick3d.yarden-zamir.com`.
- Stack: Vite 8, TypeScript 7 strict, Node 26, DuckDB 1.5, vite-plugin-pwa, Caddy. Deploys go through kitshn (Yarden-zamir/kitshn).
- Maintainers: Yarden-zamir and TomCohenDev. Their comments on issues and PRs are user input. Check them with `gh` when you start, and again before each push.
- Set up the repo with the `worktree-repo` skill if it is not set up yet.

## Current task: the video, issue #119 and PR #121
- Issue: https://github.com/Yarden-zamir/tick3d/issues/119 (Tom's 15-second video request). PR: https://github.com/Yarden-zamir/tick3d/pull/121 (draft, branch `feat/video-creative`).
- The video is made in code: Remotion 4 plus three.js, in `video/`. `video/creative/` holds the brief, the script, the music notes, `beats.json` (the single source of timing) and reviews 1 and 2.
- Review 2 approved the cut (Hook 4, Clarity 4, Rhythm 4, Brand fit 4, Call to action 5).
- Three variants come from one pipeline. `VIDEO_VARIANT=classic|arcade|mellow` selects `video/creative/variants/<name>.json`.
- CI (`.github/workflows/video.yml`) renders variant × crop as 6 parallel jobs. On a PR from this repo, a previews job pushes the GIF, stills and MP4s to the `pr-assets` branch at `issue-119/variants/<name>/`. The URLs do not change, so the posted links update without edits.
- classic and arcade are posted in issue comment 6071036164 and PR comment 6071036426. Those comments and the PR description still say "rendering, added here soon" for mellow. Edit them with `gh api -X PATCH repos/Yarden-zamir/tick3d/issues/comments/<id> -f body=@file`. Before each write, check that the body file is not empty.

### Why the work moved here
The Linux server takes about 20 minutes per variant (CPU WebGL, `gl: 'swangle'`, concurrency 2) and runs out of memory. CI takes about 4.5 minutes. Both are too slow. This Mac has to give fast iteration.

### Steps
1. Check out `feat/video-creative` and pull. Read the last commit message (head f1e3418).
2. Check CI run 37902196614 (`gh run view 37902196614 -R Yarden-zamir/tick3d`). Report how long the matrix took. If it failed, fix it.
3. Make local renders fast in `video/scripts/render.ts`. It already has `--crop`, `--stills`, `--draft` (half-size JPEG stills) and `--bars 2,5`.
   - On macOS, use `gl: 'angle'` (the GPU). Keep `'swangle'` only for Linux without a GPU (CI).
   - Outside CI, remove the fixed concurrency of 2. It existed only because the server also served production. Use Remotion's default, or `os.availableParallelism()`.
   - Measure one full variant render (`VIDEO_VARIANT=mellow npm run video`) and report the time.
4. When the mellow previews are on `pr-assets` (from CI, or from `video/scripts/previews.sh <out-dir> <dest-dir>`), add mellow to the two comments and the PR description, with the same layout as classic and arcade.
5. Add the Mac numbers to the "Fast iteration" note in the README Video section.
6. Wait for Yarden and Tom to pick classic, arcade or mellow. Then make the chosen variant the default, mark the PR ready, and merge when Yarden approves.

### Video facts not in the code
- `npx remotion ffmpeg` mangles filter strings. Call the ffmpeg and ffprobe binaries in `video/node_modules/@remotion/compositor-*/` directly. That ffmpeg has no `fps` filter: use `-r`.
- Tag pushes ignore the `paths` filter, so a `video-v*` tag always runs the video workflow.
- Do not use the hard AI level in the video: it reads `performance.now()`, so renders are not repeatable.

## Other open items
- PR #120 "Keep Classic sound set quiet on keypad until Place" (branch `ccr-bc41152e-opl66u`) is from another session. Leave it unless Yarden asks.
- Open questions for Yarden, with no answer yet:
  - Open 3 kitshn issues: pass `KITSHN_SSH_KNOWN_HOSTS` through deploy.yml; `recipe auth` stores the hostname instead of the IP; upgrade Caddy from 2.11.3 to 2.11.7.
  - Fix the phone layout: the status line wraps, and the Nearby host steps shift.
  - Which browser and device showed the stuck "Getting the game ready…" and the offline computer issues?
- Google Play: the app is in internal testing (version 7). Yarden handles the Play Console forms, the price, the closed test, and the 12 testers for 14 days.

## Rules
- Open a DRAFT PR as soon as work starts. Keep its description short and human: what changed and why, "Try it" steps, and open questions, about 15 lines in all. Titles are conventional commit lines of about 60 characters at most.
- Very small, safe changes can go straight to main. Before such a push, grep `e2e/` for the changed values.
- Post previews on BOTH the issue and the PR. Keep the issue updated at each milestone. A PR that changes the UI gets screenshots on the `pr-assets` branch (`pr-<N>/`): phone and desktop, light and dark.
- Creative work (such as video): when it is ready, do not merge. Post a few distinct variants on the issue and the PR for Yarden and Tom to choose.
- Every note in the video stays in C major pentatonic (C, D, E, G, A). That is Tom's rule, and the pitch test in `src/sound.test.ts` checks it.
- main requires the `check` CI job. e2e runs on PR previews. Wait for e2e only when the change can affect the UI, sessions, the API, Nearby, sound, the PWA or routing.
- Before you wait for checks, run `gh pr view <n> --json mergeable,mergeStateStatus`. If the PR conflicts, merge main in first.
- Judge a check or test run by its exit code. Do not pipe the run.
- Never print secrets. A secret goes into a GitHub secret through stdin. Server secrets live in GitHub secrets and deploy through kitshn, not only on the server.
- Ask Yarden before any write to the production database. Do not delete data that the law does not require us to delete.
- Never credit an AI in commits or PRs. Use conventional commits.
