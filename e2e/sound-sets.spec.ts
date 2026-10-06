import type { Page } from '@playwright/test';
import { SOUND_SET_IDS } from '../src/sound-sets.ts';
import { cell, expect, test } from './fixtures.ts';

// Runs in the page before the app: every oscillator frequency that the page sets goes into a log.
function recordOscillators(): void {
  const log: string[] = [];
  (window as unknown as { e2eOscillators: string[] }).e2eOscillators = log;
  // createOscillator lives on BaseAudioContext. The descriptor keeps the original method without a reference to an unbound method.
  const create = Object.getOwnPropertyDescriptor(BaseAudioContext.prototype, 'createOscillator')?.value as (this: BaseAudioContext) => OscillatorNode;
  BaseAudioContext.prototype.createOscillator = function (this: BaseAudioContext) {
    const oscillator = create.call(this);
    const set = oscillator.frequency.setValueAtTime.bind(oscillator.frequency);
    oscillator.frequency.setValueAtTime = (value: number, time: number) => {
      log.push(`${oscillator.type} ${value.toFixed(2)}`);
      return set(value, time);
    };
    return oscillator;
  };
}

const oscillators = (page: Page) => page.evaluate(() => (window as unknown as { e2eOscillators: string[] }).e2eOscillators.splice(0));

// The refusal sound of a taken cell, which is the same in every set.
const REFUSAL = new Set(['square 180.00', 'square 140.00']);

// A tap on a taken cell plays the refusal at once, and the sound of the mark on it a moment later.
// One call schedules all voices of a sound, so the first log with the mark has the whole sound.
async function soundOfTakenCell(page: Page): Promise<string[]> {
  await oscillators(page);
  await cell(page, 0).click();
  let sound: string[] = [];
  await expect.poll(async () => (sound = (await oscillators(page)).filter((entry) => !REFUSAL.has(entry))).length).toBeGreaterThan(0);
  return sound;
}

test('the sound set menu picks a set, keeps it after a reload, and the moves use it', async ({ open }) => {
  const { page, context } = await open({ settings: { mode: 'friend' } });
  await context.addInitScript(recordOscillators);
  await page.reload();

  await cell(page, 0).click();
  const cells = await soundOfTakenCell(page);

  await page.getByRole('button', { name: 'Sound set', exact: true }).click();
  const menu = page.locator('#sound-sets');
  await expect(menu).toBeVisible();
  await expect(menu.locator('.sound-set-play')).toHaveCount(SOUND_SET_IDS.length);
  await expect(menu.locator('[data-sound-set="cells"]')).toHaveAttribute('aria-pressed', 'true');

  // A demo button plays four moves.
  await oscillators(page);
  await page.getByRole('button', { name: 'Play the Gamelan demo' }).click();
  await expect.poll(async () => (await oscillators(page)).length).toBeGreaterThan(4);

  await menu.locator('[data-sound-set="chiptune"]').click();
  await expect(menu.locator('[data-sound-set="chiptune"]')).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();

  // The same cell and the same mark sound different in another set.
  const chiptune = await soundOfTakenCell(page);
  expect(chiptune).not.toEqual(cells);

  await page.reload();
  await page.getByRole('button', { name: 'Sound set', exact: true }).click();
  await expect(page.locator('[data-sound-set="chiptune"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('[data-sound-set="cells"]')).toHaveAttribute('aria-pressed', 'false');
});

// The ear training page has no toast, so this test uses the plain page and not `open`.
test('the ear trainer follows the chosen set, and uses Cells for Classic', async ({ page }) => {
  await page.goto('/sound-training');
  for (const [soundSet, name] of [['choir', 'Choir'], ['classic', 'Cells']]) {
    await page.evaluate((value) => localStorage.setItem('tick3d.settings', JSON.stringify({ soundSet: value })), soundSet);
    await page.reload();
    await expect(page.locator('#totals')).toContainText(`${name} sound set`);
  }
});
