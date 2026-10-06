import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// The page scripts find their elements by id at start-up and stop when one is missing. The type
// checker cannot see that, so this test reads the modules and the HTML pages and checks every id
// before a deploy.

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

// The ids that the modules in `dir` look up with element('#…').
function lookedUpIds(dir: string, extra: string[] = []): string[] {
  const url = new URL(dir, import.meta.url);
  const modules = [
    ...extra.map((path) => new URL(path, import.meta.url)),
    ...readdirSync(url)
      .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
      .map((name) => new URL(name, url)),
  ];
  return modules.flatMap((module) =>
    readFileSync(module, 'utf8')
      .split("element('#")
      .slice(1)
      .map((part) => part.slice(0, part.indexOf("'"))),
  );
}

const missingIn = (html: string, ids: string[]) => ids.filter((id) => !html.includes(`id="${id}"`));

// The part of `html` from the first `start` to the end of the next `end`.
function block(html: string, start: string, end: string): string {
  const from = html.indexOf(start);
  if (from === -1) throw new Error(`no ${start}`);
  const to = html.indexOf(end, from);
  if (to === -1) throw new Error(`no ${end} after ${start}`);
  return html.slice(from, to + end.length);
}

const GAME = '../index.html';
const PAGES = [GAME, '../stats.html', '../sound-training.html', '../sound-input.html'];

describe('page markup', () => {
  it('has every element id that the game page script looks up', () => {
    const ids = lookedUpIds('./page/', ['./main.ts']);
    expect(ids.length).toBeGreaterThan(50);
    expect(missingIn(read(GAME), ids)).toEqual([]);
  });

  it('has the same header on every page', () => {
    const ids = lookedUpIds('./header/');
    expect(ids.length).toBeGreaterThan(5);
    const links = (html: string) => block(html, '<div class="brand-links">', '</div>');
    const previews = (html: string) => block(html, '<dialog class="end-card my-games" id="previews"', '</dialog>');
    const game = read(GAME);
    for (const page of PAGES) {
      const html = read(page);
      expect(missingIn(html, [...ids, 'info-panel', 'info-title']), page).toEqual([]);
      expect(links(html), page).toBe(links(game));
      expect(previews(html), page).toBe(previews(game));
    }
  });
});
