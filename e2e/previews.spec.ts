import { expect, test } from './fixtures.ts';

// The pull request number of the site under test, when it is a preview (pr.<n>.<domain>).
function previewNumberOf(baseURL: string): number | undefined {
  const [prefix, number] = new URL(baseURL).hostname.split('.');
  return prefix === 'pr' && number !== undefined && Number.isInteger(Number(number)) ? Number(number) : undefined;
}

test('the kitshn button lists the open previews and marks this one', async ({ open, baseURL }) => {
  if (baseURL === undefined) throw new Error('the config sets no baseURL');
  const { page } = await open();
  await page.getByRole('button', { name: 'Previews of open pull requests' }).click();
  const dialog = page.locator('#previews');
  await expect(dialog).toHaveAttribute('open');
  await expect(dialog.getByRole('heading', { name: 'Previews' })).toBeVisible();
  const list = dialog.locator('#previews-list');
  await expect(list).not.toContainText('Loading');

  // Other pull requests come and go, so the test checks only the preview under test.
  const number = previewNumberOf(baseURL);
  if (number !== undefined) {
    const here = list.locator('.preview.here');
    await expect(here).toHaveCount(1);
    await expect(here).toContainText('You are here');
    // A title, then the number.
    await expect(here.locator('.preview-head b')).toHaveText(new RegExp(`\\S.* #${number}$`));
    await expect(here.getByRole('link', { name: 'Pull request' })).toHaveAttribute('href', new RegExp(`^https://github\\.com/.+/pull/${number}$`));
    await expect(here.getByRole('link', { name: 'Open preview' })).toHaveAttribute('href', new URL(baseURL).origin);
    // At least the author of the pull request, with a link to the profile.
    await expect(here.locator('.preview-people a').first()).toHaveAttribute('href', /^https:\/\/github\.com\/[\w-]+$/);
  }

  await dialog.getByRole('button', { name: 'Close' }).click();
  await expect(dialog).not.toHaveAttribute('open');
});
