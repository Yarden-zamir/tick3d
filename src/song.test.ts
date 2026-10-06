import { describe, expect, it } from 'vitest';
import { CELL_COUNT, type Game, newGame, play, replay } from './game.ts';
import { EIGHTH, MAX_EIGHTHS, MIN_EIGHTHS, type SongNote, eighthsOf, scaleOf, songOf } from './song.ts';

// X takes 0, 1, 2, 3 (a row) and O takes 16, 17, 18.
const WON = replay([0, 16, 1, 17, 2, 18, 3], { times: [0, 1000, 3000, 4000, 9000, 10_000, 60_000] });
// Other games: a long game, a draw, a timeout, and an O start.
const LONG = replay([5, 21, 42, 7, 9, 33, 60, 12, 27, 44, 50, 3]);
const DRAW: Game = { ...replay([5, 21, 42, 7]), status: { kind: 'draw' } };
const TIMEOUT: Game = { ...replay([5, 21]), status: { kind: 'timeout', winner: 'O' } };
const O_FIRST = (() => {
  const result = play(newGame('O'), 5);
  if (!result.ok) throw new Error('the move is legal');
  return { ...result.game, status: { kind: 'timeout', winner: 'O' } } as Game;
})();
const GAMES = [WON, LONG, DRAW, TIMEOUT, O_FIRST];

const melody = (notes: readonly SongNote[]) => notes.filter((note) => note.kind === 'melody');

describe('songOf', () => {
  it('puts every melody note on the scale of the song', () => {
    for (const game of GAMES) {
      const song = songOf(game);
      const scale = scaleOf(song.key);
      for (const note of melody(song.notes)) expect(scale).toContain(note.midi % 12);
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

  it('plays each move in order, by its player, on the eighth-note grid', () => {
    const notes = melody(songOf(WON).notes).slice(0, WON.moves.length);
    expect(notes.map((note) => note.cell)).toEqual(WON.moves);
    expect(notes.map((note) => note.player)).toEqual(['X', 'O', 'X', 'O', 'X', 'O', 'X']);
    for (const note of notes) expect(Math.abs(note.at / EIGHTH - Math.round(note.at / EIGHTH))).toBeLessThan(1e-9);
    // X and O sit an octave apart.
    const average = (player: string) => notes.filter((note) => note.player === player).reduce((sum, note) => sum + note.midi, 0) / 3;
    expect(average('X')).toBeGreaterThan(average('O'));
  });

  it('keeps each move between an eighth note and a half note, so a long think leaves no silence', () => {
    expect(eighthsOf(1)).toBe(MIN_EIGHTHS);
    expect(eighthsOf(600_000)).toBe(MAX_EIGHTHS);
    const notes = melody(songOf(WON).notes).slice(0, WON.moves.length);
    for (const [index, note] of notes.slice(1).entries()) {
      const gap = (note.at - (notes[index]?.at ?? 0)) / EIGHTH;
      expect(gap).toBeGreaterThanOrEqual(MIN_EIGHTHS - 1e-9);
      expect(gap).toBeLessThanOrEqual(MAX_EIGHTHS + 1e-9);
    }
  });

  it('stays bounded for the longest game', () => {
    const song = songOf(WON);
    expect(song.duration).toBeGreaterThan(song.notes.reduce((end, note) => Math.max(end, note.at), 0));
    expect(CELL_COUNT * MAX_EIGHTHS * EIGHTH).toBeLessThan(80);
  });

  it('gives different games different keys or melodies', () => {
    const fingerprints = new Set(GAMES.map((game) => JSON.stringify(songOf(game).notes)));
    expect(fingerprints.size).toBe(GAMES.length);
  });

  it('refuses a game without moves', () => {
    expect(() => songOf(newGame())).toThrow(RangeError);
  });
});
