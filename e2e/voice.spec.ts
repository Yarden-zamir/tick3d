import { DEFAULT_RANGE, frequencyAt, stepOfCell } from '../src/voice/mapping.ts';
import { cell, expect, expectToast, marks, oscillatorMic, setTone, status, test, toasts } from './fixtures.ts';

// The middle of the pitch band of a cell in the default range of /sound-input.
const toneOf = (index: number) => frequencyAt(stepOfCell(index) + 0.5, { range: DEFAULT_RANGE, spread: 'log' });

// Layer 2, row 3, column 2.
const TARGET = 16 + 2 * 4 + 1;

test('a held note places the move on its cell, and the computer replies', async ({ open }) => {
  const { page, context } = await open({ settings: { mode: 'computer', difficulty: 'easy', human: 'X' } });
  await context.addInitScript(oscillatorMic);
  await page.reload();
  await expect(status(page)).toContainText('Your move');

  const voice = page.getByRole('button', { name: 'Play by voice' });
  await expect(voice).toHaveAttribute('aria-pressed', 'false');
  await voice.click();
  await expect(voice).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#voice-panel')).toBeVisible();
  await expect(page.locator('#voice-rail .rail-track')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Calibrate and practice' })).toHaveAttribute('href', '/sound-input?return=%2F');
  await expect(voice).toHaveAttribute('data-state', 'listening');

  await setTone(page, toneOf(TARGET));
  // The aim shows on the board and on the keypad, with the light of the Voice room (src/voice/visuals.ts).
  await expect(cell(page, TARGET)).toHaveClass(/\baim\b/);
  await expect(cell(page, TARGET)).toHaveClass(/\blit\b/);
  await expect(page.locator('#coords .slot b')).toHaveText(['2', '3', '2']);
  // After the hold time, the move is placed.
  await expect(cell(page, TARGET)).toHaveClass(/\bx\b/);
  // A desktop has no tilt sensor: no tilt shows.
  await expect(page.locator('#voice-recentre')).toBeHidden();
  await expect(page.locator('#voice-rail .rail-tilt')).toBeHidden();
  await setTone(page, null);
  // The computer replies, and the voice listens again on the next turn.
  await expect(marks(page)).toHaveCount(2);
  await expect(status(page)).toContainText('Your move');
  await expect(voice).toHaveAttribute('data-state', 'listening');

  // The setting stays after a reload.
  await page.reload();
  await expect(page.getByRole('button', { name: 'Play by voice' })).toHaveAttribute('aria-pressed', 'true');
});

test('in a friend game the voice plays both seats, and a taken cell gives the normal refusal', async ({ open }) => {
  const { page, context } = await open({ settings: { mode: 'friend' } });
  await context.addInitScript(oscillatorMic);
  await page.reload();
  await page.getByRole('button', { name: 'Play by voice' }).click();

  await setTone(page, toneOf(TARGET));
  await expect(cell(page, TARGET)).toHaveClass(/\bx\b/);
  // One note places one move: the same note goes on after the move, and nothing happens.
  const before = (await toasts(page)).length;
  await page.waitForTimeout(2500);
  expect((await toasts(page)).slice(before)).toEqual([]);
  await expect(marks(page)).toHaveCount(1);
  // A new note on the taken cell, after a silence, gives the normal refusal and places nothing.
  await setTone(page, null);
  await page.waitForTimeout(1000);
  await setTone(page, toneOf(TARGET));
  await expectToast(page, 'That cell is taken');
  await expect(marks(page)).toHaveCount(1);

  // O plays by voice on another cell.
  await setTone(page, toneOf(TARGET + 1));
  await expect(cell(page, TARGET + 1)).toHaveClass(/\bo\b/);
  await expect(marks(page)).toHaveCount(2);
});

test('a blocked microphone shows what to do, and turns the voice off', async ({ open }) => {
  const { page, context } = await open({ settings: { mode: 'friend' } });
  await context.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException('Permission denied', 'NotAllowedError'));
  });
  await page.reload();
  const voice = page.getByRole('button', { name: 'Play by voice' });
  await voice.click();
  await expectToast(page, 'The mic is blocked');
  await expect(voice).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('#voice-panel')).toBeHidden();
});

test('on a touch screen, the voice panel keeps the space of Recentre tilt only with tilt on', async ({ browser, baseURL }) => {
  if (baseURL === undefined) throw new Error('the config sets no baseURL');
  for (const tilt of [null, { on: true, steps: 2 }]) {
    const context = await browser.newContext({ baseURL, hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } });
    await context.addInitScript(oscillatorMic);
    await context.addInitScript((stored) => {
      if (localStorage.getItem('tick3d.settings') === null) localStorage.setItem('tick3d.settings', JSON.stringify({ mode: 'friend' }));
      if (stored !== null && localStorage.getItem('tick3d.voice') === null) localStorage.setItem('tick3d.voice', JSON.stringify({ version: 2, range: null, spread: 'log', stickiness: { share: 0.3, buildUpMs: 1500 }, tilt: stored }));
    }, tilt);
    const page = await context.newPage();
    await page.goto('/');
    await page.getByRole('button', { name: 'Play by voice' }).click();
    await expect(page.locator('#voice-panel')).toBeVisible();
    const recentre = page.locator('#voice-recentre');
    // No tilt reading in the test browser: the button stays hidden in both cases.
    await expect(recentre).toBeHidden();
    // A kept space is any box but none: the panel layout can turn inline-flex into flex.
    const keepsSpace = await recentre.evaluate((element) => getComputedStyle(element).display !== 'none');
    expect(keepsSpace, `tilt ${JSON.stringify(tilt)}`).toBe(tilt !== null);
    await context.close();
  }
});
