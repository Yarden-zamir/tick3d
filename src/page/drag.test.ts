// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { startsDrag } from './drag.ts';

// The rule runs against the real stage markup, so a new control in the stage shows up here.
// The stage only: the rest of the page loads scripts and styles that the test does not need.
beforeAll(() => {
  const html = readFileSync(join(import.meta.dirname, '../../index.html'), 'utf8');
  const start = html.indexOf('<section class="stage"');
  const end = html.indexOf('</section>', start);
  if (start === -1 || end === -1) throw new Error('index.html has no stage section');
  document.body.innerHTML = html.slice(start, end + '</section>'.length);
  // src/page/board.ts builds the cells at start-up. One cell with its piece is enough here.
  const board = document.querySelector('#board');
  if (board === null) throw new Error('index.html has no #board');
  board.innerHTML = '<button type="button" class="cell" id="test-cell"><span class="piece"></span></button>';
});

function at(selector: string): Element {
  const found = document.querySelector(selector);
  if (found === null) throw new Error(`index.html has no ${selector}`);
  return found;
}

describe('startsDrag', () => {
  it('starts a drag on the empty stage, the status, the board and a board cell', () => {
    for (const selector of ['#stage', '#status', '#clocks', '#board', '#board-hidden', '#game-view-title', '#test-cell', '#test-cell .piece']) {
      expect(startsDrag(at(selector)), selector).toBe(true);
    }
  });

  it('leaves the keypad and every other control in the stage to its own press', () => {
    for (const selector of ['#coords', '#coords-title', '#coords-slots b', '[data-digit="1"]', '#coords-place', '#coords-hear svg', '#review-exit', '[data-review="prev"]', '#game-view-play']) {
      expect(startsDrag(at(selector)), selector).toBe(false);
    }
  });

  it('does not start a drag without an element target', () => {
    expect(startsDrag(null)).toBe(false);
    expect(startsDrag(window)).toBe(false);
  });
});
