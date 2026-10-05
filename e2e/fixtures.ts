import { test as base, expect, type BrowserContext, type Page } from '@playwright/test';
import jsQR from 'jsqr';
import { PNG } from 'pngjs';

// The app checks each stored field and uses the default for a field that is not valid.
type Settings = Record<string, string | boolean>;

interface OpenOptions {
  path?: string;
  settings?: Settings;
  records?: Record<string, number>;
  storageState?: Awaited<ReturnType<BrowserContext['storageState']>>;
}

interface Opened {
  page: Page;
  context: BrowserContext;
}

interface Seed {
  settings: Settings | undefined;
  records: Record<string, number> | undefined;
}

// Runs in the page before the app. A seed goes in only when the key is empty, so a reload keeps the
// changes that the app made. The toast observer keeps every message, because a later toast (for
// example "Ready for offline play") replaces the text of an earlier one.
function seed({ settings, records }: Seed): void {
  if (settings !== undefined && localStorage.getItem('tick3d.settings') === null) {
    localStorage.setItem('tick3d.settings', JSON.stringify(settings));
  }
  if (records !== undefined && localStorage.getItem('tick3d.records') === null) {
    localStorage.setItem('tick3d.records', JSON.stringify(records));
  }
  const toasts: string[] = [];
  (window as unknown as { e2eToasts: string[] }).e2eToasts = toasts;
  addEventListener('DOMContentLoaded', () => {
    const toast = document.querySelector('#toast');
    if (toast === null) throw new Error('the page has no #toast');
    new MutationObserver(() => {
      if (toast.textContent) toasts.push(toast.textContent);
    }).observe(toast, { subtree: true, childList: true, characterData: true });
  });
}

// `open` makes a fresh browser context for each player. The test fails on any uncaught page error.
export const test = base.extend<{ open: (options?: OpenOptions) => Promise<Opened> }>({
  open: async ({ browser, baseURL }, use) => {
    const contexts: BrowserContext[] = [];
    const errors: string[] = [];
    if (baseURL === undefined) throw new Error('the config sets no baseURL');
    await use(async ({ path = '/', settings, records, storageState } = {}) => {
      const context = await browser.newContext({ baseURL, ...(storageState === undefined ? {} : { storageState }) });
      contexts.push(context);
      context.on('weberror', (error) => errors.push(error.error().message));
      await context.addInitScript(seed, { settings, records });
      const page = await context.newPage();
      await page.goto(path);
      return { page, context };
    });
    await Promise.all(contexts.map((context) => context.close()));
    expect(errors, 'uncaught page errors').toEqual([]);
  },
});

export { expect };

// Every toast text since the page loaded, oldest first.
export const toasts = (page: Page): Promise<string[]> =>
  page.evaluate(() => [...(window as unknown as { e2eToasts: string[] }).e2eToasts]);

export async function expectToast(page: Page, text: string): Promise<void> {
  await expect.poll(() => toasts(page)).toContainEqual(expect.stringContaining(text));
}

export const cell = (page: Page, index: number) => page.locator('.cell').nth(index);
export const marks = (page: Page) => page.locator('.cell.x, .cell.o');
export const status = (page: Page) => page.locator('#status');

export async function expectMyMove(page: Page): Promise<void> {
  await expect(status(page)).toContainText('Your move');
}

// Creates an online session from the page and returns its code. Each call counts against the
// server limit of 60 new sessions per hour for one client address.
export async function createOnline(page: Page): Promise<string> {
  await page.getByRole('button', { name: 'Online', exact: true }).click();
  await expect(page).toHaveURL(/[?&]code=\w{4}/);
  const code = new URL(page.url()).searchParams.get('code');
  if (code === null) throw new Error('the address has no code');
  return code;
}

// Joins with a fresh context and waits until the joiner holds the O seat.
export async function joinAsO(open: (options?: OpenOptions) => Promise<Opened>, path: string): Promise<Opened> {
  const joined = await open({ path });
  await expectToast(joined.page, 'as O');
  return joined;
}

// Reads the QR code that the locator shows.
export async function readQr(locator: ReturnType<Page['locator']>): Promise<string> {
  await expect(locator.locator('svg')).toBeVisible();
  const png = PNG.sync.read(await locator.screenshot());
  const qr = jsQR(new Uint8ClampedArray(png.data), png.width, png.height);
  if (qr === null) throw new Error('no QR code found in the screenshot');
  return qr.data;
}

// Plays the cells in order against the computer until the game ends. With hidden marks a taken cell
// is refused, so the next cell gets the turn. `.cell.last` marks the last move even with hidden marks.
export async function playComputerUntilEnd(page: Page, order: readonly number[]): Promise<void> {
  const lastMove = () => page.evaluate(() => [...document.querySelectorAll('.cell')].findIndex((c) => c.classList.contains('last')));
  for (const index of order) {
    if ((await status(page).getAttribute('data-state')) !== 'playing') return;
    await expectMyMove(page);
    const before = await lastMove();
    const refusals = (await toasts(page)).length;
    await cell(page, index).click();
    // The turn is over when the game ends, the move is refused, or the computer answered.
    await expect
      .poll(async () => {
        if ((await status(page).getAttribute('data-state')) !== 'playing') return true;
        if ((await toasts(page)).length > refusals) return true;
        const last = await lastMove();
        return last !== before && last !== index && (await status(page).textContent())?.includes('Your move') === true;
      })
      .toBe(true);
  }
  await expect(status(page)).not.toHaveAttribute('data-state', 'playing');
}
