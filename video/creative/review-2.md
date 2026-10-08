# Review 2

APPROVED

Render: head 143e7c3 on `feat/video-creative`. It applies fixes 1 to 10 of review 1.
Sources: the stills per bar, a sheet of 16 frames from the landscape MP4, and the portrait stills of bars 4 and 5.
Frame of s16 n = `Math.round(n * SIXTEENTH * 30)`.

## Review 1 fixes

| Fix | Result | Note |
|---|---|---|
| 1. Impact frame 0 | Pass | Frame 0 is the slam, with the hard shadow plate at full offset. |
| 2. Game in the dive | Pass | The layers open and the pieces read from frame 80. Frame 103 is no longer empty. Moves 1 and 2 land hidden under layer 3 (Reel's note). |
| 3. Clear space for line 2 | Pass, landscape only | In portrait, the "to win." sticker touches the back corner of the top layer. See item 1 below. Both lines now use the same pattern: the second word group is a sticker. |
| 4. Win as one straight line | Pass | Frames 212 to 238 are square to the diagonal, and the beam joins by frame 238. |
| 5. Clean ride | Pass | The near slabs fade, and the beam shows at frame 250. |
| 6. Clamped beam | Pass | The rod ends at cells 0 and 63 (frames 290 and 318). |
| 7. Slam rings | Pass | The ring at frame 9 is thick now. It fades out, so it reads grey on `--page`. |
| 8. Fill the quiet bars | Pass | The threat pulses and the win jingle are in commit 518a5ed, and `music.md` and `beats.json` list them. |
| 9. Hard pitch test | Pass | The test is in `src/sound.test.ts`. |
| 10. URL size in landscape | Pass | The x-height of ".yarden-zamir.com" is about half the height of "tick3d". The URL spans x 480–1440, inside the centre square. |

## Scores

| Criterion | Score | Why |
|---|---|---|
| Hook | 4 | Frame 0 is a real hit: the slam, the shadow and the Classic note together. |
| Clarity | 4 | The dive shows the game, the double threat reads, and the win reads as one line through four layers. |
| Rhythm | 4 | The cuts, the moves, the words and the new fills sit on the grid. The climax no longer drops out. |
| Brand fit | 4 | The tokens, Bricolage, the dot grid, the hard shadows and the sticker wordmark all match the game. |
| Call to action | 5 | The URL lands on the bar 7 downbeat, holds 4.4 s, and reads in both crops. |

## Optional polish (not needed for approval)

1. **Bar 4, portrait, s16 48–62 (frames 159–206):** move line 2 up about 40 px, so that the "to win." sticker clears the top layer.
2. **Bar 5, s16 77–79 (frames about 255–263):** the ride ends on an almost empty frame, with only a green glow at the bottom. End the ride with cell 63 still in frame, then hit the bar 6 downbeat.
3. **Bar 2, s16 16–18:** open the gap under layer 3 before s16 16, so that moves 1 and 2 show too.
4. **Bars 1 and 8:** if the slam ring has to read as `--line`, keep it at full `--line` color while it shrinks, and fade only in its last 2 frames.
