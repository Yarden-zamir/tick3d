# Tutorial: "How to win"

A video that shows which lines win and why, at two paces. The plan is `video/src/tutorial/plan.ts`. This page explains it.

- `long`, 40 s (the default): slow on purpose, so every label stays long enough to read and every example draws one cell per eighth note (maintainer feedback on #119). The table below shows this pace.
- `short`, 27.5 s: one bar for each kind of line, one example cell per s16, each count 8 s16 after its label, and one bar for each of the last four sections. `TUTORIAL_PACE=short` picks it.

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

## Sections

| # | Section | s16 / seconds | Picture | Text | Sound |
|---|---|---|---|---|---|
| 1 | Title | 0–15 / 0.000–1.654 | The tower from the home view. The layers bump one per beat. | "How to" / "win" on 4 | Classic C5, D5, E5, G5, one per layer. |
| 2 | Rows | 16–55 / 1.765–6.066 | An X drops on each cell of row 60–63, one per eighth note. The win beam joins them on s16 24. On s16 40 all 16 rows flash, then stay faint. | "4 in a row" / "wins." on 24, then "Rows" on 36 / "+16" on 40. The counter starts. | A soft Cells note per cell, the win jingle on s16 24, a soft chord on s16 40. |
| 3 | Columns | 56–79 / 6.176–8.713 | The camera turns so the columns run across. Example 51–55–59–63, one cell per eighth note, then all 16 columns halfway. | "Columns" / "+16" 6 s16 later | A note per cell, a chord when the set shows. |
| 4 | Pillars | 80–103 / 8.824–11.360 | From the side, low. Example 14–30–46–62, then all 16 pillars. | "Pillars: the 3D twist" / "+16" | As section 3. |
| 5 | Flat diagonals | 104–127 / 11.471–14.007 | From high above. Example 48–53–58–63, then all 8. | "Flat diagonals" / "+8" | As section 3. |
| 6 | Rising diagonals, front | 128–151 / 14.118–16.654 | Square to the front. Example 12–29–46–63, then the 8 rising diagonals on the planes that face the front. | "Rising diagonals" / "+8" | As section 3. |
| 7 | Rising diagonals, side | 152–175 / 16.765–19.301 | The camera turns a quarter turn. Example 3–23–43–63, then the 8 on the side planes. | The words stay; a new "+8" | As section 3. |
| 8 | Corner to corner, first pair | 176–199 / 19.412–21.949 | Square to the plane of corners 0 and 63. Example 0–21–42–63, then the 2 diagonals that cross in that plane. | "Corner to corner" / "+2" | As section 3. |
| 9 | Corner to corner, second pair | 200–223 / 22.059–24.596 | A quarter turn. Example 3–22–41–60, then the other 2. The counter reaches 76. | The words stay; a new "+2" | As section 3. |
| 10 | 76 ways | 224–247 / 24.706–27.243 | All 76 lines flash, one kind per s16, then stay faint. | "76 ways" / "to win." on 230 | A rising note per kind. |
| 11 | Strong cells | 248–287 / 27.353–31.654 | Corner 63 lights, then its 7 lines, one per eighth note. On s16 268 core cell 42 does the same. | "Corners and the core" / "7 lines each" on 254 | A rising note per line: 7 notes, twice. |
| 12 | Other cells | 288–311 / 31.765–34.301 | Cell 61 lights, then its 4 lines, one per beat. | "Every other cell" / "4 lines" on 294 | 4 rising notes. |
| 13 | Take them | 312–335 / 34.412–36.949 | The 8 corners light on s16 312, the 8 core cells on 316. They stay lit to the end. | "The 16 strong cells" / "Take them." on 322 | A chord on 312 and 316, the win jingle on 324. |
| 14 | End card | 336–362.7 / 37.059–40.000 | The tower shrinks into the top half of the square. | The end card of the spot: the `tick3d` wordmark on 336, ".yarden-zamir.com" on 340, "Play in your browser." on 344, then the official App Store and Google Play badges on 348, and the "soon" note on 352. | Classic C5, D5, E5, G5 on the beats, the final chord on 352. |

Each kind of line gets 1.5 bars, so a section can start on a half bar. The rising diagonals and the space diagonals are the hard kinds, so each one gets 2 sections (3 bars). Each section shows its own example and half of the set, seen square on.

## Rules

- The tower shows in every frame. Text sits above or under the tower, inside the centre 1080 × 1080 square.
- The numbers on screen come from `lines.ts`, not from typed text. Together the sets hold each of the 76 lines once.
- The sound uses Classic and Cells only. Every note is in C major pentatonic. There is no bass and no glass bell.
- The camera turns in the 4 s16 before a section, so each section opens on its view. The end card zooms out after its downbeat.

## Render

```sh
cd video && npm run tutorial
```

This writes `out/tutorial/tick3d-tutorial-landscape.mp4`, `out/tutorial/tick3d-tutorial-portrait.mp4`, `out/tutorial/soundtrack.wav` and one still per section in `out/tutorial/stills/`. With `TUTORIAL_PACE=short`, the files go to `out/tutorial-short/` and are named `tick3d-tutorial-short-…`. Add `--draft` for half-size stills only, or `--crop landscape` for one crop.
