import { describe, expect, it } from 'vitest';
import { LAYER_GAP, MIN_CELL, chooseLayout } from './fit.ts';

// The width of `count` layers side by side, as training.css draws them.
const layersWidth = (cell: number, count: number) => count * (cell * 4.5 + 12) + (count - 1) * LAYER_GAP;

describe('deck layout', () => {
  it('puts four layers in a row on a wide screen', () => {
    const layout = chooseLayout(1100, 420);
    expect(layout.mode).toBe('row');
    expect(layersWidth(layout.cell, 4)).toBeLessThanOrEqual(1100);
  });

  it('uses 2 × 2 when a row of four is too narrow but the height is there', () => {
    const layout = chooseLayout(560, 700);
    expect(layout.mode).toBe('grid');
    expect(layersWidth(layout.cell, 2)).toBeLessThanOrEqual(560);
  });

  it('scrolls on a phone, with tap targets of at least the minimum size and a peek of the next layer', () => {
    const portrait = chooseLayout(320, 440);
    expect(portrait).toMatchObject({ mode: 'scroll', perView: 1 });
    expect(layersWidth(portrait.cell, 1)).toBeLessThan(320);
    const landscape = chooseLayout(520, 280);
    expect(landscape).toMatchObject({ mode: 'scroll', perView: 2 });
    for (const layout of [portrait, landscape]) expect(layout.cell).toBeGreaterThanOrEqual(MIN_CELL);
  });

  it('keeps the cells large enough to tap on a tiny screen', () => {
    expect(chooseLayout(150, 120).cell).toBe(MIN_CELL);
  });

  it('refuses a deck without room', () => {
    expect(() => chooseLayout(0, 300)).toThrow();
    expect(() => chooseLayout(300, Number.NaN)).toThrow();
  });
});

describe('display deck layout', () => {
  it('keeps all four layers in view (2 × 2) on a phone when the page accepts smaller cells', () => {
    expect(chooseLayout(326, 330, 20)).toMatchObject({ mode: 'grid', perView: 4 });
    // The trainer keeps its tap-sized cells on the same screen.
    expect(chooseLayout(326, 330).mode).toBe('scroll');
  });
});
