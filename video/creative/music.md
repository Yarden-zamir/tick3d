# Music

**Verdict: no Suno track is needed. The game's sound code covers the spot.**

This page follows the maintainer audio rule on #119 ([comment](https://github.com/Yarden-zamir/tick3d/issues/119#issuecomment-6068420700)).

## Why the game's sound code is enough

- `songOf` in `src/song.ts` already gives a full arrangement: a melody on every move, a bass on every beat, a win run and a final chord.
- The spot has a move or a hit on almost every eighth note of bars 1 to 6. A second track under it would mask the move sounds, and the rule says that they stay audible.
- The only gap is bar 7 after the replay (s16 106 to 112). The end card text fills it on screen, and bar 8 has the four Classic layer notes.

**Trigger to revisit:** a review scores Rhythm or Hook below 4 because the sound is thin. Then fill in the hand-off below, and a person runs Suno.

## Timing

- 15.0 s at 136 BPM (`src/song.ts`). 8 bars (14.118 s), then the final chord rings to 15.0 s.
- Hits: bar 1 downbeat (the first layer slam), bar 5 downbeat (the win), bar 7 downbeat (the end card).

## Key

C major pentatonic: C, D, E, G, A. `songOf` picks its key from a hash of the moves (A dorian for this game). The spot forces `{ root: 0, mode: 'major pentatonic' }` (`songKey` in `beats.json`).

Two sets add interval voices on top of the melody note. Some of those leave the scale:

- Cells: `WIDTHS` (`src/sound-sets.ts` line 99) adds a fifth. Over E it gives B.
- Chiptune: `CHIP_STEPS` (`src/sound-sets.ts` line 241) adds a major third, and `melodyVoices` keeps the first step. Over D it gives F#.

In the spot, drop an added interval voice that leaves the scale. Keep the timbre partials (the bell, the marimba harmonic).

## Palette (only these three sets)

| Part | Set | Source |
|---|---|---|
| Layer slams (bars 1 and 8), C5 D5 E5 G5 | Classic: a triangle blip with a soft octave overtone | `classicTone` line 59, `LAYER_NOTES` line 56, `classic` line 64 |
| Melody, bars 2, 4, 6, 7 | Cells: marimba, glass bell, plucked string, airy whistle (one per row) | `CELL_INSTRUMENTS` line 100, `cells` line 141 |
| Melody, bars 3 and 5 (the win run) | Chiptune: square lead for X, triangle an octave lower for O | `CHIP_NOTES` line 240, `chiptune` line 251 |
| Bass and final chord | The triangle voices of `noteVoices` | `src/sound.ts` line 162 |

## Structure per bar

| Bar | Sound |
|---|---|
| 1 | Four Classic slams: G5, E5, D5, C5, one per beat. |
| 2 | Cells melody on eighth notes, bass on the beats. |
| 3 | Chiptune melody on sixteenth notes, bass on the beats. |
| 4 | Two Cells notes (the fork, the block). The preview strike of each blinking threat cell on the eighth notes (s16 50–54 for cells 4 and 21, 58–62 for cell 21), softer than a move. No bass. |
| 5 | The win note on the downbeat (Chiptune), the 4-note win run on s16 68–71, then the win jingle of the game (C5 E5 G5 C6 E6, triangle) on 72–76, one note per s16. |
| 6–7 | The replay: 27 Cells notes, one per s16 (80–106). |
| 8 | Four Classic notes rising: C5, D5, E5, G5. Then the final C major chord on s16 128. |

## Suno v6 hand-off (only if the trigger fires)

Adjusted from the template on #119. Do not run it before the trigger fires.

**Style:**
```
Instrumental 8-bit chiptune and mallet pop, 136 BPM, C major pentatonic, bright and playful.
Short triangle-wave blips with soft octave overtones, wooden marimba, glass bell, plucked string, airy whistle,
square-wave lead, triangle-wave bass one octave lower. Dry, punchy, tight, game UI sound design,
puzzle board game theme. Four falling blips, then fast mallet eighth notes that double to sixteenths,
a sudden stop, a bright four-note square-wave win run, mallet replay, four rising blips, one held tonic chord.
15 seconds.
```

**Lyrics:**
```
[Instrumental]
[Intro: four falling blips, G E D C]
[Build: marimba and bell eighth notes, then square-wave sixteenths]
[Break: two notes, silence]
[Climax: square lead win run up the tonic chord]
[Replay: fast marimba run]
[Outro: four rising blips C D E G, one held C major chord]
```

**Exclude styles:**
```
vocals, choir, rap, spoken word, drums kit, heavy bass drop, distorted guitar, orchestral strings,
reverb wash, lo-fi vinyl noise, minor key, dissonance, sound effects, crowd, ambient pads
```

**Checks before a Suno track goes in:**
- [ ] Instrumental, no vocals.
- [ ] 136 BPM (±1). The hits land on the bar 1, bar 5 and bar 7 downbeats.
- [ ] Every melody note is in C major pentatonic.
- [ ] The instruments match the palette. If not, regenerate; do not edit it to fit.
- [ ] Mixed under the game's move sounds, which stay audible on every move.
- [ ] The Suno plan allows commercial use. Plan and date: _not recorded, no track yet_.
