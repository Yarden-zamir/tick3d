import { describe, expect, it } from 'vitest';
import { SIXTEENTH } from '../../../src/song.ts';
import { FORMATS, areaOf } from './formats.ts';
import { FORK_MOVE, MOVES, playerOf } from './game.ts';
import { PLAN_IDS, eventOf, eventsOf as planEvents, planOf, stillsOf, typingOf } from './plan.ts';

// The limits of issue #130: the length, the number of text lines, and the words of a line.
const LIMITS = { full: { seconds: 15, lines: 3 }, short: { seconds: 8, lines: 2 } } as const;
const MAX_WORDS = 6;

describe.each(PLAN_IDS)('the %s plan of the smart-memory ad', (id) => {
  const plan = planOf(id);
  const { cut } = plan;
  const end = plan.seconds / SIXTEENTH;
  const eventsOf = <K extends Parameters<typeof planEvents>[0]>(kind: K) => planEvents(kind, plan);

  it('stays inside its length limit, in whole frames', () => {
    expect(plan.seconds).toBeLessThanOrEqual(LIMITS[cut].seconds);
    expect(Number.isInteger(plan.seconds * 30)).toBe(true);
  });

  it('has few, short text lines', () => {
    expect(plan.text.length).toBeLessThanOrEqual(LIMITS[cut].lines);
    for (const line of plan.text) expect(line.text.split(' ').length, line.text).toBeLessThanOrEqual(MAX_WORDS);
  });

  it('opens on the hook: the shatter is the first big motion, and the first line shows within 2 s', () => {
    const shatter = eventOf('shatter', plan);
    expect(plan.events.every((event) => event.at >= shatter.at)).toBe(true);
    expect(shatter.at * SIXTEENTH).toBeLessThan(1);
    expect((plan.text[0]?.at ?? Infinity) * SIXTEENTH).toBeLessThan(2);
  });

  it('tells the story in order: shatter, then Hide coordinates and the threats, reveal, end card, final chord', () => {
    const times = (['shatter', 'reveal', 'end-card', 'final-chord'] as const).map((kind) => eventOf(kind, plan).at);
    expect(times).toEqual(times.toSorted((a, b) => a - b));
    for (const kind of ['mask', 'threats'] as const) {
      expect(eventOf(kind, plan).at).toBeGreaterThanOrEqual(eventOf('shatter', plan).at);
      expect(eventOf(kind, plan).at).toBeLessThan(eventOf('reveal', plan).at);
    }
    expect(eventOf('final-chord', plan).at).toBeLessThan(end);
  });

  it('shows the real moves in order from the first move on, to the winning move, with the keypad up', () => {
    const moves = eventsOf('move');
    const keypad = eventOf('keypad', plan);
    expect(moves.map((event) => event.move)).toEqual(Array.from({ length: MOVES.length - plan.firstMove }, (_, i) => plan.firstMove + i));
    for (const event of moves) {
      expect(event.at).toBeGreaterThan(keypad.at);
      expect(event.at).toBeLessThanOrEqual(keypad.until);
      const typing = typingOf(event);
      expect(typing).toHaveLength(playerOf(event.move) === 'X' ? 3 : 0);
      expect(typing.every((at) => at >= keypad.at)).toBe(true);
    }
    expect(moves.map((event) => event.at)).toEqual(moves.map((event) => event.at).toSorted((a, b) => a - b));
    expect(moves.at(-1)?.at).toBeLessThan(eventOf('reveal', plan).at);
  });

  it('keeps the double threat on screen in a full cut', () => {
    if (cut !== 'full') return;
    expect(plan.firstMove).toBeLessThanOrEqual(FORK_MOVE);
    expect(eventOf('threats', plan).at).toBeLessThan(eventsOf('move').find((event) => event.move === FORK_MOVE)?.at ?? -1);
  });

  it('has a still of each part inside the cut', () => {
    for (const still of stillsOf(plan)) {
      expect(still.frame).toBeGreaterThanOrEqual(0);
      expect(still.frame).toBeLessThan(plan.seconds * 30);
    }
  });
});

describe('the formats', () => {
  it('lay out in the safe area: in 9:16, out of the top 14 % and the bottom 35 %', () => {
    for (const { width, height, safeTop, safeBottom } of Object.values(FORMATS)) {
      const area = areaOf(width, height);
      expect(area.y - area.size / 2).toBeGreaterThanOrEqual(safeTop);
      expect(area.y + area.size / 2).toBeLessThanOrEqual(safeBottom);
      expect(area.size).toBeLessThanOrEqual(width);
    }
    const story = FORMATS['9x16'];
    expect(story.safeTop).toBeGreaterThanOrEqual(0.14 * story.height);
    expect(story.safeBottom).toBeLessThanOrEqual(0.65 * story.height);
  });
});
