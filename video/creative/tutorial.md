# Tutorials: "How to play" and "Strong cells"

Two videos, each at two paces. The plans are in `video/src/tutorial/plan.ts`. This page explains them.

- `basics`, "How to play" (the default): how to take turns, place a mark, take it back and turn the tower, which lines win, how to block a line, and what a draw is. The Info panel of the game shows this one.
- `strong`, "Strong cells": the 76 ways to win, the cells on the most lines, and why to take them. The game does not show it yet.

`TUTORIAL=strong` picks the second one. The two share the section builders of `plan.ts`.

- `long` (the default): slow on purpose, so every label stays long enough to read and every example draws one cell per eighth note (maintainer feedback on #119). The tables below show this pace. Basics lasts 48 s, Strong cells 17 s.
- `short`: one bar for each kind of line and for most other sections, one example cell per s16, each count 8 s16 after its label. Basics lasts 34 s, Strong cells 12 s. `TUTORIAL_PACE=short` picks it.

Each tutorial ends on a whole second, at least 2.8 s after the end card starts, so the "soon" note shows for 1 s.

Times are sixteenths (s16) of the 136 BPM grid of `src/song.ts`, and seconds. One s16 is 0.1103 s. One bar is 16 s16.

## The lines

`LINES` in `src/game.ts` has 76 lines. `video/src/tutorial/lines.ts` sorts them by the coordinates that change between two cells of a line. The tests check every count.

| Kind | Count | What changes |
|---|---|---|
| Rows | 16 | the column |
| Columns | 16 | the row |
| Pillars | 16 | the layer |
| Flat diagonals | 8 | the row and the column |
| Rising diagonals | 16 | the layer and one of the row or the column |
| Corner to corner | 4 | all three |

The 8 corners and the 8 cells of the core lie on 7 lines each. Every other cell lies on 4 lines. So the 16 strong cells are the corners and the core.

## Basics: sections

| # | Section | s16 / seconds | Picture | Text | Sound |
|---|---|---|---|---|---|
| 1 | Title | 0–15 / 0.000–1.654 | The tower from the home view. The layers bump one per beat. | "How to" / "play" on 4 | Classic C5, D5, E5, G5, one per layer. |
| 2 | Take turns | 16–47 / 1.765–5.184 | From above. X and O land in turns on the top layer, one per beat from s16 22: X on 53, O on 54, X on 58, O on 57, X on 49, O on 62. A band around the whole picture shows the color of the player to move, `--x` or `--o`, as the game page does. It swells on each change. | "Take turns" / "X goes first." on 20 | A soft Cells note per mark, X and O. |
| 3 | Tap to place | 48–71 / 5.294–7.831 | A finger mark (a `--surface` dot with an outline and a hard shadow) comes in, presses cell 53 on s16 56 and goes back. Two rings ripple out, and an X lands on the press. | "Tap a cell" / "to place." on 52 | A soft Cells note on the press. |
| 4 | Take it back | 72–95 / 7.941–10.478 | The view where the tap ends, with the X still on 53. The finger taps the X on s16 80 and moves off. On s16 82 the X rises and fades in 1.5 s16. | "Changed your mind?" / "Tap it again." on 76 | 2 falling notes on 80 and 81. |
| 5 | Drag to turn | 96–119 / 10.588–13.125 | The finger mark presses under the tower on s16 100 and drags to the left over 12 s16, with a trail of dots. The camera turns a quarter turn with it, so the front of the tower follows the finger. | "Drag" / "to turn it." on 102 | A rising note per beat of the drag. |
| 6 | Rows | 120–159 / 13.235–17.537 | An X drops on each cell of row 60–63, one per eighth note. The win beam joins them on s16 128. On s16 144 all 16 rows flash, then stay faint. | "4 in a row" / "wins." on 128, then "Rows" on 140 / "+16" on 144. The counter starts. | A soft Cells note per cell, the win jingle on s16 128, a soft chord on s16 144. |
| 7 | Columns | 160–183 / 17.647–20.184 | The camera turns so the columns run across. Example 51–55–59–63, one cell per eighth note, then all 16 columns halfway. | "Columns" / "+16" 6 s16 later | A note per cell, a chord when the set shows. |
| 8 | Pillars | 184–207 / 20.294–22.831 | From the side, low. Example 14–30–46–62, then all 16 pillars. | "Pillars: the 3D twist" / "+16" | As section 7. |
| 9 | Flat diagonals | 208–231 / 22.941–25.478 | From high above. Example 48–53–58–63, then all 8. | "Flat diagonals" / "+8" | As section 7. |
| 10 | Rising diagonals, front | 232–255 / 25.588–28.125 | Square to the front. Example 12–29–46–63, then the 8 rising diagonals on the planes that face the front. | "Rising diagonals" / "+8" | As section 7. |
| 11 | Rising diagonals, side | 256–279 / 28.235–30.772 | The camera turns a quarter turn. Example 3–23–43–63, then the 8 on the side planes. | The words stay; a new "+8" | As section 7. |
| 12 | Corner to corner, first pair | 280–303 / 30.882–33.419 | Square to the plane of corners 0 and 63. Example 0–21–42–63, then the 2 diagonals that cross in that plane. | "Corner to corner" / "+2" | As section 7. |
| 13 | Corner to corner, second pair | 304–327 / 33.529–36.066 | A quarter turn. Example 3–22–41–60, then the other 2. The counter reaches 76. | The words stay; a new "+2" | As section 7. |
| 14 | 76 ways | 328–351 / 36.176–38.713 | All 76 lines flash, one kind per s16, then stay faint. | "76 ways" / "to win." on 334 | A rising note per kind. |
| 15 | Block it | 352–375 / 38.824–41.360 | An O lands on 51, 55 and 59, one per eighth note. On s16 358 their tiles turn `--o`, an `--o` beam reaches for corner 63, and the tile of 63 blinks. On s16 364 the finger taps 63 and an X lands. The beam jolts back, stops at the X and goes dim, the tile of 63 turns `--surface`, and an `--x` ring bursts out of it. | "Three in a line?" / "Block it." on 360 | A falling note per O, A minor on 358, C major and the tap note on 364. |
| 16 | A draw | 376–407 / 41.471–44.890 | The cube fills with `DRAW_BOARD` of `plan.ts`, 4 marks per s16, X and O in turns, each from the bottom layer up. The cube is full on s16 392. | "Full cube, no line?" / "A draw." on 394 | A note on each s16 of the fill, C major on 394. |
| 17 | End card | 408–435.2 / 45.000–48.000 | The tower shrinks into the top half of the square. | The end card of the spot: the `tick3d` wordmark on 408, ".yarden-zamir.com" on 412, "Play in your browser." on 416, then the official App Store and Google Play badges on 420, and the "soon" note on 424. | Classic C5, D5, E5, G5 on the beats, the final chord on 424. |

The turns, the tap, the undo, the drag, the block and each kind of line get 1.5 bars, so a section can start on a half bar. "Take turns" and "A draw" get 2 bars. The rising diagonals and the space diagonals are the hard kinds, so each one gets 2 sections (3 bars). Each section shows its own example and half of the set, seen square on.

`DRAW_BOARD` holds 32 X and 32 O, with no line of 4 for either player: X moves first, and the cube has 64 cells. A seeded random search with swaps found it. `plan.test.ts` checks it against `LINES`.

## Strong cells: sections

| # | Section | s16 / seconds | Picture | Text | Sound |
|---|---|---|---|---|---|
| 1 | Title | 0–15 / 0.000–1.654 | As in Basics. | "Strong" / "cells" on 4 | As in Basics. |
| 2 | 76 ways | 16–39 / 1.765–4.301 | All 76 lines flash, one kind per s16, then stay faint. | "76 ways" / "to win." on 22 | A rising note per kind. |
| 3 | Strong cells | 40–79 / 4.412–8.713 | Corner 63 lights, then its 7 lines, one per eighth note. On s16 60 core cell 42 does the same. | "Corners and the core" / "7 lines each" on 46 | A rising note per line: 7 notes, twice. |
| 4 | Other cells | 80–103 / 8.824–11.360 | Cell 61 lights, then its 4 lines, one per beat. | "Every other cell" / "4 lines" on 86 | 4 rising notes. |
| 5 | Take them | 104–127 / 11.471–14.007 | The 8 corners light on s16 104, the 8 core cells on 108. They stay lit to the end. | "The 16 strong cells" / "Take them." on 114 | A chord on 104 and 108, the win jingle on 116. |
| 6 | End card | 128–153.1 / 14.118–17.000 | As in Basics. | As in Basics, from s16 128. | As in Basics, the final chord on 144. |

## Checkpoints

The Info panel of the game shows the Basics video with a slider that jumps between its checkpoints. A section with a `chapter` in `plan.ts` starts a checkpoint; the sections without one belong to the checkpoint before them. `chaptersOf(tutorial, pace)` returns each checkpoint as `{ start, frame, headline, text }`, with times in seconds. `frame` is the moment where the picture of the checkpoint is complete: the label and its sticker show, and the example, the set or the move has drawn. The numbers in the texts come from `lines.ts`.

Basics, 15 checkpoints:

| # | Start / frame (s) | Headline | Sections |
|---|---|---|---|
| 1 | 0.000 / 0.882 | How to play | Title |
| 2 | 1.765 / 4.853 | Take turns | Take turns |
| 3 | 5.294 / 6.397 | Place a mark | Tap to place |
| 4 | 7.941 / 9.044 | Take it back | Take it back |
| 5 | 10.588 / 11.691 | Turn the tower | Drag to turn |
| 6 | 13.235 / 16.544 | Rows | Rows |
| 7 | 17.647 / 19.632 | Columns | Columns |
| 8 | 20.294 / 22.279 | Pillars | Pillars |
| 9 | 22.941 / 24.926 | Flat diagonals | Flat diagonals |
| 10 | 25.588 / 27.574 | Rising diagonals | Rising diagonals, front and side |
| 11 | 30.882 / 32.868 | Corner to corner | Corner to corner, both pairs |
| 12 | 36.176 / 37.500 | 76 ways to win | 76 ways |
| 13 | 38.824 / 40.588 | Block it | Block it |
| 14 | 41.471 / 43.676 | A draw | A draw |
| 15 | 45.000 / 46.875 | More to find | End card |

Strong cells, 5 checkpoints:

| # | Start / frame (s) | Headline | Sections |
|---|---|---|---|
| 1 | 0.000 / 0.882 | Where to play | Title |
| 2 | 1.765 / 3.088 | 76 ways to win | 76 ways |
| 3 | 4.412 / 6.507 | Strong cells | Strong cells, other cells |
| 4 | 11.471 / 13.015 | Take them | Take them |
| 5 | 14.118 / 15.993 | More to find | End card |

`src/tutorial-chapters.json` is the copy that the game reads: `{ "video", "poster", "chapters" }`, for the long Basics tutorial only. The render writes it. A test checks that it equals the checkpoints of the long Basics plan, so the game never drifts from the plan.

## Rules

- The tower shows in every frame. Text sits above or under the tower, inside the centre 1080 × 1080 square. The drag cue moves under the tower; the tap cue sits on its cell and moves off after the press. The turn frame stays at the edge of the picture.
- The numbers on screen come from `lines.ts`, not from typed text. In Basics, together the sets hold each of the 76 lines once.
- The sound uses Classic and Cells only. Every note is in C major pentatonic. There is no bass and no glass bell.
- The camera turns in the 4 s16 before a section, so each section opens on its view. The end card zooms out after its downbeat. In "Drag to turn" the camera also turns with the drag, with the same easing as the finger mark.

## Render

```sh
cd video && npm run tutorial                     # Basics, long
cd video && TUTORIAL=strong npm run tutorial     # Strong cells, long
```

A render writes its files to `out/<name>/`, where `<name>` is `tutorial-basics`, `tutorial-strong`, or with `TUTORIAL_PACE=short`, `tutorial-basics-short` or `tutorial-strong-short`. For Basics this is `out/tutorial-basics/tick3d-tutorial-basics-landscape.mp4`, `…-portrait.mp4`, `soundtrack.wav`, `chapters.json`, one still per section in `stills/` and one still per checkpoint, at its `frame`, in `checkpoints/`.

After the landscape MP4, it makes the web encode with ffmpeg: `tick3d-<name>-<sha7>-web.mp4`, 960 × 540, H.264 (CRF 28, preset slow, `+faststart`) and AAC at 96 kb/s. The render fails if the file is over 4 MB. It also writes the poster `tick3d-<name>-<sha7>-poster.jpg`, 960 wide, from the frame of the title checkpoint. `<sha7>` is the short commit of `HEAD`, so commit first. The long Basics render then writes `src/tutorial-chapters.json` with both file names. The game copies the two files into `public/tutorial/`. Add `--draft` for half-size stills only, or `--crop landscape` for one crop.
