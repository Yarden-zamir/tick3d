import { cell, expect, expectMyMove, expectToast, marks, ownName, readQr, test, toasts } from './fixtures.ts';
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

test('host and guest connect with text codes, play a game and chat, and both see the names', async ({ open }) => {
  const { page: host } = await open(nearby);
  const { page: guest } = await open(nearby);
  const hostName = await ownName(host);
  const guestName = await ownName(guest);
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
  // The host shows the guest by the generated name of the guest: in the device list, the score and the chat.
  await expect(host.locator('#nearby-devices')).toContainText(guestName);
  await expect(host.locator('.tally.O')).toContainText(guestName);
  await expect(host.locator('#chat-log')).toContainText(guestName);

  // The host finishes the game: X on 0, 16, 32, 48, O on 1, 2, 3.
  for (const [page, index] of [[host, 16], [guest, 2], [host, 32], [guest, 3], [host, 48]] as const) {
    await expectMyMove(page);
    await cell(page, index).click();
    await expect(page.locator('#status')).not.toContainText('Your move');
  }
  await expect(host.locator('#status')).toHaveText('You win!');
  await expect(guest.locator('#status')).toHaveText(`${hostName} wins!`);
  await expect(host).toHaveURL(/[?&]game=[A-Z2-9]{8}/);
  const id = new URL(host.url()).searchParams.get('game');

  // The host's result names both seats: the link shows both players, and the guest's history has the
  // game with the host as the opponent.
  const { page: viewer } = await open({ path: `/?game=${id ?? ''}` });
  await expect(viewer.locator('#game-view')).toContainText(`${hostName} (X) vs ${guestName} (O)`);
  const guestHistory = () =>
    guest.evaluate(async () => {
      const response = await fetch('/api/me/history', { headers: { 'x-player': localStorage.getItem('tick3d.player') ?? '' } });
      return JSON.stringify(await response.json());
    });
  await expect.poll(guestHistory).toContain(`"opponentName":"${hostName}"`);

  await host.locator('#end-card-close').click();
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
  await guest.getByRole('button', { name: 'Computer' }).click();

  // The host reads the old answer anyway. Its attempt ends when the connect timeout (15 s) runs out.
  await useCode(host, answer);
  await expect.poll(() => toasts(host), { timeout: 30_000 }).toContainEqual(expect.stringContaining('did not connect'));
  const guestToasts = await toasts(guest);
  expect(guestToasts).not.toContainEqual(expect.stringContaining('Joined'));
  expect(guestToasts, 'a deliberate cancel needs no message').not.toContainEqual(expect.stringContaining('cancelled'));
  await expect.poll(() => guest.evaluate(() => (JSON.parse(localStorage.getItem('tick3d.settings') ?? '{}') as { mode?: string }).mode)).toBe('computer');
});
