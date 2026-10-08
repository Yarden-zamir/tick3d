// The Play store screenshots and the feature graphic. The play-screenshots workflow runs this file.
// Production keeps no data from it: every API write fails, except in the online scene, which plays
// on the local Docker Compose build at LOCAL_URL (compose.lan.yml), because an online game needs writes.
import type { Page } from '@playwright/test';
import { cell, expect, expectMyMove, status, test } from '../../../e2e/fixtures.ts';

const OUT = process.env.SHOTS_DIR ?? '';
const LOCAL = process.env.LOCAL_URL ?? '';
if (OUT === '' || LOCAL === '') throw new Error('Set SHOTS_DIR to the output folder and LOCAL_URL to the local build');

async function readOnly(page: Page): Promise<void> {
  await page.route('**/api/**', (route) => (route.request().method() === 'GET' ? route.fallback() : route.abort()));
}
// The board animates a placed mark, and fonts and charts load late.
const settle = (page: Page, ms = 1200) => page.waitForTimeout(ms);
const shot = (page: Page, name: string) => page.screenshot({ path: `${OUT}/${name}.png` });

test('1 the tower', async ({ open }) => {
  const { page } = await open({ settings: { mode: 'friend' } });
  await readOnly(page);
  for (const index of [21, 42, 22, 5, 26]) {
    await cell(page, index).click();
    await settle(page, 300);
  }
  await page.evaluate(() => scrollTo(0, 0));
  await settle(page);
  await shot(page, '1-tower');
});

test('2 a won game', async ({ open }) => {
  const { page } = await open({ settings: { mode: 'friend' } });
  await readOnly(page);
  // X takes a space diagonal, O three cells of one row.
  for (const index of [0, 16, 21, 17, 42, 18, 63]) {
    await cell(page, index).click();
    await settle(page, 250);
  }
  await expect(status(page)).not.toHaveAttribute('data-state', 'playing');
  await expect(page.locator('#end-card')).toHaveAttribute('open');
  await settle(page);
  await shot(page, '2-win');
});

test('3 an online game with chat', async ({ open }) => {
  const alice = await open({ path: `${LOCAL}/` });
  await alice.page.getByRole('button', { name: 'Online', exact: true }).click();
  await expect(alice.page).toHaveURL(/code=/);
  const bob = await open({ path: alice.page.url() });
  await expect(bob.page.locator('#chat-input')).toBeVisible();
  await expectMyMove(alice.page);
  await cell(alice.page, 21).click();
  await expectMyMove(bob.page);
  await cell(bob.page, 42).click();
  await expectMyMove(alice.page);
  await cell(alice.page, 22).click();
  const lines = [
    [bob.page, 'nice opening'],
    [alice.page, 'thanks!'],
    [bob.page, 'rematch after this?'],
    [alice.page, 'deal, good luck'],
  ] as const;
  for (const [page, text] of lines) {
    await page.locator('#chat-input').fill(text);
    await page.locator('#chat-input').press('Enter');
    await settle(page, 400);
  }
  await settle(alice.page);
  await alice.page.locator('#chat-input').evaluate((element) => element.scrollIntoView({ block: 'end' }));
  await alice.page.evaluate(() => scrollBy(0, 40));
  // The new-message banner covers the board. It is not part of the scene.
  await alice.page.locator('#chat-notice').evaluate((element) => {
    if (element instanceof HTMLElement) element.hidden = true;
  });
  await settle(alice.page);
  await shot(alice.page, '3-online');
});

test('4 the Voice room', async ({ open }) => {
  const { page } = await open({ path: '/sound-input' });
  await readOnly(page);
  await settle(page, 2000);
  await shot(page, '4-voice');
});

test('5 the stats', async ({ open }) => {
  const { page } = await open({ path: '/stats' });
  await readOnly(page);
  await expect(page.getByRole('heading', { name: 'Opening moves' })).toBeVisible();
  await page.getByRole('heading', { name: 'Opening moves' }).evaluate((element) => element.scrollIntoView());
  await page.evaluate(() => scrollBy(0, -40));
  await settle(page);
  await shot(page, '5-stats');
});

test('6 the feature graphic', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1024, height: 500 }, deviceScaleFactor: 2 });
  const page = await context.newPage();
  const tower = new URL(`file://${OUT}/1-tower.png`).href;
  await page.goto(`${new URL('feature.html', import.meta.url).href}?tower=${encodeURIComponent(tower)}`);
  await expect(page.locator('#tower')).toHaveJSProperty('complete', true);
  await settle(page, 500);
  await page.screenshot({ path: `${OUT}/feature.png` });
  await context.close();
});
