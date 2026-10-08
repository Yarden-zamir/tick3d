# Review 1

CHANGES NEEDED

Render: the first full render on `feat/video-creative`, up to commit 6d5e95b. The CI and local renders are the same.
Sources: the stills per bar, the contact sheets, a sheet of 16 frames from the landscape MP4, an ffprobe of both MP4s, and an analysis of `soundtrack.wav`.
Frame of s16 n = `Math.round(n * SIXTEENTH * 30)`.

## Scores

| Criterion | Score | Why |
|---|---|---|
| Hook | 3 | Frame 0 shows one flat yellow layer at rest on the page. The first slam has no impact frame, so the first second does not stop the scroll. |
| Clarity | 3 | Bar 2 shows no pieces, and frame 103 (s16 31) shows only text on an empty page. At the win, the camera is almost edge-on to the layers, so the corner-to-corner line does not read. |
| Rhythm | 3 | The cuts, the moves and the words sit on the grid (`beats.txt`). But the climax goes quiet: s16 72–79 (7.94–8.71 s) is almost silent, right after the win run. |
| Brand fit | 4 | The tokens, the dot grid, the hard shadows, Bricolage and the "3d" sticker wordmark (as `.brand h1 span`) all match the game. The thin grey slam rings are off brand. |
| Call to action | 4 | The URL lands on the bar 7 downbeat (frame 318) and holds 4.4 s. It reads well in portrait. In landscape, ".yarden-zamir.com" is about a third of the height of "tick3d", which is small on a phone. |

## Checks against the rules

- Length: both MP4s are 15.000 s, at 1920×1080 and 1080×1920 (H.264). The AAC track is 15.019 s. Pass.
- On-screen lines: 3. Pass.
- Theme tokens and font: pass. The only exception is fix 7.
- Key: the energy peaks on C, D, E, G and A. The rest is within what the harmonics of square and bell voices give. Pass. Fix 9 makes this a hard test.
- Hit points: bar 1 downbeat, the win at s16 64 (frame 212), the end card at s16 96 (frame 318). Pass.
- Fade: the last 50 ms are at −64 dB. Pass.
- Centre square:
  - The portrait still of bar 5 puts the bottom layer at about y = 1540, outside the square (y 420–1500).
  - The beam rod in bar 6 crosses the frame edges in both crops. See fix 6.

## Fixes

1. **Bar 1, frame 0: make it an impact frame.** Start layer 3 already falling (about 6 frames before the beat), so frame 0 is the slam: the squash at its maximum and the hard shadow at full offset. Add a camera shake of 1 frame. Frame 0 is the thumbnail, so it has to look like a hit.
2. **Bar 2, frames 53–105: show the game during the dive.** The camera passes through the layers but sees only a yellow slab with black seams. Slow the dive so that it stops just under layer 0 at s16 30, looking up. Each of moves 1–8 then shows as it lands (a piece and its pulse). Frame 103 must not be an empty page.
3. **Bar 4, frames 159–212: give the text clear space.** "76 ways" sits on the back edge of the top layer in both crops. Pull the camera back, or move the line up, so that 40 px of `--page` separates the text and the tower. Use one style for both word groups: the green box on "to win." does not match line 1, where only "In 3D." has a sticker.
4. **Bar 5, s16 64–72 (frames 212–238): show the win as one straight line.** The camera is almost level with the layers, so cell 63 hides behind the top layer, and at frame 225 only cells 0 and 21 read.
   - From s16 64, put the camera square to the diagonal plane of 0, 21, 42 and 63, at about the 62° tilt, so that the four cells read as one rising line.
   - Light one cell per s16 from 68, and draw the joined beam by s16 72 (frame 238).
   - Start the ride only after s16 72.
5. **Bar 5, s16 72–80 (frames 238–265): the ride clips the slabs.** At frame 250, the undersides of slabs fill a third of the frame. Keep the camera path 0.6 cell off the line, and fade any slab within the near distance to 0 % opacity. The beam must be visible in every frame of the ride.
6. **Bars 6–8: clamp the beam.** The rod reaches past the tower and out of the frame (mid-bar 6 in both crops). End it at the centres of cell 0 and cell 63, with a short cap.
7. **Bars 1 and 8: the slam rings.** They are thin, grey, 1 px squares (frames 9, 45 and 380). Draw them in `--line` at 3 px, or remove them.
8. **Audio, s16 50–63 and 72–79: fill the gaps with the game's own sounds.**
   - Bar 4: on each eighth note while a threat blinks, play `sounds.preview` of that cell (cells 4 and 21 at s16 50, 52 and 54, then cell 21 at s16 58, 60 and 62). This is the game's soft preview strike.
   - Bar 5: play the notes of `sounds.win` (C5, E5, G5, C6, E6 in `src/sound.ts`) on s16 72–76, one per s16, so the climax does not drop out. All five notes are in C major pentatonic.
   - Export the smallest function from `src/sound.ts` for this. Do not copy the notes.
9. **Audio test:** add a unit test that schedules the spot and asserts that every pitched voice of the melody, the bass and the chords is in C, D, E, G or A. Timbre partials are exempt. This turns the pass above into a hard check (Tom's rule on #119).
10. **Bar 7, frame 318 onward: the URL in landscape.** Set the cap height of ".yarden-zamir.com" to at least half of the height of "tick3d". Keep the whole URL inside the centre 1080 px.

## Keep

- The theme sweeps on the downbeats, the "In 3D." sticker that echoes the wordmark, the ghost lines in bar 4, the confetti in the theme tokens, and the end card that pulses to the replay.
