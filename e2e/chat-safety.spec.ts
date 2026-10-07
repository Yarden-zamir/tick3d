import type { Locator } from '@playwright/test';
import { createOnline, expect, expectToast, joinAsO, ownName, test } from './fixtures.ts';

// This file creates 1 online session (the server allows 60 per hour for one client address).

// A long press with a finger: the pointer goes down, stays for longer than the press time, and goes up.
async function longPress(target: Locator): Promise<void> {
  const box = await target.boundingBox();
  if (box === null) throw new Error('the target is not on screen');
  const at = { pointerType: 'touch', isPrimary: true, bubbles: true, clientX: box.x + box.width / 2, clientY: box.y + box.height / 2 };
  await target.dispatchEvent('pointerdown', at);
  await target.page().waitForTimeout(700);
  await target.dispatchEvent('pointerup', at);
}

test('a long press on a message opens the menu, Block hides the person, and a report hides a message', async ({ open }) => {
  const { page: alice } = await open();
  const aliceName = await ownName(alice);
  const link = `/?code=${await createOnline(alice)}`;
  const { page: bob } = await joinAsO(open, link);
  await alice.locator('#chat-input').fill('buy cheap coins');
  await alice.locator('#chat-input').press('Enter');
  const message = bob.locator('#chat-log .chat-message', { hasText: 'buy cheap coins' });
  await expect(message).toBeVisible();
  // Alice's own message opens no menu for her.
  await longPress(alice.locator('#chat-log .chat-message').first());
  await expect(alice.locator('#safety-menu')).toBeHidden();

  await longPress(message);
  const menu = bob.locator('#safety-menu');
  await expect(menu).toBeVisible();
  await expect(menu).toContainText(`A message from ${aliceName}`);
  await menu.getByRole('button', { name: 'Block' }).click();
  await expectToast(bob, `${aliceName} is blocked`);
  await expect(message).toBeHidden();
  // A blocked person shows with a generated name, in the score too.
  await expect(bob.locator('.tally.X')).not.toContainText(aliceName);
  await alice.locator('#chat-input').fill('second try');
  await alice.locator('#chat-input').press('Enter');
  await expect(alice.locator('#chat-log')).toContainText('second try');
  await expect(bob.locator('#chat-log')).not.toContainText('second try');

  // Unblock in My games: the messages come back.
  await bob.locator('#account-button').click();
  const blocked = bob.locator('#my-games-blocked li', { hasText: aliceName });
  await blocked.getByRole('button', { name: 'Unblock' }).click();
  await expect(bob.locator('#my-games-blocked-box')).toBeHidden();
  await bob.locator('#my-games-close').click();
  await expect(message).toBeVisible();

  // The keyboard: Shift+F10 on a focused message opens the same menu. A report hides the message here.
  await message.focus();
  await bob.keyboard.press('Shift+F10');
  await menu.getByRole('button', { name: 'Report' }).click();
  await menu.getByLabel('Spam').check();
  await menu.getByLabel('Note').fill('an ad');
  await menu.getByRole('button', { name: 'Send report' }).click();
  await expectToast(bob, 'The report went to the maintainers');
  await expect(message).toBeHidden();
  await expect(bob.locator('#chat-log')).toContainText('second try');
});
