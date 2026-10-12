// The store screenshots: each scene runs once per target of targets.json (playwright.config.ts).
// A shot goes to SHOTS_DIR/<target>/<scene>.png. The store-images workflow runs this file.
// Production keeps no data from it: every API write fails, except in the online scene, which plays
// on the local Docker Compose build at LOCAL_URL (compose.lan.yml), because an online game needs writes.
import type { Page } from '@playwright/test';
import { cell, expect, expectMyMove, marks, status, test } from '../../../e2e/fixtures.ts';

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
  await hideLocalOnly(alice.page);
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

// The scenes below are candidates for the maintainers' pick on pull request 149.
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

test('6 the flat view', async ({ open }) => {
  const { page } = await open({ settings: { mode: 'friend', view: 'flat', layout: 'grid' } });
  await readOnly(page);
  await play(page, OPENING);
  await page.evaluate(() => scrollTo(0, 0));
  await settle(page);
  await shot(page, '6-flat');
});

test('7 the Midnight theme', async ({ open }) => {
  const { page } = await open({ settings: { mode: 'friend', theme: 'midnight' } });
  await readOnly(page);
  await play(page, [21, 42, 22, 38, 23, 5]);
  await page.evaluate(() => scrollTo(0, 0));
  await settle(page);
  await shot(page, '7-midnight');
});

test('8 the theme picker', async ({ open }) => {
  const { page } = await open({ settings: { mode: 'friend', theme: 'synthwave' } });
  await readOnly(page);
  await play(page, OPENING);
  await page.locator('#theme-menu summary').click();
  await showMiddle(page, '#theme-picker');
  await shot(page, '8-themes');
});

test('9 a game against the hard computer', async ({ open }) => {
  const { page } = await open({ settings: { mode: 'computer', difficulty: 'hard', human: 'X' } });
  await readOnly(page);
  // The computer picks its own cells, so each move takes the first free cell of a short list.
  const wanted = [21, 42, 0, 63, 22, 5, 38];
  for (let turn = 1; turn <= 3; turn += 1) {
    const taken = await page.locator('.cell').evaluateAll((cells) => cells.flatMap((element, index) => (element.matches('.x, .o') ? [index] : [])));
    const index = wanted.find((candidate) => !taken.includes(candidate));
    if (index === undefined) throw new Error('no free cell in the list');
    await cell(page, index).click();
    await expect(marks(page)).toHaveCount(turn * 2);
    await expect(page.locator('#board')).not.toHaveClass(/\bthinking\b/);
  }
  await page.evaluate(() => scrollTo(0, 0));
  await settle(page);
  await shot(page, '9-computer');
});

test('10 a game with a clock', async ({ open }) => {
  const { page } = await open({ settings: { mode: 'friend' } });
  await readOnly(page);
  // A limit set before the first move holds for this game: 30 s per move (the default) and 5 min per player.
  await page.locator('[data-limit="perMove"] [data-limit-on]').check();
  await page.locator('[data-limit="perGame"] [data-limit-on]').check();
  await page.locator('[data-limit="perGame"]').getByRole('button', { name: '5m' }).click();
  await play(page, OPENING);
  await settle(page, 2500);
  await page.evaluate(() => scrollTo(0, 0));
  await settle(page);
  await shot(page, '10-clock');
});

test('11 a blind game on the keypad', async ({ open }) => {
  const { page } = await open({ settings: { mode: 'friend' } });
  await readOnly(page);
  await play(page, [21, 42]);
  await page.locator('[data-toggle="hideBoard"]').click();
  for (const digit of ['2', '2', '3']) await page.locator(`[data-digit="${digit}"]`).click();
  await showMiddle(page, '#coords');
  await shot(page, '11-blind');
});

test('12 the sound sets', async ({ open }) => {
  const { page } = await open({ settings: { mode: 'friend' } });
  await readOnly(page);
  await play(page, OPENING);
  await page.getByRole('button', { name: 'Sound set', exact: true }).click();
  await expect(page.locator('#sound-sets')).toBeVisible();
  await settle(page);
  await shot(page, '12-sounds');
});

test('13 the ear training', async ({ open }) => {
  const { page } = await open({ path: '/sound-training' });
  await readOnly(page);
  await settle(page, 2000);
  await shot(page, '13-ear');
});

test('14 the Voice room targets', async ({ open }) => {
  const { page } = await open({ path: '/sound-input' });
  await readOnly(page);
  await page.locator('[data-tab="targets"]').click();
  await settle(page, 2000);
  await shot(page, '14-targets');
});

test('15 a Nearby game in the list', async ({ open }) => {
  const host = await open({ path: `${LOCAL}/`, settings: { mode: 'nearby' } });
  await host.page.locator('#nearby-host').click();
  await expect(host.page.locator('#nearby-visible')).toBeVisible();
  const guest = await open({ path: `${LOCAL}/`, settings: { mode: 'nearby' } });
  await expect(guest.page.locator('#nearby-hosts li').first()).toBeVisible();
  await hideLocalOnly(guest.page);
  await showMiddle(guest.page, '#nearby-lobby');
  await shot(guest.page, '15-nearby');
});

test('16 an online invite with a QR code', async ({ open }) => {
  const alice = await open({ path: `${LOCAL}/` });
  await alice.page.getByRole('button', { name: 'Online', exact: true }).click();
  await expect(alice.page).toHaveURL(/code=/);
  await alice.page.locator('#share-qr').click();
  await expect(alice.page.locator('#online-qr-image')).toBeVisible();
  await hideLocalOnly(alice.page);
  await showMiddle(alice.page, '#online-qr');
  await shot(alice.page, '16-qr');
});

test('17 a watcher of an online game', async ({ open }) => {
  const alice = await open({ path: `${LOCAL}/` });
  await alice.page.getByRole('button', { name: 'Online', exact: true }).click();
  await expect(alice.page).toHaveURL(/code=/);
  const bob = await open({ path: alice.page.url() });
  for (const [page, index] of [[alice.page, 21], [bob.page, 42], [alice.page, 22], [bob.page, 5]] as const) {
    await expectMyMove(page);
    await cell(page, index).click();
  }
  const watch = new URL(alice.page.url());
  watch.searchParams.set('watch', '1');
  const carol = await open({ path: watch.href });
  await expect(carol.page.locator('#players-list li').nth(2)).toContainText('Watching');
  await hideLocalOnly(carol.page);
  await carol.page.evaluate(() => scrollTo(0, 0));
  await settle(carol.page, 2000);
  await shot(carol.page, '17-watch');
});

test('18 the replay of a finished game', async ({ open }) => {
  const { page } = await open({ path: `${LOCAL}/`, settings: { mode: 'friend' } });
  await play(page, [0, 1, 16, 2, 32, 3, 48]);
  await expect(page).toHaveURL(/[?&]game=/);
  const id = new URL(page.url()).searchParams.get('game') ?? '';
  const viewer = await open({ path: `${LOCAL}/?game=${id}` });
  await expect(viewer.page.locator('#review')).toBeVisible();
  await viewer.page.locator('[data-review="first"]').click();
  for (let step = 0; step < 4; step += 1) await viewer.page.locator('[data-review="next"]').click();
  await viewer.page.evaluate(() => scrollTo(0, 0));
  await settle(viewer.page);
  await shot(viewer.page, '18-replay');
});

test('19 the AI agent snippet', async ({ open }) => {
  const { page } = await open({ settings: { mode: 'computer' } });
  await readOnly(page);
  await page.locator('#advanced summary').click();
  await showMiddle(page, '#agent-snippet');
  await shot(page, '19-agent');
});

test('20 how games end', async ({ open }) => {
  const { page } = await open({ path: '/stats' });
  await readOnly(page);
  const heading = page.getByRole('heading', { name: 'How games end' });
  await expect(heading).toBeVisible();
  await heading.evaluate((element) => element.scrollIntoView());
  await page.evaluate(() => scrollBy(0, -40));
  await settle(page);
  await shot(page, '20-ends');
});
