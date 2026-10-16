import { describe, expect, it } from 'vitest';
import { CELL_COUNT, LINES, linesThrough } from '../../../src/game.ts';
import { SIXTEENTH } from '../../../src/song.ts';
import { frameOf } from '../grid.ts';
import { NOTE_DELAY } from '../lettering.ts';
import { KINDS, STRONG_CELLS, kindOf } from './lines.ts';
import { DRAW_BOARD, PACES, TUTORIALS, chaptersOf, eventsOf as planEvents, planOf, sectionAt as planSection } from './plan.ts';
import game from '../../../src/tutorial-chapters.json' with { type: 'json' };

const PLANS = TUTORIALS.flatMap((tutorial) => PACES.map((pace) => [tutorial, pace] as const));
const BASICS = [
  'title', 'turns', 'tap', 'undo', 'drag', 'rows', 'columns', 'pillars', 'flat', 'rising-front', 'rising-side', 'corners-1', 'corners-2', 'all', 'block', 'draw', 'end-card',
];

describe.each(PLANS)('the %s tutorial plan at the %s pace', (tutorial, pace) => {
  const plan = planOf(tutorial, pace);
  const eventsOf = <K extends Parameters<typeof planEvents>[0]>(kind: K) => planEvents(kind, plan.sections);
  const sectionAt = (frame: number) => planSection(frame, plan.sections);

  it('lasts at most 50.0 s, in whole frames', () => {
    expect(plan.seconds).toBeLessThanOrEqual(50);
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

  it('has one checkpoint per section, but one for both rising and both corner sections, in order, each short', () => {
    const chapters = chaptersOf(tutorial, pace);
    expect(chapters).toHaveLength(plan.sections.length - (tutorial === 'basics' ? 2 : 1));
    expect(chapters[0]?.start).toBe(0);
    const starts = chapters.map((chapter) => chapter.start);
    expect(starts).toEqual(starts.toSorted((a, b) => a - b));
    expect(new Set(starts).size).toBe(starts.length);
    chapters.forEach((chapter, i) => {
      // The picture of a checkpoint shows inside it.
      expect(chapter.frame, chapter.headline).toBeGreaterThanOrEqual(chapter.start);
      expect(chapter.frame, chapter.headline).toBeLessThan(chapters[i + 1]?.start ?? plan.seconds);
      expect(chapter.text.split(' ').length, chapter.headline).toBeLessThanOrEqual(25);
    });
  });
});

describe.each(PACES)('the basics tutorial at the %s pace', (pace) => {
  const plan = planOf('basics', pace);
  const eventsOf = <K extends Parameters<typeof planEvents>[0]>(kind: K) => planEvents(kind, plan.sections);

  it('teaches the game in order, without the strong cells', () => {
    expect(plan.sections.map((section) => section.name)).toEqual(BASICS);
    expect(eventsOf('through')).toHaveLength(0);
    expect(eventsOf('strong')).toHaveLength(0);
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
  });

  it('takes turns X first, takes back the X of the tap, and blocks a real line with a tap on its fourth cell', () => {
    const [turns] = eventsOf('turns');
    expect(turns?.section.name).toBe('turns');
    expect(turns?.event.frame).toBe(true);
    const [tap] = eventsOf('tap');
    const [undo] = eventsOf('undo');
    expect(undo?.event.cell).toBe(tap?.event.cell);
    for (const { event, section } of eventsOf('drag')) expect(event.at + event.length).toBeLessThan(section.end);
    const [block, ...rest] = eventsOf('block');
    expect(rest).toHaveLength(0);
    expect(LINES).toContainEqual(block?.event.line);
    expect(eventsOf('tap').map(({ event }) => [event.at, event.cell])).toContainEqual([block?.event.blocked, block?.event.line[3]]);
    expect(block?.event.blocked).toBeGreaterThan((block?.event.at ?? 0) + 2 * (block?.event.gap ?? 0));
  });

  it('fills the cube with the draw board, X and O in turns, inside the draw section', () => {
    const fill = eventsOf('turns').find(({ section }) => section.name === 'draw');
    expect(fill?.event.frame).toBe(false);
    const cells = fill?.event.cells ?? [];
    expect(cells.toSorted((a, b) => a - b)).toEqual(Array.from({ length: CELL_COUNT }, (_, cell) => cell));
    cells.forEach((cell, i) => expect(DRAW_BOARD[cell], `mark ${i}`).toBe(i % 2 === 0 ? 'X' : 'O'));
    expect((fill?.event.at ?? 0) + cells.length * (fill?.event.gap ?? 0)).toBeLessThan(fill?.section.end ?? 0);
  });
});

describe.each(PACES)('the strong cells tutorial at the %s pace', (pace) => {
  const plan = planOf('strong', pace);

  it('shows the 76 ways, then the strong cells, the other cells and "Take them"', () => {
    expect(plan.sections.map((section) => section.name)).toEqual(['title', 'all', 'strong', 'other', 'take', 'end-card']);
  });

  it('puts the counts of the code on screen', () => {
    const stickers = plan.sections.flatMap((section) => section.labels.map((label) => [section.name, label.sticker] as const));
    expect(stickers).toContainEqual(['strong', '7 lines each']);
    expect(stickers).toContainEqual(['other', '4 lines']);
    // The cells whose lines show: strong cells on 7 lines, the other cell on 4.
    for (const { event } of planEvents('through', plan.sections)) expect(linesThrough(event.cell)).toHaveLength(STRONG_CELLS.includes(event.cell) ? 7 : 4);
  });
});

describe('the draw board', () => {
  it('holds 32 X and 32 O, one per cell, as a full game that X starts', () => {
    expect(DRAW_BOARD).toHaveLength(CELL_COUNT);
    expect([...DRAW_BOARD].filter((mark) => mark === 'X')).toHaveLength(32);
    expect([...DRAW_BOARD].filter((mark) => mark === 'O')).toHaveLength(32);
  });

  it('has no line of 4 for X or for O', () => {
    for (const line of LINES) expect(new Set(line.map((cell) => DRAW_BOARD[cell])).size, line.join('-')).toBe(2);
  });
});

describe('the checkpoints of the game (src/tutorial-chapters.json)', () => {
  it('equal the checkpoints of the long basics plan', () => {
    expect(game.chapters).toEqual(chaptersOf('basics', 'long'));
  });

  it('name the web MP4 and the poster of the basics tutorial at one commit', () => {
    const sha = game.video.slice('tick3d-tutorial-basics-'.length, -'-web.mp4'.length);
    expect(game.video).toBe(`tick3d-tutorial-basics-${sha}-web.mp4`);
    expect(sha).toHaveLength(7);
    expect(game.poster).toBe(`tick3d-tutorial-basics-${sha}-poster.jpg`);
  });
});
