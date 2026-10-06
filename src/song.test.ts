import { describe, expect, it } from 'vitest';
import { CELL_COUNT, play, replay, newGame, type Game } from './game.ts';
import { FLOURISH_STEP, SONG_STEP, SONG_TAIL, songOf } from './song.ts';

// X takes 0, 1, 2, 3 (a row) and O takes 16, 17, 18.
const WON = replay([0, 16, 1, 17, 2, 18, 3]);

describe('songOf', () => {
  it('plays each move in order, one step apart, X and O in turn', () => {
    const song = songOf(WON);
    const moves = song.notes.slice(0, WON.moves.length);
    expect(moves.map((note) => note.cell)).toEqual(WON.moves);
    expect(moves.map((note) => note.player)).toEqual(['X', 'O', 'X', 'O', 'X', 'O', 'X']);
    moves.forEach((note, index) => expect(note.at).toBeCloseTo(index * SONG_STEP));
  });

  it('starts with the first player of the game', () => {
    const first = play(newGame('O'), 5);
    if (!first.ok) throw new Error('the move is legal');
    expect(songOf(first.game).notes.map((note) => note.player)).toEqual(['O']);
  });

  it('ends a won game with the win line of the winner, faster than the moves', () => {
    const flourish = songOf(WON).notes.slice(WON.moves.length);
    expect(flourish.map((note) => note.cell)).toEqual([0, 1, 2, 3]);
    expect(flourish.every((note) => note.player === 'X')).toBe(true);
    expect(FLOURISH_STEP).toBeLessThan(SONG_STEP);
    const lastMove = (WON.moves.length - 1) * SONG_STEP;
    expect(flourish[0]?.at).toBeGreaterThan(lastMove);
  });

  it('has no flourish without a win line', () => {
    const timeout: Game = { ...replay([0, 16]), status: { kind: 'timeout', winner: 'O' } };
    expect(songOf(timeout).notes).toHaveLength(2);
  });

  it('lets the last note ring, and stays short for the longest game', () => {
    const song = songOf(WON);
    expect(song.duration).toBeCloseTo((song.notes.at(-1)?.at ?? 0) + SONG_TAIL);
    expect(song.duration).toBeLessThanOrEqual(CELL_COUNT * SONG_STEP + 4 * FLOURISH_STEP + SONG_TAIL);
    // The quick tempo: about 250 to 350 ms for each move.
    expect(SONG_STEP).toBeGreaterThanOrEqual(0.25);
    expect(SONG_STEP).toBeLessThanOrEqual(0.35);
  });

  it('refuses a game without moves', () => {
    expect(() => songOf(newGame())).toThrow(RangeError);
  });
});
