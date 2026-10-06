import { cell, createOnline, expect, expectToast, marks, status, test } from './fixtures.ts';

test('home asks before it drops a game in progress', async ({ open }) => {
  const { page } = await open({ settings: { mode: 'computer' } });
  const dialog = page.locator('#home-confirm');
  await page.locator('#home-link').click();
  await expect(dialog).not.toHaveAttribute('open');

  await cell(page, 0).click();
  await expect(marks(page)).toHaveCount(2);
  await page.locator('#home-link').click();
  await expect(dialog).toHaveAttribute('open');
  await expect(page.locator('#home-confirm-text')).toContainText('game in progress');
  await page.locator('#home-confirm-stay').click();
  await expect(dialog).not.toHaveAttribute('open');
  await expect(marks(page)).toHaveCount(2);

  await page.locator('#home-link').click();
  await page.locator('#home-confirm-leave').click();
  await expect(marks(page)).toHaveCount(0);
});

test('home from an online session drops the code and returns to the computer', async ({ open }) => {
  const { page } = await open();
  await createOnline(page);
  await page.locator('#home-link').click();
  await expect(page.locator('#home-confirm-text')).toContainText('online');
  await page.locator('#home-confirm-leave').click();
  await expect.poll(() => new URL(page.url()).search).toBe('');
  await expect.poll(() => page.evaluate(() => (JSON.parse(localStorage.getItem('tick3d.settings') ?? '{}') as { mode?: string }).mode)).toBe('computer');
  await expect(page.locator('#online-code')).toBeHidden();
});

test('a link with a code that opens no game drops the code and starts as usual', async ({ open }) => {
  const { page } = await open({ path: '/?code=ZZZZ' });
  await expectToast(page, 'No game with code ZZZZ');
  await expect.poll(() => new URL(page.url()).search).toBe('');
  await expect(status(page)).toContainText(/Your move|to move/);

  await page.goto('/?code=!!');
  await expect.poll(() => new URL(page.url()).search).toBe('');
  await expect(status(page)).toContainText(/Your move|to move/);
});

test('the join box refuses a code with a character that codes never use', async ({ open }) => {
  // The join box is in the Online mode only. A page that starts in the Online mode creates no session.
  const { page } = await open({ settings: { mode: 'online' } });
  await page.locator('#join-code').fill('AB0K');
  await page.locator('#join-code').press('Enter');
  await expectToast(page, 'A code has 4 letters or digits');
});
