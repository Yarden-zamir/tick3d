import { describe, expect, it } from 'vitest';
import { toEpochMs } from './epoch.ts';
import { CELL_COUNT, type Game, newGame, play, replay } from './game.ts';
import { SIXTEENTH, type SongNote, scaleOf, songOf } from './song.ts';

// X takes 0, 1, 2, 3 (a row) and O takes 16, 17, 18.
const WON = replay([0, 16, 1, 17, 2, 18, 3], { times: [0, 1000, 3000, 4000, 9000, 10_000, 60_000].map(toEpochMs) });
// Other games: a long game, a draw, a timeout, and an O start.
const LONG = replay([5, 21, 42, 7, 9, 33, 60, 12, 27, 44, 50, 3]);
const DRAW: Game = { ...replay([5, 21, 42, 7]), status: { kind: 'draw' } };
const TIMEOUT: Game = { ...replay([5, 21]), status: { kind: 'timeout', winner: 'O' } };
const O_FIRST = (() => {
  const result = play(newGame('O'), 5);
  if (!result.ok) throw new Error('the move is legal');
  return { ...result.game, status: { kind: 'timeout', winner: 'O' } } as Game;
})();
// The longest game: 64 moves, every cell once, a draw. songOf reads only the moves, the first player and the status.
const FULL: Game = { ...newGame(), moves: Array.from({ length: CELL_COUNT }, (_, cell) => cell), status: { kind: 'draw' } };
const GAMES = [WON, LONG, DRAW, TIMEOUT, O_FIRST, FULL];
// The longest song, in seconds.
const CAP_SECONDS = 15;

const melody = (notes: readonly SongNote[]) => notes.filter((note) => note.kind === 'melody');

describe('songOf', () => {
  it('puts every melody note on the scale of the song', () => {
    for (const game of GAMES) {
      const song = songOf(game);
      const scale = scaleOf(song.key);
      for (const note of melody(song.notes)) expect(scale).toContain(note.midi % 12);
    }
  });

  it('plays in a given key instead of the key of the moves', () => {
    const key = { root: 0, mode: 'major pentatonic' } as const;
    for (const game of GAMES) {
      const song = songOf(game, key);
      expect(song.key).toEqual(key);
      for (const note of melody(song.notes)) expect(scaleOf(key)).toContain(note.midi % 12);
      // The key changes the pitches, not the rhythm.
      expect(song.notes.map((n) => n.at)).toEqual(songOf(game).notes.map((n) => n.at));
    }
  });

  it('gives the same game the same song', () => {
    expect(songOf(replay(LONG.moves))).toEqual(songOf(LONG));
  });

  it('ends on the tonic: the last melody note and the last bass note', () => {
    for (const game of GAMES) {
      const song = songOf(game);
      const last = melody(song.notes).toSorted((a, b) => a.at - b.at).at(-1);
      const bass = song.notes.filter((note) => note.kind === 'bass').toSorted((a, b) => a.at - b.at).at(-1);
      expect(last?.midi !== undefined && last.midi % 12).toBe(song.key.root);
      expect(bass?.midi !== undefined && bass.midi % 12).toBe(song.key.root);
    }
  });

  it('plays each move in order, by its player, one eighth note apart', () => {
    const notes = melody(songOf(WON).notes).slice(0, WON.moves.length);
    expect(notes.map((note) => note.cell)).toEqual(WON.moves);
    expect(notes.map((note) => note.player)).toEqual(['X', 'O', 'X', 'O', 'X', 'O', 'X']);
    for (const [index, note] of notes.entries()) expect(note.at).toBeCloseTo(index * 2 * SIXTEENTH, 9);
    // X and O sit an octave apart.
    const average = (player: string) => notes.filter((note) => note.player === player).reduce((sum, note) => sum + note.midi, 0) / 3;
    expect(average('X')).toBeGreaterThan(average('O'));
  });

  it('takes the rhythm from the grid, not from the move times', () => {
    const fast = replay(WON.moves);
    expect(songOf(WON).notes).toEqual(songOf(fast).notes);
  });

  it('gives a long game one sixteenth note for each move, and stays under the cap for 64 moves', () => {
    const notes = melody(songOf(FULL).notes).slice(0, CELL_COUNT);
    for (const [index, note] of notes.entries()) expect(note.at).toBeCloseTo(index * SIXTEENTH, 9);
    for (const game of GAMES) {
      const song = songOf(game);
      expect(song.duration).toBeGreaterThan(song.notes.reduce((end, note) => Math.max(end, note.at), 0));
      expect(song.duration).toBeLessThan(CAP_SECONDS);
    }
  });

  it('ends in under 2 seconds after the last move', () => {
    for (const game of GAMES) {
      const song = songOf(game);
      const lastMove = melody(song.notes).filter((note) => note.move !== undefined).reduce((end, note) => Math.max(end, note.at), 0);
      expect(song.duration - lastMove).toBeLessThan(2);
    }
  });

  it('gives different games different keys or melodies', () => {
    const fingerprints = new Set(GAMES.map((game) => JSON.stringify(songOf(game).notes)));
    expect(fingerprints.size).toBe(GAMES.length);
  });

  it('refuses a game without moves', () => {
    expect(() => songOf(newGame())).toThrow(RangeError);
  });
});
