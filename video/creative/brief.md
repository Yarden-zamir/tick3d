# Brief: the 15 s tick3d spot

## Reasons (there is no input.md)

- **Audience:** people who scroll Reels, Shorts, TikTok and X, and who know tic-tac-toe. They know the 3×3 game is solved and dull. They do not know a 3D version that is quick to start.
- **Proposition:** a known game, with a new dimension. The viewer understands the rule in one second and sees why it is harder.
- **Call to action:** the URL `tick3d.yarden-zamir.com`. The game runs in the browser, so the URL is the shortest path to a first move.

## Single-minded proposition

Tic-tac-toe, four in a row, in a 4×4×4 cube.

## Supporting points (each one is true in the code)

1. **76 ways to win.** `LINES` in `src/game.ts` has 76 lines. The spot does not say it (maintainer feedback on #119).
2. **Every cell has its own sound, and a game becomes a song.** `src/sound-sets.ts` (13 sets) and `songOf` in `src/song.ts` (136 BPM). README: "Your game as a song".
3. **Twelve themes.** The `[data-theme]` blocks in `src/style.css`.

## Tone

Loud, flat and quick, like the UI: thick black lines, hard shadows, flat color. Confident, never boastful. The music sets the pace: every cut and every word lands on the 136 BPM grid.

## Mandatory

- 15.0 s: 8 bars at 136 BPM (14.118 s), then the final chord rings to 15.0 s.
- At most 4 on-screen lines (`tools/check-beats.ts`). No claim that the code does not prove. No people, no voice-over, no stock footage.
- Every frame drawn by three.js. Only the game's own sound code makes the audio.
- The game on screen is the seeded self-play of `src/ai.ts`. Every move is legal, and the win is a line in `LINES`.

## The 3 lines of the base cut (the variants in `script.md` add or swap one)

1. "4 in a row. In 3D."
2. "Every cell has a note." (supporting point 2)
3. "tick3d.yarden-zamir.com" (the "tick3d" part is the wordmark).
