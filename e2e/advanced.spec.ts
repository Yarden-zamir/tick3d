import { DEFAULT_TUNING, TUNING_FIELDS, type TuningField } from '../src/tuning.ts';
import { STORAGE_KEYS } from '../src/storage-keys.ts';
import { cell, expect, expectToast, test } from './fixtures.ts';

function tuningField(path: readonly string[]): TuningField {
  const found = TUNING_FIELDS.find((field) => field.path.join('.') === path.join('.'));
  if (found === undefined) throw new Error(`no tuning field ${path.join('.')}`);
  return found;
}
const budget = tuningField(['hard', 'budgetMs']);
const mediumForkBlock = tuningField(['medium', 'tired', 'forkBlock']);

test('advanced computer settings: validate, persist, play, reset, and lock', async ({ open }) => {
  const { page } = await open({ settings: { mode: 'computer', difficulty: 'medium' } });
  const advanced = page.locator('#advanced');
  const thinkingTime = advanced.locator('label', { hasText: budget.label }).locator('input');
  const storedBudget = () =>
    page.evaluate((key) => (JSON.parse(localStorage.getItem(key) ?? 'null') as { hard?: { budgetMs?: number } } | null)?.hard?.budgetMs, STORAGE_KEYS.tuning);
  const defaultBudget = String(budget.get(DEFAULT_TUNING));

  await expect(advanced).toBeVisible();
  await expect(advanced).toHaveJSProperty('open', false);
  await advanced.locator('summary').click();
  await expect(thinkingTime).toHaveValue(defaultBudget);
  await thinkingTime.fill(String(budget.max));
  await thinkingTime.press('Tab');
  await expect.poll(storedBudget).toBe(budget.max);
  await thinkingTime.fill('99999');
  await thinkingTime.press('Tab');
  await expectToast(page, `from ${budget.min} to ${budget.max}`);
  await expect(thinkingTime).toHaveValue(String(budget.max));

  await page.reload();
  await advanced.locator('summary').click();
  await expect(thinkingTime).toHaveValue(String(budget.max));
  // A default with many decimals must keep its exact value through the form.
  const medium = advanced.locator('fieldset', { hasText: mediumForkBlock.group });
  await expect(medium.locator('label', { hasText: mediumForkBlock.label }).locator('input')).toHaveValue(String(mediumForkBlock.get(DEFAULT_TUNING)));

  await cell(page, 21).click();
  await expect(page.locator('.cell.o')).toHaveCount(1);

  await page.locator('#tuning-reset').click();
  await expect.poll(storedBudget).toBeUndefined();
  await expect(thinkingTime).toHaveValue(defaultBudget);

  await page.getByRole('button', { name: 'Friend' }).click();
  await expect(advanced).toBeHidden();
  await page.getByRole('button', { name: 'Computer' }).click();
  await expect(advanced).toBeVisible();
});
