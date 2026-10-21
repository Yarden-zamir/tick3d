// The sounds of the tutorial, all from the game's sound code and in C major pentatonic: a soft Cells note for
// each lit cell and each line that shows, for each mark, tap, undo and drag beat, a soft chord when a set of lines
// flashes, a line is blocked or the cube is full, the Classic note of each layer, the win jingle and a final chord. No bass, no glass bell (maintainer feedback on #119).
import { type ScheduledSound, winVoices } from '../../../src/sound.ts';
import { SOUND_SETS, type SoundSet } from '../../../src/sound-sets.ts';
import { type Player, linesThrough } from '../../../src/game.ts';
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

// A melody note of `player` with the voice of `cell` in `set`, cut to the key.
function note(at: number, midi: number, cell: number, set: SoundSet = CELLS, level = LEVEL, player: Player = 'X'): ScheduledSound {
  return { at, note: { kind: 'melody', at: 0, midi, player, cell, level }, set: inKey(set, midi) };
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
      case 'tap':
        sounds.push(note(event.at, pitchOf(5), event.cell));
        break;
      case 'drag':
        // A rising note on each beat of the drag.
        for (let i = 0; i * 4 <= event.length; i++) sounds.push(note(event.at + i * 4, pitchOf(2 + i), 0));
        break;
      case 'block':
        // The O fall one step per piece, A minor on the threat, C major on the block (the tap plays the X).
        event.line.slice(0, 3).forEach((cell, i) => sounds.push(note(event.at + i * event.gap, pitchOf(4 - i), cell, CELLS, LEVEL, 'O')));
        sounds.push(...chord(event.at + 3 * event.gap, A_MINOR), ...chord(event.blocked, C_MAJOR));
        break;
      case 'turns':
        // A note per mark on a whole sixteenth: every mark of a slow turn, every fourth of the fast fill.
        event.cells.forEach((cell, i) => {
          const at = event.at + i * event.gap;
          if (Number.isInteger(at)) sounds.push(note(at, pitchOf(i % 2 === 0 ? 3 + (i % 3) : 5 + (i % 3)), cell, CELLS, LEVEL, i % 2 === 0 ? 'X' : 'O'));
        });
        break;
      case 'undo':
        sounds.push(note(event.at, pitchOf(4), event.cell), note(event.at + 1, pitchOf(2), event.cell));
        break;
      case 'chord':
        sounds.push(...chord(event.at, C_MAJOR));
        break;
      case 'end-card':
        break;
    }
  }
  return sounds.sort((a, b) => a.at - b.at);
}
