import { describe, expect, it } from 'vitest';
import { LINES, replay } from '../../src/game.ts';
import beatsJson from '../creative/beats.json' with { type: 'json' };
import { parseBeats, withVariant } from '../creative/beats.ts';
import { BEATS, DURATION_FRAMES, GAME, VARIANTS, barAt, boardAt, frameOf, since } from './timeline.ts';

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

  it('merges every variant into a timeline with the same game, text timing and end card, and a real change', () => {
    const base = parseBeats(beatsJson);
    const timing = (beats: typeof base) => beats.text.map((line) => ({ until: line.until, at: line.words.map((word) => word.at) }));
    for (const [name, overlay] of Object.entries(VARIANTS)) {
      if (overlay === undefined) continue;
      const beats = parseBeats(withVariant(beatsJson, overlay));
      expect(beats.moves, name).toEqual(base.moves);
      expect(timing(beats), name).toEqual(timing(base));
      expect(beats.text.at(-1), name).toEqual(base.text.at(-1));
      expect(JSON.stringify({ bars: beats.bars, text: beats.text }), name).not.toBe(JSON.stringify({ bars: base.bars, text: base.text }));
    }
  });

  it('starts the motion of an event on the frame of the event', () => {
    for (const at of [0, 1, 17, 64, 127]) expect(since(frameOf(at), at)).toBe(0);
  });
});
