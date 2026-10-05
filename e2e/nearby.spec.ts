import { cell, expect, expectMyMove, expectToast, marks, readQr, test, toasts } from './fixtures.ts';
import type { Page } from '@playwright/test';

const nearby = { settings: { mode: 'nearby' } };

// A signal code holds a full WebRTC description, so a real one is long.
async function signalCode(page: Page): Promise<string> {
  const out = page.locator('#nearby-code-out');
  await expect.poll(async () => (await out.inputValue()).length, { timeout: 20_000 }).toBeGreaterThan(50);
  return out.inputValue();
}

async function useCode(page: Page, code: string): Promise<void> {
  await page.locator('#nearby-code-in').fill(code);
  await page.locator('#nearby-use-code').click();
}

test('host and guest connect with text codes, play and chat', async ({ open }) => {
  const { page: host } = await open(nearby);
  const { page: guest } = await open(nearby);
  await host.locator('#nearby-host').click();
  await expect(host.locator('#nearby-qr svg')).toHaveCount(1);
  const offer = await signalCode(host);
  await guest.locator('#nearby-join').click();
  await useCode(guest, offer);
  await useCode(host, await signalCode(guest));
  await expectToast(guest, 'as O');
  await expect(host.locator('#nearby-devices li')).toHaveCount(2);
  await expect(host.locator('#nearby-devices .device-icon svg')).toHaveCount(2);

  await cell(host, 0).click();
  await expect(marks(guest)).toHaveCount(1);
  await expectMyMove(guest);
  await cell(guest, 1).click();
  await expect(marks(host)).toHaveCount(2);

  await guest.locator('#chat-input').fill('hi from the couch');
  await guest.locator('#chat-input').press('Enter');
  await expect(host.locator('#chat-log')).toContainText('hi from the couch');

  await host.locator('#nearby-stop').click();
  await expectToast(guest, 'host ended');
});

test('camera links carry the codes between host and guest', async ({ open, baseURL }) => {
  const { page: host, context: hostContext } = await open(nearby);
  await host.locator('#nearby-host').click();
  const invite = await readQr(host.locator('#nearby-qr'));
  expect(invite.startsWith(new URL('/?nearby=', baseURL).href)).toBe(true);

  // The guest's camera app opens the invite link.
  const { page: guest } = await open({ path: invite, settings: { mode: 'computer' } });
  const answer = await signalCode(guest);
  await expect(guest.locator('[data-value="nearby"]')).toHaveAttribute('aria-pressed', 'true');
  expect(guest.url()).not.toContain('nearby=');

  // The host's camera app opens the answer link in a new tab of the same browser.
  const tab = await hostContext.newPage();
  await tab.goto(`/?nearby=${encodeURIComponent(answer)}`);
  await expect(tab.locator('#nearby-step-text')).toContainText('close this tab');
  await expectToast(guest, 'as O');
  await cell(host, 0).click();
  await expect(guest.locator('.cell.x')).toHaveCount(1);
});

test('a guest that cancels never joins, and a double tap on Host hosts once', async ({ open }) => {
  const { page: host } = await open(nearby);
  await host.locator('#nearby-host').dblclick();
  await expect(host.locator('#nearby-qr svg')).toHaveCount(1);
  await expect(host.locator('#nearby-host')).toBeHidden();
  const offer = await signalCode(host);

  const { page: guest } = await open(nearby);
  await guest.locator('#nearby-join').click();
  await useCode(guest, offer);
  const answer = await signalCode(guest);
  await guest.locator('#nearby-cancel').click();
  await expect(guest.locator('#nearby-host')).toBeVisible();
  await guest.getByRole('button', { name: 'Computer', exact: true }).click();

  // The host reads the old answer anyway. Its attempt ends when the connect timeout (15 s) runs out.
  await useCode(host, answer);
  await expect.poll(() => toasts(host), { timeout: 30_000 }).toContainEqual(expect.stringContaining('did not connect'));
  const guestToasts = await toasts(guest);
  expect(guestToasts).not.toContainEqual(expect.stringContaining('Joined'));
  expect(guestToasts, 'a deliberate cancel needs no message').not.toContainEqual(expect.stringContaining('cancelled'));
  await expect.poll(() => guest.evaluate(() => (JSON.parse(localStorage.getItem('tick3d.settings') ?? '{}') as { mode?: string }).mode)).toBe('computer');
});
