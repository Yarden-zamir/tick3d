import { expect, test } from './fixtures.ts';

// Players marked text by accident with a fast double tap or a double click on the game. This spec also runs in WebKit
// (e2e/playwright.config.ts): Safari and the iOS app know only -webkit-user-select.

const selected = (page: import('@playwright/test').Page) => page.evaluate(() => window.getSelection()?.toString().trim() ?? '');

test('a double click on the game marks no text', async ({ page }) => {
  await page.goto('/');
  const status = page.locator('.status').first();
  await expect(status).not.toBeEmpty();
  await status.dblclick();
  expect(await selected(page)).toBe('');
  await page.locator('.brand h1').first().dblclick();
  expect(await selected(page)).toBe('');
});

test('text that people copy stays selectable', async ({ page }) => {
  await page.goto('/privacy');
  // The middle of the first word of the first paragraph.
  const point = await page.evaluate(() => {
    const paragraph = [...document.querySelectorAll('main p')].find((p) => (p.textContent ?? '').trim().length > 20);
    const node = paragraph && [...paragraph.childNodes].find((n) => n.nodeType === Node.TEXT_NODE && (n.textContent ?? '').trim().length > 5);
    if (!node) return null;
    const range = document.createRange();
    const start = (node.textContent ?? '').search(/\S/);
    range.setStart(node, start);
    range.setEnd(node, start + 2);
    const box = range.getBoundingClientRect();
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  });
  expect(point).not.toBeNull();
  if (point === null) return;
  await page.mouse.dblclick(point.x, point.y);
  expect(await selected(page)).not.toBe('');
});
