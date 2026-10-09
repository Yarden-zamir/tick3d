# Script: "Thread the cube"

`beats.json` is the source of truth. This page explains it. Times are sixteenths (s16) from the start, and seconds.
One s16 = `SIXTEENTH` in `src/song.ts` = 0.1103 s. One bar = 16 s16 = 1.765 s. Frame of s16 `n` = `Math.round(n * SIXTEENTH * 30)`.

Move numbers on this page count from 1. The `move` field in `beats.json` counts from 0.

## Look (from the code)

- **Colors:** the theme tokens of `src/style.css`: `--page` (background, with the `--dot` grid of 22 px), `--slab` (the cells), `--line` (3 px outlines, `--border`), `--shadow` (hard offset shadows), `--x`, `--o`, `--win`.
- **Pieces:** X is the 12-point cross of `.x .piece::before` (the `clip-path` polygon), extruded. O is a ring, 0.13 cell thick. Both have a `--line` outline and a hard `--shadow` drop.
- **Tower:** four 4×4 layers. Cell = layer·16 + row·4 + column. Layer 0 is the bottom. Default tilt 62° (`TOWER_TILT` in `src/board/board.ts`).
- **Font:** Bricolage Grotesque from `src/fonts/`, heavy weight, black `--line` outline, hard shadow.
- **Framing:** everything important stays inside the centre 1080×1080 square. Both the 16:9 and the 9:16 crops work.
- **Finished game:** the pieces off the winning line drop to 35 % opacity, as in `.board.finished` in `src/style.css`.

## Sound (from the code)

- Only three sound sets: Classic, Cells and Chiptune (maintainer rule on #119). The palette per set is in `music.md`.
- The song is `songOf(replay(moves))`, forced to C major pentatonic (`songKey` in `beats.json`). Each melody note plays at the time of its move in `beats.json`, not at its song time.
- No bass line under the moves: it made the mix noisy (maintainer feedback on #119). The final chord keeps its root.
- The Cells glass bell (row 2) plays as the marimba of row 1: the bell sounded harsh (maintainer feedback on #119).
- The runs of one note per s16 (the moves of bar 3 and the replay) play at 70 % of their level, so they do not crowd the mix.
- Every note plays with the voices of the sound set of the bar that it falls in (`soundSet` in `beats.json`).
- Hit points: bar 1 downbeat (the first slam), bar 5 downbeat (the win), bar 7 downbeat (the end card).

## Bars

| Bar | s16 / seconds | Picture and camera | Theme / sound set | Text | Sound |
|---|---|---|---|---|---|
| 1 | 0–15 / 0.000–1.654 | Empty `--page`. The layers drop from above the frame and slam into place: layer 3 on beat 1, then 2, 1, 0. Each one lands with a short squash and a hard shadow. Camera fixed at the 62° tilt. | Light / Classic | – | One Classic note per slam: layer 3 G5, 2 E5, 1 D5, 0 C5. |
| 2 | 16–31 / 1.765–3.419 | The camera corkscrews down past the tower, a third of a turn, with the gaps between the layers open to the lens, and plunges under layer 0 on the last beat. Moves 1–8, one per eighth note, each visible as it lands. | Light / Cells | "4 in a row." slams on s16 16, "In 3D." on 24. Out on 32. | Song melody of moves 1–8. |
| 3 | 32–47 / 3.529–5.184 | The camera breaks out under layer 0 and swings into a half-turn orbit. Moves 9–24, one per s16: the game doubles its speed. Each piece pulses on its own note. | Sweep to Synthwave / Chiptune | – | Melody 9–24, softer. |
| 4 | 48–63 / 5.294–6.949 | Push in to corner 0. X lands on cell 0 on the downbeat. Cells 4 and 21 blink in `--win` and swell on each eighth note, and a `--win` ring grows out of each one and fades (the note). O lands on 4 on beat 3 (s16 56): its blink stops, 21 keeps blinking. | Sweep to Midnight / Cells | "Every cell" on 48, "has a note." on 52. Out on 62. | Move notes 25 and 26. The preview strike of each blinking cell on the eighth notes (s16 50, 52, 54 for 4 and 21; 58, 60, 62 for 21). |
| 5 | 64–79 / 7.059–8.713 | **The win.** X lands on 21 on the downbeat. The camera stands square to the plane of the diagonal, at the tilt of the game, so the four cells read as one rising line. From s16 68 the line 0–21–42–63 lights one cell per s16, and a beam of `--win` light joins them by 72. Then the camera drops onto the line and rides the beam out through corner 63 by s16 80. Other pieces drop to 35 %. | Midnight / Chiptune | – | Move note 27. On 68–71: the 4 ending notes of the song (the win run), one per beam cell. On 72–76: the five notes of the win jingle, one per s16, and the beam throbs on each. |
| 6 | 80–95 / 8.824–10.478 | Confetti from corner 63 on the downbeat, in `--x`, `--o`, `--win`, `--slab`. Pull back; the tower turns once. Replay: from s16 80 each move pulses again, one per s16, in move order. | Sweep to Candy / Cells | – | Replay of the 27 melody notes, one per s16 (80–106), softer. |
| 7 | 96–111 / 10.588–12.243 | **The end card.** The tower shrinks into the top half of the centre square, still pulsing to the replay. | Sweep to Light / Cells | "tick3d" slams on 96 as the wordmark; ".yarden-zamir.com" slides out of it on 100. Stays to the end. | Replay ends on 106. |
| 8 | 112–127 / 12.353–14.008 | End card holds. The four layers of the small tower pulse bottom to top, one per beat. | Light / Classic | The URL stays. | Classic C5, D5, E5, G5: one per layer, rising into the chord. |
| – | 128 / 14.118–15.000 | End card holds. | Light / Classic | The URL stays. | The final chord of the song (C major) rings, with a 50 ms fade to silence at 15.0 s. |

## Transitions

- A theme change is a diagonal wipe, bottom left to top right, over one eighth note from the downbeat. A 3 px `--line` band runs on the wipe edge. The new tokens apply behind the band.
- Cuts happen only on a downbeat. The camera moves inside a bar are continuous.
- Kinetic type: each word group drops in over 1 s16 with a spring overshoot, and leaves with a hard cut on its `until`.
