// "Your game as a song": the moves of a finished game as a short melody, as plain data.
// src/sound.ts plays the notes with the voices of a sound set, live or into a sound file.
import { type Game, type Player, other } from './game.ts';

// Seconds from one move to the next.
export const SONG_STEP = 0.3;
// The win line plays again at the end, faster, as a flourish.
export const FLOURISH_STEP = 0.11;
// The last note rings on for this long. The longest voice of a set lasts 0.9 s (src/sound.test.ts).
export const SONG_TAIL = 1.5;

// `scale` makes the voices softer (below 1) or louder (above 1).
type SongNote = { at: number; cell: number; player: Player; scale: number };
export type Song = { notes: readonly SongNote[]; duration: number };

export function songOf(game: Game): Song {
  if (game.moves.length === 0) throw new RangeError('a game without moves has no song');
  let player = game.first;
  const notes: SongNote[] = game.moves.map((cell, index) => {
    const note = { at: index * SONG_STEP, cell, player, scale: 1 };
    player = other(player);
    return note;
  });
  if (game.status.kind === 'won') {
    const { line, winner } = game.status;
    const start = game.moves.length * SONG_STEP;
    line.forEach((cell, index) => notes.push({ at: start + index * FLOURISH_STEP, cell, player: winner, scale: 0.8 }));
  }
  const last = notes.at(-1);
  if (last === undefined) throw new Error('a song needs a note');
  return { notes, duration: last.at + SONG_TAIL };
}
