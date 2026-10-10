import { describe, expect, it } from 'vitest';
import { LINES, linesThrough } from '../../../src/game.ts';
import { SIXTEENTH } from '../../../src/song.ts';
import { frameOf } from '../grid.ts';
import { NOTE_DELAY } from '../lettering.ts';
import { KINDS, STRONG_CELLS, kindOf } from './lines.ts';
import { PACES, eventsOf as planEvents, planOf, sectionAt as planSection } from './plan.ts';

describe.each(PACES)('the %s tutorial plan', (pace) => {
  const plan = planOf(pace);
  const eventsOf = <K extends Parameters<typeof planEvents>[0]>(kind: K) => planEvents(kind, plan.sections);
  const sectionAt = (frame: number) => planSection(frame, plan.sections);

  it('lasts at most 45.0 s, in whole frames', () => {
    expect(plan.seconds).toBeLessThanOrEqual(45);
    expect(Number.isInteger(plan.frames)).toBe(true);
  });

  it('runs its sections back to back from 0 to the end, each on a half bar', () => {
    expect(plan.sections[0]?.start).toBe(0);
    expect(plan.sections.at(-1)?.end).toBe(plan.end);
    expect(plan.sections.slice(0, -1).map((section) => section.end)).toEqual(plan.sections.slice(1).map((section) => section.start));
    for (const section of plan.sections) {
      expect(section.start % 8, section.name).toBe(0);
      expect(section.end, section.name).toBeGreaterThan(section.start);
      expect(sectionAt(frameOf(section.start))).toBe(section);
    }
  });

  it('keeps every event and label on a whole sixteenth inside its section', () => {
    for (const section of plan.sections) {
      for (const at of [...section.events.map((event) => event.at), ...section.labels.flatMap((label) => [label.at, label.stickerAt])]) {
        expect(Number.isInteger(at), section.name).toBe(true);
        expect(at, section.name).toBeGreaterThanOrEqual(section.start);
        expect(at, section.name).toBeLessThan(section.end);
      }
      for (const label of section.labels) expect(label.stickerAt).toBeGreaterThanOrEqual(label.at);
    }
  });

  it('ends on the end card of the spot, with every word on screen for at least 1 s', () => {
    const [card, ...rest] = eventsOf('end-card');
    expect(rest).toHaveLength(0);
    expect(card?.event.words.map((word) => word.text)).toEqual(['tick3d', '.yarden-zamir.com', 'Play in your browser.', 'App Store', 'Google Play']);
    for (const word of card?.event.words ?? []) {
      const last = word.note === undefined ? word.at : word.at + NOTE_DELAY;
      expect((plan.end - last) * SIXTEENTH, word.text).toBeGreaterThanOrEqual(1);
    }
  });

  it('shows the kinds in order, each set inside its kind, with every line once, so the counter reaches 76', () => {
    const sets = eventsOf('set').map(({ event }) => event);
    expect([...new Set(sets.map((set) => set.of))]).toEqual([...KINDS]);
    expect(sets.map((set) => KINDS.indexOf(set.of))).toEqual(sets.map((set) => KINDS.indexOf(set.of)).toSorted((a, b) => a - b));
    for (const set of sets) for (const line of set.lines) expect(kindOf(line)).toBe(set.of);
    const shown = sets.flatMap((set) => set.lines.map((line) => line.join('-')));
    expect(shown.toSorted()).toEqual(LINES.map((line) => line.join('-')).toSorted());
    for (const { event, section } of eventsOf('line')) {
      expect(LINES).toContainEqual(event.line);
      const set = section.events.find((other) => other.kind === 'set');
      expect(set?.kind === 'set' && set.lines, section.name).toContainEqual(event.line);
    }
  });

  it('gives the rising and the space diagonals twice the time of each easy kind', () => {
    const bars = (kind: string) => eventsOf('set').filter(({ event }) => event.of === kind).reduce((sum, { section }) => sum + (section.end - section.start) / 16, 0);
    for (const hard of ['rising-diagonal', 'space-diagonal']) for (const easy of ['column', 'pillar', 'flat-diagonal']) expect(bars(hard)).toBe(2 * bars(easy));
  });

  it('puts the counts of the code on screen', () => {
    const stickers = plan.sections.flatMap((section) => section.labels.map((label) => [section.name, label.sticker] as const));
    for (const { event, section } of eventsOf('set')) expect(stickers).toContainEqual([section.name, `+${event.lines.length}`]);
    expect(plan.sections.find((section) => section.name === 'all')?.labels[0]?.text).toBe('76 ways');
    expect(stickers).toContainEqual(['strong', '7 lines each']);
    expect(stickers).toContainEqual(['other', '4 lines']);
    // The cells whose lines show: strong cells on 7 lines, the other cell on 4.
    for (const { event } of eventsOf('through')) expect(linesThrough(event.cell)).toHaveLength(STRONG_CELLS.includes(event.cell) ? 7 : 4);
  });
});
