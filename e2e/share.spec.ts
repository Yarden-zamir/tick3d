import type { Page } from '@playwright/test';
import { PAGES } from '../src/pages.ts';
import { STORAGE_KEYS } from '../src/storage-keys.ts';
import { expect, test } from './fixtures.ts';

// The share page (/share) with a fake code list, so the test needs no real codes. A preview has none.

const CODE = 'B9WQ4T7XK2M8RZ5P3N6H1JD';
type Card = { id: number; hint: string; claimed: boolean; name: string | null; gravatar: string | null };

// Serves the list and the claims. `taken` lists the ids that somebody else claims before this page does.
async function fakeCodes(page: Page, taken: number[] = []): Promise<void> {
  const codes: Card[] = [
    { id: 1, hint: 'K7Q', claimed: true, name: 'Tom', gravatar: null },
    { id: 2, hint: 'B9W', claimed: false, name: null, gravatar: null },
    { id: 3, hint: 'M2X', claimed: false, name: null, gravatar: null },
  ];
  await page.route('**/api/testing/codes', (route) => route.fulfill({ json: { codes } }));
  await page.route('**/api/testing/codes/*/claim', async (route) => {
    const id = Number(route.request().url().split('/').at(-2));
    const body = route.request().postDataJSON() as { name: string };
    const card = codes.find((code) => code.id === id);
    if (card === undefined) return route.fulfill({ status: 404, json: { error: 'No tester code has this id.' } });
    if (card.claimed || taken.includes(id)) {
      Object.assign(card, { claimed: true, name: 'Gal' });
      return route.fulfill({ status: 409, json: { error: 'Somebody else took this code a moment ago. Pick another one.' } });
    }
    Object.assign(card, { claimed: true, name: body.name });
    return route.fulfill({ json: { code: CODE } });
  });
}

const card = (page: Page, hint: string) => page.locator('.code-card', { has: page.locator('.code-hint', { hasText: hint }) });
const step = (page: Page, id: string) => page.locator(`li[data-step="${id}"]`);

// Picks Android and opens the code step early, as a tap on the grayed step does.
async function openCodeStep(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Android' }).click();
  await step(page, 'code').getByRole('button', { name: 'Open now' }).click();
  await expect(step(page, 'code')).toHaveAttribute('data-state', 'open');
}

test('the page asks for the phone, and each phone shows its own steps', async ({ open }) => {
  const { page } = await open({ path: PAGES.share.path });
  await expect(page.locator('#android-path')).toBeHidden();
  await expect(page.locator('#iphone-path')).toBeHidden();
  await page.getByRole('button', { name: 'iPhone' }).click();
  await expect(page.locator('#iphone-path')).toBeVisible();
  await expect(page.locator('#testflight-link')).toHaveAttribute('href', 'https://testflight.apple.com/join/8R7N2ka6');
  await expect(page.locator('#code-grid')).toBeHidden();
  // The choice stays for the next visit.
  await page.reload();
  await expect(page.getByRole('button', { name: 'iPhone' })).toHaveAttribute('aria-pressed', 'true');
});

test('the steps open in order, with a wait before the code step, and a tap opens a step early', async ({ open }) => {
  const { page } = await open({ path: PAGES.share.path });
  // The links open Google in a new tab. The test needs only the tap.
  await page.context().route(/^https:\/\/(groups|play)\.google\.com\//, (route) => route.fulfill({ body: '' }));
  await page.getByRole('button', { name: 'Android' }).click();
  await expect(step(page, 'group')).toHaveAttribute('data-state', 'open');
  await expect(step(page, 'tester')).toHaveAttribute('data-state', 'locked');
  await expect(step(page, 'code')).toHaveAttribute('data-state', 'locked');

  await step(page, 'group').getByRole('link', { name: 'Open the group' }).click();
  await expect(step(page, 'group')).toHaveAttribute('data-state', 'done');
  await expect(step(page, 'tester')).toHaveAttribute('data-state', 'open');

  await step(page, 'tester').getByRole('link', { name: 'Become a tester' }).click();
  await expect(step(page, 'code')).toHaveAttribute('data-state', 'waiting');
  await expect(page.locator('#step-wait')).toContainText('Google needs a few minutes');
  await expect(page.locator('#wait-left')).toHaveText(/^[12]:\d\d$/);

  // The wait keeps its end time over a reload. A tap opens the step early.
  await page.reload();
  await expect(step(page, 'code')).toHaveAttribute('data-state', 'waiting');
  await step(page, 'code').getByRole('button', { name: 'Open now' }).click();
  await expect(step(page, 'code')).toHaveAttribute('data-state', 'open');
  await expect(page.locator('#step-wait')).toBeHidden();
  await expect(step(page, 'install')).toHaveAttribute('data-state', 'locked');
});

test('a claim shows the code, and a second claim asks first', async ({ open }) => {
  const { page } = await open({ path: PAGES.share.path });
  await fakeCodes(page);
  await openCodeStep(page);
  await expect(card(page, 'K7Q')).toHaveAttribute('data-state', 'taken');
  await expect(card(page, 'K7Q')).toContainText('Tom');

  await card(page, 'B9W').click();
  const dialog = page.locator('#claim-dialog');
  await expect(dialog.locator('#claim-warning')).toBeHidden();
  await dialog.getByLabel('Google Play email').fill('not an email');
  await dialog.getByLabel('Your name').fill('Dana');
  await dialog.getByRole('button', { name: 'Claim the code', exact: true }).click();
  await expect(dialog.locator('#claim-error')).toBeVisible();
  await dialog.getByLabel('Google Play email').fill('dana@example.com');
  await dialog.getByRole('button', { name: 'Claim the code', exact: true }).click();

  await expect(dialog).toBeHidden();
  await expect(page.locator('.my-code-text')).toHaveText(CODE);
  await expect(page.getByRole('link', { name: 'Redeem in Play' })).toHaveAttribute('href', `https://play.google.com/redeem?code=${CODE}`);
  await expect(card(page, 'B9W')).toHaveAttribute('data-state', 'mine');

  await card(page, 'M2X').click();
  await expect(dialog.locator('#claim-warning')).toBeVisible();
  await dialog.getByRole('button', { name: 'Cancel' }).click();

  // The browser keeps the code for the next visit.
  await page.reload();
  await expect(page.locator('.my-code-text')).toHaveText(CODE);
});

test('a code that somebody else took first turns taken, with a message', async ({ open }) => {
  const { page } = await open({ path: PAGES.share.path });
  await fakeCodes(page, [2]);
  await openCodeStep(page);
  await card(page, 'B9W').click();
  await page.getByLabel('Google Play email').fill('dana@example.com');
  await page.getByLabel('Your name').fill('Dana');
  await page.getByRole('button', { name: 'Claim the code', exact: true }).click();
  await expect(page.locator('#codes-note')).toHaveText(/Somebody else took this code/);
  await expect(card(page, 'B9W')).toHaveAttribute('data-state', 'taken');
  await expect(page.locator('.my-code')).toHaveCount(0);
});

test('without free codes, the page says whom to ask', async ({ open }) => {
  const { page } = await open({ path: PAGES.share.path });
  await page.route('**/api/testing/codes', (route) => route.fulfill({ json: { codes: [{ id: 1, hint: 'K7Q', claimed: true, name: 'Tom', gravatar: null }] } }));
  await page.getByRole('button', { name: 'Android' }).click();
  await expect(page.locator('#codes-empty')).toBeVisible();
});

test('a refresh turns a card that another tester took in its own slot, without a new grid', async ({ open }) => {
  const { page } = await open({ path: PAGES.share.path });
  const codes: Card[] = Array.from({ length: 30 }, (_, i) => ({ id: i + 1, hint: `C${String(i).padStart(2, '0')}`, claimed: false, name: null, gravatar: null }));
  await page.route('**/api/testing/codes', (route) => route.fulfill({ json: { codes } }));
  await page.getByRole('button', { name: 'Android' }).click();
  const last = page.locator('.code-card[data-slot="30"]');
  await last.scrollIntoViewIfNeeded();
  await expect(last).toHaveAttribute('data-state', 'free');
  await page.evaluate(() => {
    const card = document.querySelector('.code-card[data-slot="30"]');
    if (card === null) throw new Error('no card');
    (window as unknown as { e2eCard: Element }).e2eCard = card;
  });
  const scroll = await page.evaluate(() => scrollY);

  Object.assign(codes[29] ?? {}, { claimed: true, name: 'Gal' });
  await page.evaluate(() => dispatchEvent(new Event('focus')));
  await expect(last).toHaveAttribute('data-state', 'taken');
  await expect(last).toContainText('Gal');
  await expect(last).toContainText('#30');
  // The same element turned, and the page did not move.
  expect(await page.evaluate(() => document.querySelector('.code-card[data-slot="30"]') === (window as unknown as { e2eCard: Element }).e2eCard)).toBe(true);
  expect(await page.evaluate(() => scrollY)).toBe(scroll);
});

test('an invite link credits its first inviter in the claim, and the share button shares the own invite link', async ({ open }) => {
  const INVITER = '0123456789abcdef';
  const { page } = await open({ path: `${PAGES.share.path}?by=${INVITER}` });
  await fakeCodes(page);
  // The share sheet gets the link only, with the person id of this browser.
  await page.evaluate(() => {
    Object.assign(navigator, {
      share: async (data: ShareData) => {
        Object.assign(window, { e2eShared: data });
      },
    });
  });
  const token = await page.evaluate((key) => localStorage.getItem(key) ?? '', STORAGE_KEYS.player);
  const me = (await (await page.request.get('/api/me', { headers: { 'x-player': token } })).json()) as { person: string };
  // The page knows its person once its own GET /api/me answers.
  await expect
    .poll(async () => {
      await page.locator('#share-page').click();
      return page.evaluate(() => (window as unknown as { e2eShared?: ShareData }).e2eShared);
    })
    .toEqual({ url: `${new URL(page.url()).origin}/share?by=${me.person}` });

  // A later visit with another inviter, or none, keeps the first one.
  await page.goto(`${PAGES.share.path}?by=fedcba9876543210`);
  await page.goto(`${PAGES.share.path}?by=bad`);
  await openCodeStep(page);
  await card(page, 'B9W').click();
  await page.getByLabel('Google Play email').fill('dana@example.com');
  await page.getByLabel('Your name').fill('Dana');
  const claim = page.waitForRequest('**/api/testing/codes/2/claim');
  await page.getByRole('button', { name: 'Claim the code', exact: true }).click();
  expect((await claim).postDataJSON()).toEqual({ email: 'dana@example.com', name: 'Dana', by: INVITER });
});

test('the old address /testing redirects to /share with its query', async ({ request }) => {
  const response = await request.get('/testing?by=0123456789abcdef', { maxRedirects: 0 });
  expect(response.status()).toBe(302);
  expect(response.headers().location).toBe('/share?by=0123456789abcdef');
});
