import { cell, expect, expectMyMove, expectToast, marks, hasDeviceGameLink, openMore, ownName, playerToken, readQr, storedSettings, test, toasts } from './fixtures.ts';
import type { Page } from '@playwright/test';

const nearby = { settings: { mode: 'nearby' } };

// A signal code holds a full WebRTC description, so a real one is long.
async function signalCode(page: Page): Promise<string> {
  const out = page.locator('#nearby-code-out');
  await expect.poll(async () => (await out.inputValue()).length, { timeout: 20_000 }).toBeGreaterThan(50);
  return out.inputValue();
}

async function useCode(page: Page, code: string): Promise<void> {
  const manual = page.locator('#nearby-manual');
  if ((await manual.getAttribute('open')) === null) await manual.locator('> summary').click();
  await page.locator('#nearby-code-in').fill(code);
  await page.locator('#nearby-use-code').click();
}

// Feed a real rendered QR through a canvas camera. The app still reads video frames with jsQR;
// only the physical camera is replaced, so the whole in-app scan path runs in the browser.
async function cameraFromQr(page: Page, source: Page): Promise<void> {
  await expect(source.locator('#nearby-qr svg')).toBeVisible();
  const image = (await source.locator('#nearby-qr').screenshot()).toString('base64');
  await page.evaluate(async (image) => {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 640;
    const context = canvas.getContext('2d');
    if (context === null) throw new Error('no canvas context');
    const qr = new Image();
    qr.src = `data:image/png;base64,${image}`;
    await qr.decode();
    context.fillStyle = 'white';
    context.fillRect(0, 0, 640, 640);
    context.drawImage(qr, 50, 50, 540, 540);
    const stream = canvas.captureStream(10);
    navigator.mediaDevices.getUserMedia = async () => stream;
    (window as unknown as { cameraTrack: MediaStreamTrack | undefined }).cameraTrack = stream.getVideoTracks()[0];
  }, image);
}

test('two in-app scans connect without the discovery server, camera app, or extra tabs', async ({ open }) => {
  const { page: host, context: hostContext } = await open(nearby);
  const { page: guest, context: guestContext } = await open(nearby);
  for (const context of [hostContext, guestContext]) await context.route('**/api/nearby/**', (route) => route.abort());
  await host.locator('#nearby-host').click();
  await expect(host.locator('#nearby-progress')).toHaveText('Step 1 of 2');
  await cameraFromQr(guest, host);
  await guest.locator('#nearby-join').click();
  await expect(guest.locator('#nearby-progress')).toHaveText('Step 2 of 2');
  await expect(guest.locator('#nearby-step-title')).toContainText('your screen');
  await expect.poll(() => guest.evaluate(() => (window as unknown as { cameraTrack: MediaStreamTrack }).cameraTrack.readyState)).toBe('ended');
  await cameraFromQr(host, guest);
  await host.locator('#nearby-scan').click();
  await expectToast(guest, 'as O');
  await expect(host.locator('#nearby-step')).toBeHidden();
  await expect(guest.locator('#nearby-step')).toBeHidden();
  await expect.poll(() => host.evaluate(() => (window as unknown as { cameraTrack: MediaStreamTrack }).cameraTrack.readyState)).toBe('ended');
  expect(hostContext.pages()).toHaveLength(1);
  expect(guestContext.pages()).toHaveLength(1);
  await cell(host, 0).click();
  await expect(marks(guest)).toHaveCount(1);
});

test('a blocked camera offers retry and text codes, without losing the hosted game', async ({ open }) => {
  const { page: host } = await open(nearby);
  const { page: guest } = await open(nearby);
  await host.locator('#nearby-host').click();
  await guest.evaluate(() => {
    navigator.mediaDevices.getUserMedia = async () => { throw new DOMException('blocked', 'NotAllowedError'); };
  });
  await guest.locator('#nearby-join').click();
  await expect(guest.locator('#nearby-camera-status')).toContainText('Camera access is off');
  await expect(guest.locator('#nearby-camera-retry')).toBeVisible();
  await useCode(guest, await signalCode(host));
  await useCode(host, await signalCode(guest));
  await expectToast(guest, 'as O');
});

test('an interrupted guest rescans into the same game and seat', async ({ open }) => {
  const { page: host } = await open(nearby);
  const { page: guest } = await open(nearby);
  await guest.evaluate(() => {
    const Peer = RTCPeerConnection;
    window.RTCPeerConnection = class extends Peer {
      constructor(configuration?: RTCConfiguration) {
        super(configuration);
        (window as unknown as { testPeer: RTCPeerConnection }).testPeer = this;
      }
    };
    navigator.mediaDevices.getUserMedia = async () => { throw new DOMException('blocked', 'NotAllowedError'); };
  });
  await host.locator('#nearby-host').click();
  await guest.locator('#nearby-join').click();
  await useCode(guest, await signalCode(host));
  await useCode(host, await signalCode(guest));
  await expectToast(guest, 'as O');
  await cell(host, 0).click();
  await expect(marks(guest)).toHaveCount(1);
  await guest.evaluate(() => (window as unknown as { testPeer: RTCPeerConnection }).testPeer.close());
  await expect(guest.locator('#nearby-reconnect')).toContainText('Your game and seat stay');
  await expect(marks(host)).toHaveCount(1);
  await host.locator('#nearby-add').click();
  await guest.locator('#nearby-join').click();
  await useCode(guest, await signalCode(host));
  await useCode(host, await signalCode(guest));
  await expect(guest.locator('#nearby-devices')).toContainText('You · Plays O');
  await expect(marks(guest)).toHaveCount(1);
  await expect(guest.locator('#nearby-reconnect')).toBeHidden();
});

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

  // The guest locks: the lock holds the rules of both devices until the game ends. The view stays free.
  for (const page of [host, guest]) await openMore(page);
  await guest.locator('#lock').click();
  await expect(host.locator('#lock')).toContainText('Locked');
  await expect(host.getByRole('button', { name: 'Hide history and board', exact: true })).toBeDisabled();
  await expect(host.getByRole('button', { name: 'Flat' })).toBeEnabled();

  // The host finishes the game: X on 0, 16, 32, 48, O on 1, 2, 3.
  for (const [page, index] of [[host, 16], [guest, 2], [host, 32], [guest, 3], [host, 48]] as const) {
    await expectMyMove(page);
    await cell(page, index).click();
    await expect(page.locator('#status')).not.toContainText('Your move');
  }
  await expect(host.locator('#status')).toHaveText('You win!');
  await expect(guest.locator('#status')).toHaveText(`${hostName} wins!`);
  await expect(guest.locator('#lock')).not.toContainText('Locked');
  await expect(guest.getByRole('button', { name: 'Flat' })).toBeEnabled();
  await expect(host).toHaveURL(hasDeviceGameLink);
  const id = new URL(host.url()).searchParams.get('game');

  // The host's result names both seats: the link shows both players, and the guest's history has the
  // game with the host as the opponent.
  const { page: viewer } = await open({ path: `/?game=${id ?? ''}` });
  await expect(viewer.locator('#game-view')).toContainText(`${hostName} (X) vs ${guestName} (O)`);
  const guestToken = await playerToken(guest);
  const guestHistory = () =>
    guest.evaluate(async (token) => {
      const response = await fetch('/api/me/history', { headers: { 'x-player': token } });
      return JSON.stringify(await response.json());
    }, guestToken);
  await expect.poll(guestHistory).toContain(`"opponentName":"${hostName}"`);
  // The guest's own copy of the game stays out of the history: the game shows once.
  expect(JSON.parse(await guestHistory())).toMatchObject({ games: [{ mode: 'nearby', result: 'lost' }] });

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
  await guest.getByRole('button', { name: 'Computer', exact: true }).click();

  // The host reads the old answer anyway. Its attempt ends when the connect timeout (15 s) runs out.
  await useCode(host, answer);
  await expect.poll(() => toasts(host), { timeout: 30_000 }).toContainEqual(expect.stringContaining('did not connect'));
  const guestToasts = await toasts(guest);
  expect(guestToasts).not.toContainEqual(expect.stringContaining('Joined'));
  expect(guestToasts, 'a deliberate cancel needs no message').not.toContainEqual(expect.stringContaining('cancelled'));
  await expect.poll(async () => (await storedSettings(guest)).mode).toBe('computer');
});
