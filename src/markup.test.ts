import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// The page script finds its elements by id at start-up and stops when one is missing. The type
// checker cannot see that, so this test reads both files and checks every id before a deploy.
describe('page markup', () => {
  it('has every element id that main.ts looks up', () => {
    const script = readFileSync(new URL('./main.ts', import.meta.url), 'utf8');
    const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
    const ids = script
      .split("element('#")
      .slice(1)
      .map((part) => part.slice(0, part.indexOf("'")));
    expect(ids.length).toBeGreaterThan(50);
    const missing = ids.filter((id) => !html.includes(`id="${id}"`));
    expect(missing).toEqual([]);
  });
});
