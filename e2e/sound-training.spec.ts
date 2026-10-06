import { expect, test } from './fixtures.ts';

// The ear training page needs no server: it keeps its progress in localStorage.
// It plays sounds, and a headless browser plays them without a speaker.
test('the ear training shows answers first, then hides them, and keeps its progress', async ({ page }) => {
  const errors: Error[] = [];
  page.on('pageerror', (error) => errors.push(error));
  const response = await page.goto('/sound-training');
  expect(response?.headers()['x-robots-tag']).toContain('noindex');

  const kind = page.locator('#card-kind');
  const answer = page.locator('#card-answer');
  const next = page.locator('#next');
  // A new sound shows its answer.
  await expect(kind).toHaveText('New sound');
  await expect(answer).toBeVisible();
  await expect(answer).toContainText('layer');
  await expect(answer).toContainText('row');
  await expect(answer).toContainText('column');

  // A few learn cards later, the first quiz card hides the answer.
  for (let i = 0; i < 10 && (await kind.textContent()) !== 'Quiz'; i++) await next.click();
  await expect(kind).toHaveText('Quiz');
  await expect(answer).toBeHidden();
  await expect(page.locator('.train-pick')).toHaveCount(4);
  await expect(page.locator('#check')).toBeDisabled();

  // Pick 4 until an answer is wrong (the first items are value 1). The feedback marks it, and the item goes back to box 1 and stays due.
  const feedback = page.locator('#card-feedback');
  for (let i = 0; i < 30; i++) {
    if ((await kind.textContent()) !== 'Quiz') {
      await next.click();
      continue;
    }
    await page.locator('.train-pick').last().click();
    await page.locator('#check').click();
    await expect(feedback).not.toBeEmpty();
    if ((await feedback.textContent())?.includes('wrong')) break;
    await next.click();
  }
  await expect(feedback).toContainText('wrong');
  await expect(page.locator('.train-pick.wrong')).toHaveCount(1);
  await expect(page.locator('#yours')).toBeVisible();
  const dimension = await page.locator('.train-group').getAttribute('data-dimension');
  const value = await page.locator('.train-pick.right').getAttribute('data-value');
  const item = page.locator(`.train-value[data-item="${dimension}-${value}"]`);
  await expect(item).toHaveAttribute('data-box', '1');
  await expect(item).toHaveAttribute('data-due', 'true');

  // The progress stays after a reload.
  const totals = await page.locator('#totals').textContent();
  expect(totals).toMatch(/^[1-9]\d* cards done/);
  await page.reload();
  await expect(page.locator('#totals')).toHaveText(totals ?? '');
  await expect(item).toHaveAttribute('data-box', '1');
  expect(errors).toEqual([]);
});
