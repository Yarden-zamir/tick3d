// The sounds of the tutorial, all from the game's sound code and in C major pentatonic: a soft Cells note for
// each lit cell and each line that shows, a soft chord when a set of lines flashes, the Classic note of each
// layer, the win jingle and a final chord. No bass, no glass bell (maintainer feedback on #119).
import { type ScheduledSound, winVoices } from '../../../src/sound.ts';
import { SOUND_SETS, type SoundSet } from '../../../src/sound-sets.ts';
import { linesThrough } from '../../../src/game.ts';
import { SCALE, inKey, landing, midiOf, withoutBell } from '../key.ts';
import { KINDS, linesOf } from './lines.ts';
import { SECTIONS } from './plan.ts';

const CELLS = withoutBell(SOUND_SETS.cells);
// The melody notes play softer than a move: a calm mix (maintainer feedback on #119).
const LEVEL = 0.55;
// The chords: C major (C E G) and A minor (A C E), both inside the pentatonic scale.
const C_MAJOR = [60, 64, 67] as const;
const A_MINOR = [57, 60, 64] as const;
const CHORD_SECONDS = 0.8;

// The MIDI note of scale degree `degree` above C4.
function pitchOf(degree: number): number {
  const step = SCALE[degree % SCALE.length];
  if (step === undefined) throw new RangeError(`no degree ${degree}`);
  return 60 + 12 * Math.floor(degree / SCALE.length) + step;
}

// A melody note with the voice of `cell` in `set`, cut to the key.
function note(at: number, midi: number, cell: number, set: SoundSet = CELLS, level = LEVEL): ScheduledSound {
  return { at, note: { kind: 'melody', at: 0, midi, player: 'X', cell, level }, set: inKey(set, midi) };
}

// The notes of a chord. A chord note plays a soft triangle; the set only names it.
const chord = (at: number, notes: readonly number[], length = CHORD_SECONDS): ScheduledSound[] =>
  notes.map((midi) => ({ at, note: { kind: 'chord', at: 0, midi, length }, set: CELLS }));

// The Classic note of a layer, as X plays it: C5, D5, E5 or G5.
function layerNote(at: number, layer: number): ScheduledSound {
  const [voice] = SOUND_SETS.classic.voices(layer * 16, 'X');
  const pitch = voice === undefined ? undefined : landing(voice);
  if (pitch === undefined) throw new Error('Classic has no pitched voice');
  return note(at, Math.round(midiOf(pitch)), layer * 16, SOUND_SETS.classic, 0.9);
}

export function tutorialSounds(): ScheduledSound[] {
  const sounds: ScheduledSound[] = [];
  let examples = 0;
  let sets = 0;
  for (const event of SECTIONS.flatMap((section) => section.events)) {
    switch (event.kind) {
      case 'layer-pulse':
        sounds.push(layerNote(event.at, event.layer));
        break;
      case 'line': {
        // A rising run, one note per cell. Each example line starts one step higher than the one before it.
        const start = examples++;
        event.line.forEach((cell, i) => sounds.push(note(event.at + i * event.gap, pitchOf(start + i), cell)));
        break;
      }
      case 'set':
        sounds.push(...chord(event.at, sets++ % 2 === 0 ? C_MAJOR : A_MINOR));
        break;
      case 'all':
        KINDS.forEach((kind, k) => {
          const [first] = linesOf(kind);
          if (first === undefined) throw new Error(`no ${kind} line`);
          sounds.push(note(event.at + k, pitchOf(5 + k), first[0]));
        });
        break;
      case 'through':
        // One note per line: 7 notes for a strong cell, 4 for any other cell.
        linesThrough(event.cell).forEach((_, i) => sounds.push(note(event.at + event.gap * (i + 1), pitchOf(i), event.cell)));
        break;
      case 'strong':
        sounds.push(...chord(event.at, C_MAJOR), ...chord(event.at + 4, A_MINOR));
        break;
      case 'jingle':
        winVoices(0).forEach((voice, i) => sounds.push({ at: event.at + i, voices: [voice] }));
        break;
      case 'final-chord':
        sounds.push(...chord(event.at, [48, 52, 55, 60], 1.2));
        break;
      case 'end-card':
        break;
    }
  }
  return sounds.sort((a, b) => a.at - b.at);
}
