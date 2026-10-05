import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// The page script finds its elements by id at start-up and stops when one is missing. The type
// checker cannot see that, so this test reads the page modules and index.html and checks every id
// before a deploy.
describe('page markup', () => {
  it('has every element id that the page script looks up', () => {
    const pageDir = new URL('./page/', import.meta.url);
    const modules = [
      new URL('./main.ts', import.meta.url),
      ...readdirSync(pageDir)
        .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
        .map((name) => new URL(name, pageDir)),
    ];
    const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
    const ids = modules.flatMap((module) =>
      readFileSync(module, 'utf8')
        .split("element('#")
        .slice(1)
        .map((part) => part.slice(0, part.indexOf("'"))),
    );
    expect(ids.length).toBeGreaterThan(50);
    const missing = ids.filter((id) => !html.includes(`id="${id}"`));
    expect(missing).toEqual([]);
  });
});
