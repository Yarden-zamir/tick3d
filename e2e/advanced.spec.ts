import { cell, expect, expectToast, test } from './fixtures.ts';

test('advanced computer settings: validate, persist, play, reset, and lock', async ({ open }) => {
  const { page } = await open({ settings: { mode: 'computer', difficulty: 'medium' } });
  const advanced = page.locator('#advanced');
  const thinkingTime = advanced.locator('label', { hasText: 'Thinking time (ms)' }).locator('input');
  const storedBudget = () => page.evaluate(() => (JSON.parse(localStorage.getItem('tick3d.tuning') ?? 'null') as { hard?: { budgetMs?: number } } | null)?.hard?.budgetMs);

  await expect(advanced).toBeVisible();
  await expect(advanced).toHaveJSProperty('open', false);
  await advanced.locator('summary').click();
  await expect(thinkingTime).toHaveValue('600');
  await thinkingTime.fill('1000');
  await thinkingTime.press('Tab');
  await expect.poll(storedBudget).toBe(1000);
  await thinkingTime.fill('99999');
  await thinkingTime.press('Tab');
  await expectToast(page, 'from 50 to 1000');
  await expect(thinkingTime).toHaveValue('1000');

  await page.reload();
  await advanced.locator('summary').click();
  await expect(thinkingTime).toHaveValue('1000');
  // A default with many decimals must keep its exact value through the form.
  const medium = advanced.locator('fieldset', { hasText: 'Medium' });
  await expect(medium.locator('label', { hasText: "Sees opponent's double threat, tired" }).locator('input')).toHaveValue('0.07');

  await cell(page, 21).click();
  await expect(page.locator('.cell.o')).toHaveCount(1);

  await page.locator('#tuning-reset').click();
  await expect.poll(storedBudget).toBeUndefined();
  await expect(thinkingTime).toHaveValue('600');

  await page.getByRole('button', { name: 'Friend' }).click();
  await expect(advanced).toBeHidden();
  await page.getByRole('button', { name: 'Computer' }).click();
  await expect(advanced).toBeVisible();
  await page.locator('#lock').click();
  await expect(page.locator('#lock')).toContainText('Locked');
  await expect(advanced.locator('input').first()).toBeDisabled();
});
