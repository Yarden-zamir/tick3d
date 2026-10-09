# Tutorial: "How to win"

A 27.5 s video that shows which lines win and why. The plan is `video/src/tutorial/plan.ts`. This page explains it.

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
| 1 | Title | 0–15 / 0.000–1.654 | The tower from the home view. The layers bump one per beat. | "How to" / "win" | Classic C5, D5, E5, G5, one per layer. |
| 2 | Rows | 16–47 / 1.765–5.184 | An X drops on each cell of row 60–63, one per eighth note. The win beam joins them on s16 24. On s16 32 all 16 rows flash, then stay faint. | "4 in a row" / "wins.", then "Rows" / "+16". The counter starts. | A soft Cells note per cell, the win jingle on s16 24, a soft chord on s16 32. |
| 3 | Columns | 48–63 / 5.294–6.949 | The camera turns so the columns run across. Example 51–55–59–63, then all 16 columns. | "Columns" / "+16" | A note per cell, a chord on beat 3. |
| 4 | Pillars | 64–79 / 7.059–8.713 | From the side, low. Example 14–30–46–62, then all 16 pillars. | "Pillars: the 3D twist" / "+16" | As section 3. |
| 5 | Flat diagonals | 80–95 / 8.824–10.478 | From high above. Example 48–53–58–63, then all 8. | "Flat diagonals" / "+8" | As section 3. |
| 6 | Rising diagonals, front | 96–111 / 10.588–12.243 | Square to the front. Example 12–29–46–63, then the 8 rising diagonals on the planes that face the front. | "Rising diagonals" / "+8" | As section 3. |
| 7 | Rising diagonals, side | 112–127 / 12.353–14.007 | The camera turns a quarter turn. Example 3–23–43–63, then the 8 on the side planes. | The words stay; a new "+8" | As section 3. |
| 8 | Corner to corner, first pair | 128–143 / 14.118–15.772 | Square to the plane of corners 0 and 63. Example 0–21–42–63, then the 2 diagonals that cross in that plane. | "Corner to corner" / "+2" | As section 3. |
| 9 | Corner to corner, second pair | 144–159 / 15.882–17.537 | A quarter turn. Example 3–22–41–60, then the other 2. The counter reaches 76. | The words stay; a new "+2" | As section 3. |
| 10 | 76 ways | 160–175 / 17.647–19.301 | All 76 lines flash, one kind per s16, then stay faint. | "76 ways" / "to win." | A rising note per kind. |
| 11 | Strong cells | 176–191 / 19.412–21.066 | Corner 63 lights, then its 7 lines, one per s16. On s16 184 core cell 42 does the same. | "Corners and the core" / "7 lines each" | A rising note per line: 7 notes, twice. |
| 12 | Other cells | 192–207 / 21.176–22.831 | Cell 61 lights, then its 4 lines, one per eighth note. | "Every other cell" / "4 lines" | 4 rising notes. |
| 13 | Take them | 208–223 / 22.941–24.596 | The 8 corners light on s16 208, the 8 core cells on 212. They stay lit to the end. | "The 16 strong cells" / "Take them." | A chord on 208 and 212, the win jingle on 216. |
| 14 | End card | 224–249.3 / 24.706–27.500 | The tower shrinks into the top half of the square. | The end card of the spot: the `tick3d` wordmark on 224, ".yarden-zamir.com" on 228, "Play in your browser." on 232, then the "Android" and "iOS" badges on 236 and 240. | Classic C5, D5, E5, G5 on the beats, the final chord on 240. |

The rising diagonals and the space diagonals are the hard kinds, so each one gets 2 bars. Each bar shows its own example and half of the set, seen square on.

## Rules

- The tower shows in every frame. Text sits above or under the tower, inside the centre 1080 × 1080 square.
- The numbers on screen come from `lines.ts`, not from typed text. Together the sets hold each of the 76 lines once.
- The sound uses Classic and Cells only. Every note is in C major pentatonic. There is no bass and no glass bell.
- The camera turns in the 4 s16 before a section, so each section opens on its view. The end card zooms out after its downbeat.

## Render

```sh
cd video && npm run tutorial
```

This writes `out/tutorial/tick3d-tutorial-landscape.mp4`, `out/tutorial/tick3d-tutorial-portrait.mp4`, `out/tutorial/soundtrack.wav` and one still per section in `out/tutorial/stills/`. Add `--draft` for half-size stills only, or `--crop landscape` for one crop.
