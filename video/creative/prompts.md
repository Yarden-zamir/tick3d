# Build prompts for Reel

Five tasks, in this order, on the branch `feat/video-creative` (the PR for #119). Each prompt stands alone.

**Rules for every task:**

- Read `video/creative/script.md` and `video/creative/beats.json` first. Load the timeline with `parseBeats` from `video/creative/beats.ts`. Do not copy values out of it.
- Import game logic from `src/`. Do not copy it. If a function in `src/` is private, export the smallest piece, and give it a unit test.
- `video/` has its own `package.json`. three.js and Remotion never enter the game bundle. Check the latest versions online before you pin them.
- Strict TypeScript, oxlint and Knip, as in the repo. The repo check (`npm ci && npm run check && npx vite build`) stays green.
- Determinism: every value is a function of the frame number. No `Date.now()`, no `performance.now()`, no unseeded `Math.random()`.
- Time: s16 `n` is at `n * SIXTEENTH` seconds (`src/song.ts`). Frame = `Math.round(seconds * 30)`. The spot is 450 frames (15.0 s).
- Check: `docker run --rm -v "$PWD":/repo -w /repo node:26-alpine node video/creative/tools/check-beats.ts` exits 0.

## Task 1: Scene

Build the three.js scene in Remotion with `@remotion/three`. three.js draws every pixel. Remotion is only the timeline and the renderer.

- The tower: four 4×4 layers with real depth and gaps. Cell = layer·16 + row·4 + column (`toCell`, `toCoords` in `src/game.ts`). Layer 0 at the bottom.
- Cells: flat `--slab` tiles with a 3 px `--line` outline and a hard `--shadow` offset. Background `--page` with the `--dot` grid of 22 px.
- Pieces: X is the extruded 12-point polygon of `.x .piece::before` in `src/style.css`. O is a ring, 0.13 cell thick. Colors `--x`, `--o`.
- Themes: read the 12 token sets from `src/style.css` at build time. Do not retype the hex values.
- Camera rig: one function `cameraAt(frame, bar)` for the 7 camera kinds of `beats.json` (`slam`, `dive`, `orbit`, `push`, `ride`, `pull-back`, `settle`). The `dive` passes down the centre axis through the seam where cells 5, 6, 9 and 10 of each layer meet.
- Compositions: `landscape` 1920×1080 and `portrait` 1080×1920, 30 fps, 450 frames. Both keep the tower inside the centre 1080×1080 square.

**Acceptance:**
- [ ] A still of each bar in both compositions shows the tower in the theme of that bar.
- [ ] The colors in the stills match the tokens of `src/style.css` for that theme.
- [ ] Two renders of the same frame give identical pixels.

## Task 2: Game script

Place the game of `beats.json` on the timeline.

- Rebuild the game from `game.seed` and `game.levels` with `chooseMove` (`src/ai.ts`) and `seededRandom` (`src/practice/practice.ts`), as `tools/check-beats.ts` does. Throw if it differs from `beats.moves`.
- Show each move at its `at`. A piece drops in over 1 s16 and pulses (scale 1 → 1.25 → 1) on its note.
- `threats`: the cells blink in `--win`, as `.cell.win` does. A blink stops when a piece takes the cell.
- `beam`: one cell of the line per s16 in `--win`, then a beam through all four. The other pieces drop to 35 % opacity.
- `replay`: each piece pulses again, one per s16 from `at`, in move order.

**Acceptance:**
- [ ] The board in every frame equals `replay(moves so far)` from `src/game.ts`.
- [ ] The beam cells equal `game.line`, and `game.line` is in `LINES`.
- [ ] A unit test checks the board at the frame of each move.

## Task 3: Audio

Render the soundtrack to `video/out/soundtrack.wav` (44.1 kHz stereo, 15.0 s) with an `OfflineAudioContext`. Only `src/sound.ts`, `src/sound-sets.ts` and `src/song.ts` make sound. Encode with `encodeWav` (`src/wav.ts`).

- Follow the maintainer audio rule on #119 and `music.md`: only the game's sound code, C major pentatonic, and only the Classic, Cells and Chiptune sets.
- `layer-slam`: `SOUND_SETS.classic.voices(layer * 16, 'X')` (C5, D5, E5, G5).
- The key: `songOf` picks a key from a hash of the moves (A dorian for this game). Add an optional `key` parameter to `songOf` in `src/song.ts`, default `keyOf(game)`, with a unit test. Pass `beats.songKey`.
- The song: `songOf(replay(moves), beats.songKey)`. Retime its notes:
  - a melody note with `move = i` plays at `moves[i].at`;
  - a bass note under the moves does not play (maintainer feedback on #119);
  - the 4 melody notes without `move` (the win run) play at `beam.at + k`;
  - the chord notes and the bass note at the same time as them (the final chord) play at `final-chord.at`;
  - `replay`: the melody note of move `i` plays again at `replay.at + i`.
- Each note uses the voices of the sound set of the bar that it falls in.
- `scheduleSong`, `noteVoices` and `play` in `src/sound.ts` are private. Export the smallest function that schedules one note with a set at a time. Do not copy them.
- Fade the last 50 ms to silence at 15.0 s.
- Write the s16 of every note to `video/out/beats.txt` as beat markers.

**Acceptance:**
- [ ] The WAV lasts 15.0 s (±0.01 s).
- [ ] Every note onset is on the 136 BPM grid (a whole s16).
- [ ] Every pitched note is in C major pentatonic (C, D, E, G, A). Drop an added Cells fifth or Chiptune step that leaves the scale (`music.md`), and keep the timbre partials.
- [ ] The hits land on the bar 1 downbeat, the bar 5 downbeat (the win) and the bar 7 downbeat (the end card).
- [ ] No sample, recording or outside sound file is in `video/`.

## Task 4: Edit

Build the bars of `beats.json`, the transitions, the text and the end card.

- Theme change: a diagonal wipe from bottom left to top right over 2 s16 from the downbeat, with a 3 px `--line` band on the edge.
- Text: Bricolage Grotesque from `src/fonts/`, drawn in three.js (a font geometry or a canvas texture). Heavy weight, `--line` outline, hard shadow. Each word group drops in over 1 s16 with a spring, and cuts out at `until`. Only the 3 lines of `beats.json`.
- Confetti: seeded particles in `--x`, `--o`, `--win` and `--slab`, from corner 63 on its `at`.
- End card (bar 7 downbeat): the tower shrinks into the top half of the centre square. "tick3d" slams in as the wordmark, and ".yarden-zamir.com" slides out of it.
- `npm run video` (in `video/`) renders `video/out/tick3d-15s-landscape.mp4`, `video/out/tick3d-15s-portrait.mp4` (H.264, AAC) and one still per bar in `video/out/stills/` (the frame at the middle of each bar).

**Acceptance:**
- [ ] Both MP4s last 15.0 s (±0.1 s) at 1920×1080 and 1080×1920.
- [ ] Every cut and every word lands on a whole s16.
- [ ] No text in the spot except the 3 lines.
- [ ] Two renders give the same frames.

## Task 5: CI

Add `.github/workflows/video.yml`.

- Triggers: `workflow_dispatch`, a push to `main` that touches `video/**`, and a tag `video-v*`.
- Steps: `npm ci` at the root and in `video/`, run `video/creative/tools/check-beats.ts`, then `npm run video`.
- Upload both MP4s and the stills as artifacts. A `video-v*` tag also attaches them to a GitHub Release.
- No secrets.
- Add a short "Video" section to `README.md`: how to render the spot, and where CI puts it.

**Acceptance:**
- [ ] A manual run on the branch renders and uploads the files with no manual step.
- [ ] The workflow passes `actionlint` (or the repo's YAML check, if one exists).
