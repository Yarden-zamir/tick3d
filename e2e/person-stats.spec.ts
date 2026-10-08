import { createOnline, expect, joinAsO, ownName, playTurns, test, xWins } from './fixtures.ts';

// This file creates 1 online session (the server allows 60 per hour for one client address).

test('the picture viewer links to the stats of the person, and "Hide my stats" closes them to others', async ({ open }) => {
  const { page: alice } = await open();
  const aliceName = await ownName(alice);
  const link = `/?code=${await createOnline(alice)}`;
  const { page: bob } = await joinAsO(open, link);
  await playTurns(xWins(alice, bob));
  for (const page of [alice, bob]) {
    await expect(page.locator('#end-card')).toHaveAttribute('open');
    await page.locator('#end-card-close').click();
  }
  await alice.locator('#chat-input').fill('good game');
  await alice.locator('#chat-input').press('Enter');

  await bob.locator('#chat-log').getByRole('button', { name: `View ${aliceName}'s picture` }).click();
  await bob.locator('#avatar-viewer').getByRole('link', { name: `Stats of ${aliceName}` }).click();
  await expect(bob).toHaveURL(/\/stats\?person=[0-9a-f]{16}$/);
  const statsAddress = bob.url();
  await expect(bob.locator('#stats-person')).toHaveText(`Stats of ${aliceName}`);
  await expect(bob.locator('#stats-note')).toContainText(`the games of ${aliceName}`);
  // The results of the person, without the opponents card of Mine.
  await expect(bob.getByRole('heading', { name: 'Results', exact: true })).toBeVisible();
  await expect(bob.getByRole('heading', { name: 'Favourite opponents' })).toHaveCount(0);

  // Alice hides her stats in My games: Bob gets the message, and Alice still sees hers.
  await alice.locator('#account-button').click();
  const hide = alice.getByRole('switch', { name: 'Hide my stats from other players' });
  await hide.check();
  await expect(hide).toBeChecked();
  await alice.locator('#my-games-close').click();
  await bob.reload();
  await expect(bob.locator('#stats-note')).toHaveText('This player keeps their stats private.');
  await expect(bob.locator('#stats-person')).toBeHidden();
  await alice.goto(statsAddress);
  await expect(alice.locator('#stats-person')).toHaveText(`Stats of ${aliceName}`);
});
