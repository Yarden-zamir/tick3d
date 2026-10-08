import { describe, expect, it } from 'vitest';
import { LINES, replay } from '../../src/game.ts';
import { BEATS, DURATION_FRAMES, GAME, barAt, boardAt, frameOf, since } from './timeline.ts';

describe('the timeline', () => {
  it('lasts 15.0 s at 30 fps', () => {
    expect(DURATION_FRAMES).toBe(450);
  });

  it('shows the board of the moves so far at the frame of each move, and one frame before it', () => {
    BEATS.moves.forEach((move, i) => {
      const cells = BEATS.moves.slice(0, i + 1).map((m) => m.cell);
      expect(boardAt(frameOf(move.at))).toEqual(replay(cells).board);
      expect(boardAt(frameOf(move.at) - 1)).toEqual(replay(cells.slice(0, -1)).board);
    });
  });

  it('ends on the winning line of beats.json, a real line', () => {
    expect(GAME.status).toEqual({ kind: 'won', winner: BEATS.game.winner, line: BEATS.game.line });
    expect(LINES).toContainEqual(BEATS.game.line);
  });

  it('starts every bar on the frame of its downbeat, and keeps bar 8 for the final chord', () => {
    for (const bar of BEATS.bars) expect(barAt(frameOf(bar.start))).toBe(bar);
    for (const bar of BEATS.bars.slice(1)) expect(barAt(frameOf(bar.start) - 1).bar).toBe(bar.bar - 1);
    expect(barAt(DURATION_FRAMES - 1).bar).toBe(8);
  });

  it('starts the motion of an event on the frame of the event', () => {
    for (const at of [0, 1, 17, 64, 127]) expect(since(frameOf(at), at)).toBe(0);
  });
});
