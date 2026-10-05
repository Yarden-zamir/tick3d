import { cell, createOnline, expect, expectToast, marks, playComputerUntilEnd, status, test, toasts } from './fixtures.ts';
import type { Page } from '@playwright/test';

async function waitForServiceWorker(page: Page): Promise<void> {
  await expect.poll(() => page.evaluate(async () => (await navigator.serviceWorker.getRegistration())?.active != null), { timeout: 20_000 }).toBe(true);
}

// The `sent` flag of each finished game result in the device database.
const resultsSent = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<boolean[]>((resolve, reject) => {
        const request = indexedDB.open('tick3d');
        request.onerror = () => reject(request.error ?? new Error('indexedDB.open failed'));
        request.onsuccess = () => {
          const all = request.result.transaction('results').objectStore('results').getAll();
          all.onerror = () => reject(all.error ?? new Error('getAll failed'));
          all.onsuccess = () => resolve((all.result as { sent: boolean }[]).map((result) => result.sent));
        };
      }),
  );

test('a computer game plays and finishes offline, and its result uploads after a reconnect', async ({ open }) => {
  const { page, context } = await open({ settings: { mode: 'computer', difficulty: 'easy', human: 'X' } });
  await waitForServiceWorker(page);
  await context.setOffline(true);
  await page.reload();
  await expect(status(page)).toContainText('Your move');
  await cell(page, 0).click();
  await expect(marks(page)).toHaveCount(2);
  await page.reload();
  await expect(marks(page)).toHaveCount(2);

  await playComputerUntilEnd(page, Array.from({ length: 64 }, (_, i) => i));
  await expect.poll(() => resultsSent(page)).toEqual([false]);
  await expect(page.locator('#end-card')).toHaveAttribute('open');
  await page.locator('#end-card-close').click();
  await page.locator('#account-button').click();
  await expect(page.locator('#my-games-note')).toContainText('offline');
  await page.locator('#my-games-close').click();

  await context.setOffline(false);
  await expect.poll(() => resultsSent(page)).toEqual([true]);
  await page.locator('#account-button').click();
  const computer = page.locator('#my-games-stats .my-tally', { hasText: 'Computer' }).locator('span');
  await expect(computer).toBeVisible();
  await expect(computer).not.toHaveText('0 won · 0 lost · 0 drawn');
  await expect(page.locator('#my-games-device li').first()).toBeVisible();
  // Login shows only when the deployment has the GitHub app settings.
  await expect(page.locator('.login-link')).toHaveCount(1);
});

test('an online game seen before opens read-only offline', async ({ open }) => {
  const { page, context } = await open({ settings: { mode: 'computer' } });
  await createOnline(page);
  const seen = page.url();
  await cell(page, 5).click();
  await expect(page.locator('.cell.x')).toHaveCount(1);
  await waitForServiceWorker(page);

  await context.setOffline(true);
  await page.goto(seen);
  await expectToast(page, 'as you last saw it');
  await expect(page.locator('.cell.x')).toHaveCount(1);
  const before = (await toasts(page)).length;
  await cell(page, 6).click();
  await expect.poll(async () => (await toasts(page)).length).toBeGreaterThan(before);
  await expect(marks(page)).toHaveCount(1);
});
