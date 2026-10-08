import { readFile } from 'node:fs/promises';
import type { Page } from '@playwright/test';
import { DEFAULT_RANGE, frequencyAt, stepOfCell } from '../src/voice/mapping.ts';
import { cell, expect, oscillatorMic, setTone, status, test } from './fixtures.ts';

// Runs in the page before the app: counts the oscillators that the page makes, live or offline.
function countOscillators(): void {
  const counter = { count: 0 };
  (window as unknown as { e2eOscillators: typeof counter }).e2eOscillators = counter;
  const create = Object.getOwnPropertyDescriptor(BaseAudioContext.prototype, 'createOscillator')?.value as (this: BaseAudioContext) => OscillatorNode;
  BaseAudioContext.prototype.createOscillator = function (this: BaseAudioContext) {
    counter.count++;
    return create.call(this);
  };
}

// Runs in the page before the app: keeps the peak level of each voice clip that a song plays. Only a
// voice clip copies samples into an AudioBuffer.
function recordClips(): void {
  const peaks: number[] = [];
  (window as unknown as { e2eClipPeaks: number[] }).e2eClipPeaks = peaks;
  const copy = Object.getOwnPropertyDescriptor(AudioBuffer.prototype, 'copyToChannel')?.value as AudioBuffer['copyToChannel'];
  AudioBuffer.prototype.copyToChannel = function (this: AudioBuffer, source, channel, start) {
    peaks.push(source.reduce((peak, sample) => Math.max(peak, Math.abs(sample)), 0));
    copy.call(this, source, channel, start);
  };
}

const clipPeaks = (page: Page) => page.evaluate(() => [...(window as unknown as { e2eClipPeaks: number[] }).e2eClipPeaks]);

const oscillatorCount = (page: Page) => page.evaluate(() => (window as unknown as { e2eOscillators: { count: number } }).e2eOscillators.count);

// X takes the row 0, 1, 2, 3 in a friend game, and O takes 16, 17, 18.
const X_WINS = [0, 16, 1, 17, 2, 18, 3];

async function finishFriendGame(page: Page): Promise<void> {
  for (const index of X_WINS) await cell(page, index).click();
  await expect(status(page)).toHaveText('Player X wins!');
  await expect(page.locator('#end-card')).toHaveAttribute('open');
}

test('the song button of the end card plays the game, and a long press downloads it as a WAV file', async ({ open }) => {
  const { page, context } = await open({ settings: { mode: 'friend' } });
  await context.addInitScript(countOscillators);
  await page.reload();
  await finishFriendGame(page);

  const song = page.getByRole('button', { name: 'Play the game as a song' });
  await expect(song).toBeVisible();
  const before = await oscillatorCount(page);
  await song.click();
  // One voice or more for each of the 7 moves and the 4 notes of the win line.
  await expect.poll(async () => (await oscillatorCount(page)) - before).toBeGreaterThanOrEqual(X_WINS.length + 4);
  await expect(song).toHaveAttribute('data-state', 'playing');
  // The cell of each note lights on the card while it sounds. A second click stops the song and the light.
  await expect(page.locator('#end-card-light')).toBeVisible();
  await song.click();
  await expect(song).toHaveAttribute('data-state', 'idle');
  await expect(page.locator('#end-card-light')).toBeHidden();

  // A long press: the button asks for the release, and the release downloads the file (desktop Chromium has no file share).
  const box = await song.boundingBox();
  if (box === null) throw new Error('the song button has no box');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await expect(song).toHaveAttribute('data-state', 'held');
  const download = page.waitForEvent('download');
  await page.mouse.up();
  const file = await download;
  expect(file.suggestedFilename()).toMatch(/^tick3d-\d{4}-\d{2}-\d{2}\.wav$/);
  const wav = await readFile(await file.path());
  expect(wav.subarray(0, 4).toString('ascii')).toBe('RIFF');
  expect(wav.subarray(8, 12).toString('ascii')).toBe('WAVE');
  expect(wav.readUInt32LE(4)).toBe(wav.length - 8);
  // About 2 seconds of sound or more: 7 moves, the run up the winning line and the final chord.
  expect(wav.readUInt32LE(40)).toBeGreaterThan(2 * 44_100 * 4);
  // The long press does not also play the song.
  await expect(song).toHaveAttribute('data-state', 'idle');
  // A right click after the long press shares the song again, and a later click plays it.
  const again = page.waitForEvent('download');
  await song.click({ button: 'right' });
  expect((await again).suggestedFilename()).toMatch(/\.wav$/);
  await expect(song).toHaveAttribute('data-state', 'idle');
  await song.click();
  await expect(song).toHaveAttribute('data-state', 'playing');
});

test('a finished game from its link plays its song and lights the cells of the board', async ({ open }) => {
  const { page } = await open({ settings: { mode: 'friend' } });
  await finishFriendGame(page);
  await expect(page).toHaveURL(/[?&]game=/);
  const link = new URL(page.url());
  const viewer = await open({ path: `/?game=${link.searchParams.get('game') ?? ''}` });
  const song = viewer.page.getByRole('button', { name: 'Play the game as a song' });
  await expect(song).toBeVisible();
  await song.click();
  await expect(viewer.page.locator('.cell.sung')).toHaveCount(1);
  await song.click();
  await expect(viewer.page.locator('.cell.sung')).toHaveCount(0);
});

test('a winning move by voice plays the voice in the song of the end card', async ({ open }) => {
  const { page, context } = await open({ settings: { mode: 'friend' } });
  await context.addInitScript(oscillatorMic);
  await context.addInitScript(recordClips);
  await page.reload();
  // Six taps, then X takes cell 3, the last cell of the row, by voice. The winning move stops the voice.
  for (const index of X_WINS.slice(0, -1)) await cell(page, index).click();
  await page.getByRole('button', { name: 'Play by voice' }).click();
  await setTone(page, frequencyAt(stepOfCell(3) + 0.5, { range: DEFAULT_RANGE, spread: 'log' }));
  await expect(status(page)).toHaveText('Player X wins!');
  await setTone(page, null);
  await expect(page.locator('#end-card')).toHaveAttribute('open');

  await expect(page.locator('#end-card-voice-option')).toBeVisible();
  await page.getByRole('button', { name: 'Play the game as a song' }).click();
  // The song plays one clip, the held note of the winning move: not silence.
  await expect.poll(() => clipPeaks(page)).toHaveLength(1);
  expect((await clipPeaks(page))[0]).toBeGreaterThan(0.1);
});
