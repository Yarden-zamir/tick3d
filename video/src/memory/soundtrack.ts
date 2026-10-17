// The background music of the smart-memory ad, all from the game's sound code and in C major pentatonic: the
// Classic layer notes falling as the board shatters, a soft chord on each downbeat, a soft Cells note on each
// move, the win jingle on the reveal and a final chord. The ad is about memory, not sound: the music only
// follows the picture (issue #130).
import { type ScheduledSound, winVoices } from '../../../src/sound.ts';
import { A_MINOR, C_MAJOR, chord, layerNote, note, pitchOf } from '../notes.ts';
import { MOVES } from './game.ts';
import { END, PLAN, eventOf, eventsOf } from './plan.ts';

export function memorySounds(): ScheduledSound[] {
  const shatter = eventOf('shatter');
  const reveal = eventOf('reveal');
  const final = eventOf('final-chord');
  const sounds: ScheduledSound[] = [];
  // The four layers fall, top to bottom, one per sixteenth.
  [3, 2, 1, 0].forEach((layer, i) => sounds.push(layerNote(shatter.at + i, layer)));
  // A chord on each downbeat from bar 2 to the reveal, C major and A minor in turn.
  for (let at = 16; at < reveal.at; at += 16) sounds.push(...chord(at, (at / 16) % 2 === 1 ? C_MAJOR : A_MINOR));
  // A note on each move, one scale step higher than the move before it.
  eventsOf('move').forEach((event, i) => {
    const cell = MOVES[event.move];
    if (cell === undefined) throw new RangeError(`no move ${event.move}`);
    sounds.push(note(event.at, pitchOf(5 + i), cell));
  });
  winVoices(0).forEach((voice, i) => sounds.push({ at: reveal.at + 1 + i, voices: [voice] }));
  sounds.push(...chord(final.at, [48, 52, 55, 60], 1.2));
  if (sounds.some((sound) => sound.at >= END)) throw new Error(`a sound of the ${PLAN.id} plan starts after its end`);
  return sounds.sort((a, b) => a.at - b.at);
}
