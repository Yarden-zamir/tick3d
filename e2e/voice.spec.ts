import type { Page } from '@playwright/test';
import { DEFAULT_RANGE, frequencyAt, stepOfCell } from '../src/voice/mapping.ts';
import { cell, expect, expectToast, marks, status, test, toasts } from './fixtures.ts';

// Runs in the page before the app: the microphone is an oscillator. window.e2eTone(frequency) sets its
// pitch, and window.e2eTone(null) makes it silent.
function oscillatorMic(): void {
  navigator.mediaDevices.getUserMedia = async () => {
    const context = new AudioContext();
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    gain.gain.value = 0;
    const output = context.createMediaStreamDestination();
    oscillator.connect(gain).connect(output);
    oscillator.start();
    (window as unknown as { e2eTone: (frequency: number | null) => void }).e2eTone = (frequency) => {
      gain.gain.setValueAtTime(frequency === null ? 0 : 0.5, context.currentTime);
      if (frequency !== null) oscillator.frequency.setValueAtTime(frequency, context.currentTime);
    };
    await context.resume();
    return output.stream;
  };
}

const setTone = (page: Page, frequency: number | null) =>
  page.evaluate((value) => (window as unknown as { e2eTone: (frequency: number | null) => void }).e2eTone(value), frequency);

// The middle of the pitch band of a cell in the default range of /sound-input.
const toneOf = (index: number) => frequencyAt(stepOfCell(index) + 0.5, DEFAULT_RANGE);

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
  await expect(page.getByRole('link', { name: 'Calibrate and practice' })).toHaveAttribute('href', '/sound-input');
  await expect(voice).toHaveAttribute('data-state', 'listening');

  await setTone(page, toneOf(TARGET));
  // The aim shows on the board and on the keypad.
  await expect(cell(page, TARGET)).toHaveClass(/\baim\b/);
  await expect(page.locator('#coords .slot b')).toHaveText(['2', '3', '2']);
  // After the hold time, the move is placed.
  await expect(cell(page, TARGET)).toHaveClass(/\bx\b/);
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
  await expectToast(page, 'The microphone is blocked');
  await expect(voice).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('#voice-panel')).toBeHidden();
});
