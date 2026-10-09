import { describe, expect, it } from 'vitest';
import { LINES, linesThrough } from '../../../src/game.ts';
import { frameOf } from '../grid.ts';
import { KINDS, STRONG_CELLS, kindOf, linesOf } from './lines.ts';
import { DURATION_FRAMES, DURATION_SECONDS, END, SECTIONS, eventsOf, sectionAt } from './plan.ts';

describe('the tutorial plan', () => {
  it('lasts at most 25.0 s, in whole frames', () => {
    expect(DURATION_SECONDS).toBeLessThanOrEqual(25);
    expect(Number.isInteger(DURATION_FRAMES)).toBe(true);
  });

  it('runs its sections back to back from 0 to the end, each on a downbeat', () => {
    expect(SECTIONS[0]?.start).toBe(0);
    expect(SECTIONS.at(-1)?.end).toBe(END);
    expect(SECTIONS.slice(0, -1).map((section) => section.end)).toEqual(SECTIONS.slice(1).map((section) => section.start));
    for (const section of SECTIONS) {
      expect(section.start % 16, section.name).toBe(0);
      expect(section.end, section.name).toBeGreaterThan(section.start);
      expect(sectionAt(frameOf(section.start))).toBe(section);
    }
  });

  it('keeps every event and label on a whole sixteenth inside its section', () => {
    for (const section of SECTIONS) {
      for (const at of [...section.events.map((event) => event.at), ...section.labels.flatMap((label) => [label.at, label.stickerAt])]) {
        expect(Number.isInteger(at), section.name).toBe(true);
        expect(at, section.name).toBeGreaterThanOrEqual(section.start);
        expect(at, section.name).toBeLessThan(section.end);
      }
      for (const label of section.labels) expect(label.stickerAt).toBeGreaterThanOrEqual(label.at);
    }
  });

  it('shows each kind once, in order, with an example line of that kind, and counts up to 76', () => {
    const sets = eventsOf('set').map(({ event }) => event.lines);
    expect(sets).toEqual([...KINDS]);
    expect(sets.reduce((sum, kind) => sum + linesOf(kind).length, 0)).toBe(LINES.length);
    for (const { event, section } of eventsOf('line')) {
      expect(LINES).toContainEqual(event.line);
      const set = section.events.find((other) => other.kind === 'set');
      expect(set?.kind === 'set' && set.lines, section.name).toBe(kindOf(event.line));
    }
  });

  it('puts the counts of the code on screen', () => {
    const stickers = SECTIONS.flatMap((section) => section.labels.map((label) => [section.name, label.sticker] as const));
    for (const kind of KINDS) expect(stickers).toContainEqual([kind === 'row' ? 'rows' : kind, `+${linesOf(kind).length}`]);
    expect(SECTIONS.find((section) => section.name === 'all')?.labels[0]?.text).toBe('76 ways');
    expect(stickers).toContainEqual(['strong', '7 lines each']);
    expect(stickers).toContainEqual(['other', '4 lines']);
    // The cells whose lines show: strong cells on 7 lines, the other cell on 4.
    for (const { event } of eventsOf('through')) expect(linesThrough(event.cell)).toHaveLength(STRONG_CELLS.includes(event.cell) ? 7 : 4);
  });
});
