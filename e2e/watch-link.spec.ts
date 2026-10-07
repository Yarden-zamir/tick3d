import { createOnline, expect, expectToast, test } from './fixtures.ts';

// This file creates one online session. The server allows 60 new sessions per hour for one client address.

test('a watch link opens the session without a seat, and the watcher can take the free seat later', async ({ open }) => {
  const { page: alice, context } = await open();
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const code = await createOnline(alice);
  await alice.locator('#share-watch').click();
  await expectToast(alice, 'Watch link copied');
  const link = new URL(await alice.evaluate(() => navigator.clipboard.readText()));
  expect(link.searchParams.get('code')).toBe(code);
  expect(link.searchParams.get('watch')).toBe('1');

  // Seat O is free, and the watch link still gives a watcher. A reload keeps it so.
  const { page: carol } = await open({ path: `${link.pathname}${link.search}` });
  await expectToast(carol, 'You are watching');
  const oRow = (page: typeof alice) => page.locator('#players-list li').nth(1);
  await expect(oRow(alice)).toContainText('Empty seat');
  await carol.reload();
  await expect(carol).toHaveURL(/[?&]watch=1/);
  await expect(oRow(carol)).toContainText('Empty seat');
  await expect(carol.locator('#players-list li').nth(2)).toContainText('You · Watching');
  await expect(oRow(alice)).toContainText('Empty seat');

  // The Players box seats the watcher on request.
  await oRow(carol).getByRole('button', { name: 'Play O' }).click();
  await expectToast(carol, 'You play O now');
  await expect(oRow(alice)).not.toContainText('Empty seat');
});
