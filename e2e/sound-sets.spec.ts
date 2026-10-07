import type { Page } from '@playwright/test';
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
  const byDefault = await soundOfTakenCell(page);

  await page.getByRole('button', { name: 'Sound set', exact: true }).click();
  const menu = page.locator('#sound-sets');
  await expect(menu).toBeVisible();
  await expect(menu.locator('[data-sound-set="pitched"]')).toHaveAttribute('aria-pressed', 'true');

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
  expect(chiptune).not.toEqual(byDefault);

  await page.reload();
  await page.getByRole('button', { name: 'Sound set', exact: true }).click();
  await expect(page.locator('[data-sound-set="chiptune"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('[data-sound-set="pitched"]')).toHaveAttribute('aria-pressed', 'false');
});

// Classic keeps a typed cell quiet until Place. Every other set plays it on the third number.
test('the keypad plays the typed cell only on Place with Classic', async ({ open }) => {
  const { page, context } = await open({ settings: { mode: 'friend', soundSet: 'classic' } });
  await context.addInitScript(recordOscillators);
  await page.reload();
  const click = 'sine 1200.00';
  const tap = async (...digits: number[]) => {
    for (const digit of digits) await page.locator(`[data-digit="${digit}"]`).click();
  };

  // Layer 2 is D5 in Classic.
  await tap(2, 3);
  await oscillators(page);
  await tap(4);
  expect(await oscillators(page)).toEqual([click]);
  await expect(page.locator('#coords-hear')).toBeHidden();
  await page.locator('#coords-place').click();
  await expect.poll(async () => await oscillators(page)).toContain('triangle 587.33');

  // With no typed number, the speaker replays the last move.
  await page.locator('#coords-hear').click();
  await expect.poll(async () => await oscillators(page)).toContain('triangle 587.33');

  // Classic, pitched names every cell, so it keeps the preview.
  await page.getByRole('button', { name: 'Sound set', exact: true }).click();
  await page.locator('[data-sound-set="pitched"]').click();
  await page.keyboard.press('Escape');
  await tap(1, 1);
  await oscillators(page);
  await tap(1);
  await expect.poll(async () => (await oscillators(page)).filter((entry) => entry !== click).length).toBeGreaterThan(0);
  await expect(page.locator('#coords-hear')).toBeVisible();
});
