// The store screenshots: each scene runs once per target of targets.json (playwright.config.ts).
// A shot goes to SHOTS_DIR/<target>/<scene>.png. The store-images workflow runs this file.
// Production keeps no data from it: every API write fails, except in the online scene, which plays
// on the local Docker Compose build at LOCAL_URL (compose.lan.yml), because an online game needs writes.
import type { Page } from '@playwright/test';
import { cell, expect, expectMyMove, status, test } from '../e2e/fixtures.ts';

const OUT = process.env.SHOTS_DIR ?? '';
const LOCAL = process.env.LOCAL_URL ?? '';
if (OUT === '' || LOCAL === '') throw new Error('Set SHOTS_DIR to the output folder and LOCAL_URL to the local build');

async function readOnly(page: Page): Promise<void> {
  await page.route('**/api/**', (route) => (route.request().method() === 'GET' ? route.fallback() : route.abort()));
}
// The board animates a placed mark, and fonts and charts load late.
const settle = (page: Page, ms = 1200) => page.waitForTimeout(ms);
// The new-message banner covers the board, and the local build names its container as a LAN host.
// Production shows neither, so they are not part of a scene.
async function hideLocalOnly(page: Page): Promise<void> {
  for (const selector of ['#chat-notice', '#lan-host']) {
    await page.locator(selector).evaluate((element) => {
      if (element instanceof HTMLElement) element.hidden = true;
    });
  }
}
const shot = (page: Page, name: string) => page.screenshot({ path: `${OUT}/${test.info().project.name}/${name}.png` });

async function play(page: Page, cells: readonly number[]): Promise<void> {
  for (const index of cells) {
    await cell(page, index).click();
    await settle(page, 250);
  }
}
// Scrolls a part of the page into the middle of the screen.
async function showMiddle(page: Page, selector: string): Promise<void> {
  await page.locator(selector).first().evaluate((element) => element.scrollIntoView({ block: 'center' }));
  await settle(page);
}
const OPENING = [21, 42, 22, 5, 26];

test('1 the tower', async ({ open }) => {
  const { page } = await open({ settings: { mode: 'friend' } });
  await readOnly(page);
  await play(page, OPENING);
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
  await hideLocalOnly(alice.page);
  await settle(alice.page);
  await shot(alice.page, '3-online');
});

test('4 a blind game on the keypad', async ({ open }) => {
  const { page } = await open({ settings: { mode: 'friend' } });
  await readOnly(page);
  await play(page, [21, 42]);
  await page.locator('[data-toggle="hideBoard"]').click();
  for (const digit of ['2', '2', '3']) await page.locator(`[data-digit="${digit}"]`).click();
  await showMiddle(page, '#coords');
  await shot(page, '4-blind');
});

test('5 the sound sets', async ({ open }) => {
  const { page } = await open({ settings: { mode: 'friend' } });
  await readOnly(page);
  await play(page, OPENING);
  await page.getByRole('button', { name: 'Sound set', exact: true }).click();
  await expect(page.locator('#sound-sets')).toBeVisible();
  await settle(page);
  await shot(page, '5-sounds');
});
