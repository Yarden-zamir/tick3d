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
