import { expect, storedSettings, test } from './fixtures.ts';

const nearby = { settings: { mode: 'nearby' } };

test('short mode names explain sharing a screen and follow the device icon', async ({ open }) => {
  const { page } = await open({ settings: { mode: 'friend' } });
  await expect(page.locator('#here-mode')).toHaveText('Here');
  await expect(page.locator('#here-mode')).toHaveAccessibleName('Here — two players on this computer');
  await expect(page.locator('#here-note')).toHaveText('Two players. One computer.');
  await expect(page.locator('.mode-picker [data-value="nearby"]')).toHaveText('Wi-Fi');
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'userAgentData', { value: { mobile: true } });
  });
  await page.reload();
  await expect(page.locator('#here-mode')).toHaveAccessibleName('Here — two players on this phone');
  await expect(page.locator('#here-note')).toHaveText('Two players. One phone.');
  await expect(page.locator('#here-icon rect')).toHaveAttribute('width', '12');
});

test('the Online suggestion needs a usable API answer, not just Wi-Fi connectivity', async ({ open }) => {
  const { page } = await open(nearby);
  let available = false;
  await page.route('**/api/nearby/hosts', (route) => route.fulfill({
    status: available ? 200 : 503,
    contentType: 'application/json',
    body: available ? '{"hosts":[]}' : '{"error":"Unavailable"}',
  }));
  expect(await page.evaluate(() => navigator.onLine)).toBe(true);
  await expect(page.locator('#nearby-offline')).toBeVisible();
  await expect(page.locator('#nearby-online')).toBeHidden();
  await expect(page.locator('#nearby-host')).toBeEnabled();
  available = true;
  await expect(page.locator('#nearby-online')).toBeVisible();
  await page.locator('#nearby-go-online').click();
  await expect.poll(() => storedSettings(page)).toMatchObject({ mode: 'online' });
});

test('cancelling a scan stops the camera without leaving the game page', async ({ open }) => {
  const { page, context } = await open(nearby);
  await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 100;
    const stream = canvas.captureStream(5);
    navigator.mediaDevices.getUserMedia = async () => stream;
    (window as unknown as { cameraTrack: MediaStreamTrack | undefined }).cameraTrack = stream.getVideoTracks()[0];
  });
  await page.locator('#nearby-join').click();
  await expect.poll(() => page.locator('#nearby-video').evaluate((video: HTMLVideoElement) => video.srcObject !== null)).toBe(true);
  await page.locator('#nearby-cancel').click();
  await expect(page.locator('#nearby-start')).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { cameraTrack: MediaStreamTrack }).cameraTrack.readyState)).toBe('ended');
  expect(context.pages()).toHaveLength(1);
});

test('a host reacquires its released screen lock when returning to the page', async ({ open }) => {
  const { page } = await open(nearby);
  await page.evaluate(() => {
    const state = { requests: 0, lock: { released: false, release: async () => undefined } };
    Object.defineProperty(navigator, 'wakeLock', { value: { request: async () => {
      state.requests++;
      state.lock = { released: false, release: async () => { state.lock.released = true; } };
      return state.lock;
    } } });
    (window as unknown as { wakeState: typeof state }).wakeState = state;
  });
  await page.locator('#nearby-host').click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { wakeState: { requests: number } }).wakeState.requests)).toBe(1);
  await page.evaluate(() => {
    (window as unknown as { wakeState: { lock: { released: boolean } } }).wakeState.lock.released = true;
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect.poll(() => page.evaluate(() => (window as unknown as { wakeState: { requests: number } }).wakeState.requests)).toBe(2);
});
