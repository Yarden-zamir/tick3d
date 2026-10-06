import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures.ts';

// Chromium plays a WAV file as a fake microphone and grants the microphone without a prompt.
// The file is a steady G5 (784 Hz): layer 4 (G), row 2 (octave 5), column 2.
const RATE = 48_000;
const G5 = 784;
const G5_CELL = 3 * 16 + 1 * 4 + 1;

function sineWav(frequency: number, seconds: number): Buffer {
  const count = RATE * seconds;
  const wav = Buffer.alloc(44 + count * 2);
  wav.write('RIFF', 0);
  wav.writeUInt32LE(36 + count * 2, 4);
  wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); // The size of the format block.
  wav.writeUInt16LE(1, 20); // PCM.
  wav.writeUInt16LE(1, 22); // One channel.
  wav.writeUInt32LE(RATE, 24);
  wav.writeUInt32LE(RATE * 2, 28); // Bytes per second.
  wav.writeUInt16LE(2, 32); // Bytes per frame.
  wav.writeUInt16LE(16, 34); // Bits per sample.
  wav.write('data', 36);
  wav.writeUInt32LE(count * 2, 40);
  for (let index = 0; index < count; index++) wav.writeInt16LE(Math.round(16_000 * Math.sin((2 * Math.PI * frequency * index) / RATE)), 44 + index * 2);
  return wav;
}

// One file for each worker process, so no worker reads a file that another one writes.
const fakeMic = join(tmpdir(), `tick3d-g5-${process.pid}.wav`);
writeFileSync(fakeMic, sineWav(G5, 2));
test.use({ launchOptions: { args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${fakeMic}`] } });

function trackErrors(page: Page): Error[] {
  const errors: Error[] = [];
  page.on('pageerror', (error) => errors.push(error));
  return errors;
}

test('a steady note lights its cell, a held note places an X, and Stop puts the light out', async ({ page }) => {
  const errors = trackErrors(page);
  const response = await page.goto('/sound-input');
  expect(response?.status()).toBe(200);
  await expect(page.locator('#deck .cell')).toHaveCount(64);
  await expect(page.locator('#deck .cell.lit')).toHaveCount(0);

  const mic = page.locator('#mic');
  await mic.click();
  await expect(mic).toHaveText('Stop');
  const lit = page.locator('#deck .cell.lit');
  await expect(lit).toHaveCount(1);
  await expect(lit).toHaveAttribute('data-cell', String(G5_CELL));
  await expect(page.locator('#cell')).toContainText('Layer 4');
  await expect(page.locator('#note')).toContainText('G5');
  // The hold is on by default: after a second on one cell, the cell gets an X.
  await expect(page.locator(`#deck .cell[data-cell="${G5_CELL}"]`)).toHaveClass(/\bx\b/);

  await mic.click();
  await expect(mic).toHaveText('Turn on the microphone');
  await expect(lit).toHaveCount(0);
  await page.locator('#clear').click();
  await expect(page.locator('#deck .cell.x')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('a blocked microphone shows what to do, and the page stays usable', async ({ page }) => {
  const errors = trackErrors(page);
  await page.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException('Permission denied', 'NotAllowedError'));
  });
  await page.goto('/sound-input');
  const mic = page.locator('#mic');
  await mic.click();
  await expect(page.locator('#message')).toContainText('blocked');
  await expect(mic).toHaveText('Turn on the microphone');
  await expect(mic).toBeEnabled();
  await expect(page.locator('#deck .cell.lit')).toHaveCount(0);
  expect(errors).toEqual([]);
});

// The calibration needs two tones in turn, so this test feeds the page an oscillator as its microphone.
// window.e2eTone(frequency) changes the tone. The test above covers the real fake device of Chromium.
async function oscillatorMic(page: Page): Promise<void> {
  await page.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = async () => {
      const context = new AudioContext();
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      gain.gain.value = 0.5;
      const output = context.createMediaStreamDestination();
      oscillator.connect(gain).connect(output);
      oscillator.start();
      (window as unknown as { e2eTone: (frequency: number) => void }).e2eTone = (frequency) => oscillator.frequency.setValueAtTime(frequency, context.currentTime);
      await context.resume();
      return output.stream;
    };
  });
}

const setTone = (page: Page, frequency: number) =>
  page.evaluate((value) => (window as unknown as { e2eTone: (frequency: number) => void }).e2eTone(value), frequency);

test('a calibration from 300 Hz to 1200 Hz splits the rows over that range, and the device keeps it', async ({ page }) => {
  const errors = trackErrors(page);
  await oscillatorMic(page);
  await page.goto('/sound-input');
  const mode = page.locator('#range-mode');
  await expect(mode).toHaveText('Default bands');

  await page.locator('#calibrate').click();
  await setTone(page, 300);
  const calibration = page.locator('#calibration');
  await expect(calibration).toHaveAttribute('data-step', 'low');
  await expect(page.locator('#calibration-heard')).toContainText('Hz');
  await expect(calibration).toHaveAttribute('data-step', 'high', { timeout: 10_000 });
  await setTone(page, 1200);
  await expect(calibration).toBeHidden({ timeout: 10_000 });
  await expect(mode).toHaveText(/^Calibrated: (29\d|30\d)–(119\d|120\d) Hz$/);
  // Two octaves: no small range hint.
  await expect(page.locator('#range-hint')).toBeHidden();

  // 2 octaves make 4 rows of half an octave. 504 Hz is in the middle of the second row from the bottom (row 3).
  await setTone(page, 504);
  await expect(page.locator('#cell')).toContainText('row 3,');
  // A tone above the range lights the top edge: layer 4, row 1, column 4 (cell 3 × 16 + 3).
  await setTone(page, 3000);
  await expect(page.locator('#deck .cell.lit')).toHaveAttribute('data-cell', String(3 * 16 + 3));

  await page.reload();
  await expect(mode).toHaveText(/^Calibrated: /);
  await page.locator('#range-reset').click();
  await expect(mode).toHaveText('Default bands');
  await page.reload();
  await expect(mode).toHaveText('Default bands');
  expect(errors).toEqual([]);
});

test('a high sound below the low sound asks for a retry, and Cancel closes the calibration', async ({ page }) => {
  await oscillatorMic(page);
  await page.goto('/sound-input');
  await page.locator('#calibrate').click();
  await setTone(page, 800);
  const calibration = page.locator('#calibration');
  await expect(calibration).toHaveAttribute('data-step', 'high', { timeout: 10_000 });
  await setTone(page, 400);
  await expect(calibration).toHaveAttribute('data-step', 'retry', { timeout: 10_000 });
  await expect(page.locator('#calibration-retry')).toBeVisible();
  await expect(page.locator('#range-mode')).toHaveText('Default bands');
  await page.locator('#calibration-cancel').click();
  await expect(calibration).toBeHidden();
  await expect(page.locator('#calibrate')).toBeEnabled();
});
