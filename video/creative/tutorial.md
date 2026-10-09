# Tutorial: "How to win"

A 24.0 s video that shows which lines win and why. The plan is `video/src/tutorial/plan.ts`. This page explains it.

Times are sixteenths (s16) of the 136 BPM grid of `src/song.ts`, and seconds. One s16 is 0.1103 s. One bar is 16 s16.

## The lines

`LINES` in `src/game.ts` has 76 lines. `video/src/tutorial/lines.ts` sorts them by the coordinates that change between two cells of a line. The tests check every count.

| Kind | Count | What changes |
|---|---|---|
| Rows | 16 | the column |
| Columns | 16 | the row |
| Pillars | 16 | the layer |
| Diagonals in a layer | 8 | the row and the column |
| Diagonals that climb | 16 | the layer and one of the row or the column |
| Corner to corner | 4 | all three |

The 8 corners and the 8 cells of the core lie on 7 lines each. Every other cell lies on 4 lines. So the 16 strong cells are the corners and the core.

## Sections

| # | Section | s16 / seconds | Picture | Text | Sound |
|---|---|---|---|---|---|
| 1 | Title | 0–15 / 0.000–1.654 | The tower from the home view. The layers bump one per beat. | "How to" / "win" | Classic C5, D5, E5, G5, one per layer. |
| 2 | Rows | 16–47 / 1.765–5.184 | An X drops on each cell of row 60–63, one per eighth note. The win beam joins them on s16 24. On s16 32 all 16 rows flash, then stay faint. | "4 in a row" / "wins.", then "Rows" / "+16". The counter starts. | A soft Cells note per cell, the win jingle on s16 24, a soft chord on s16 32. |
| 3 | Columns | 48–63 / 5.294–6.949 | The camera turns so the columns run across. Example 51–55–59–63, then all 16 columns. | "Columns" / "+16" | A note per cell, a chord on beat 3. |
| 4 | Pillars | 64–79 / 7.059–8.713 | From the side, low. Example 14–30–46–62, then all 16 pillars. | "Pillars: the 3D twist" / "+16" | As section 3. |
| 5 | Diagonals in a layer | 80–95 / 8.824–10.478 | From high above. Example 48–53–58–63, then all 8. | "Diagonals in a layer" / "+8" | As section 3. |
| 6 | Diagonals that climb | 96–111 / 10.588–12.243 | Square to the front plane. Example 12–29–46–63, then all 16. | "Diagonals that climb" / "+16" | As section 3. |
| 7 | Corner to corner | 112–127 / 12.353–14.008 | Square to the long diagonal. Example 0–21–42–63, then all 4. | "Corner to corner" / "+4". The counter reaches 76. | As section 3. |
| 8 | 76 ways | 128–143 / 14.118–15.772 | All 76 lines flash, one kind per s16, then stay faint. | "76 ways" / "to win." | A rising note per kind. |
| 9 | Strong cells | 144–159 / 15.882–17.537 | Corner 63 lights, then its 7 lines, one per s16. On s16 152 core cell 42 does the same. | "Corners and the core" / "7 lines each" | A rising note per line: 7 notes, twice. |
| 10 | Other cells | 160–175 / 17.647–19.301 | Cell 61 lights, then its 4 lines, one per eighth note. | "Every other cell" / "4 lines" | 4 rising notes. |
| 11 | Take them | 176–191 / 19.412–21.066 | The 8 corners light on s16 176, the 8 core cells on 180. They stay lit to the end. | "The 16 strong cells" / "Take them." | A chord on 176 and 180, the win jingle on 184. |
| 12 | End card | 192–217.6 / 21.176–24.000 | The tower shrinks into the top half of the square. | The `tick3d` wordmark on 192, ".yarden-zamir.com" slides out on 196. | Classic C5, D5, E5, G5 on the beats, the final chord on 208. |

## Rules

- The tower shows in every frame. Text sits above or under the tower, inside the centre 1080 × 1080 square.
- The numbers on screen come from `lines.ts`, not from typed text.
- The sound uses Classic and Cells only. Every note is in C major pentatonic. There is no bass and no glass bell.
- The camera turns in the 4 s16 before a section, so each section opens on its view. The end card zooms out after its downbeat.

## Render

```sh
cd video && npm run tutorial
```

This writes `out/tutorial/tick3d-tutorial-landscape.mp4`, `out/tutorial/tick3d-tutorial-portrait.mp4`, `out/tutorial/soundtrack.wav` and one still per section in `out/tutorial/stills/`. Add `--draft` for half-size stills only, or `--crop landscape` for one crop.
