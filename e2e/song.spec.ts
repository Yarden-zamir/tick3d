import { readFile } from 'node:fs/promises';
import type { Page } from '@playwright/test';
import { cell, expect, status, test } from './fixtures.ts';

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
  // About 2 seconds of sound or more: 7 moves, the flourish and the tail.
  expect(wav.readUInt32LE(40)).toBeGreaterThan(2 * 44_100 * 4);
  // The long press does not also play the song.
  await expect(song).toHaveAttribute('data-state', 'idle');
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
