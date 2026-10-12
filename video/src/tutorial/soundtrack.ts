// The sounds of the tutorial, all from the game's sound code and in C major pentatonic: a soft Cells note for
// each lit cell and each line that shows, a soft chord when a set of lines flashes, the Classic note of each
// layer, the win jingle and a final chord. No bass, no glass bell (maintainer feedback on #119).
import { type ScheduledSound, winVoices } from '../../../src/sound.ts';
import { linesThrough } from '../../../src/game.ts';
import { A_MINOR, C_MAJOR, chord, layerNote, note, pitchOf } from '../notes.ts';
import { KINDS, linesOf } from './lines.ts';
import { SECTIONS } from './plan.ts';

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
