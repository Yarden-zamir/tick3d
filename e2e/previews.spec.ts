import { PREVIEWS_CACHE_MS, PREVIEWS_RELAY_CACHE_MS } from '../server/api-docs.ts';
import { expect, test } from './fixtures.ts';

// The pull request number of the site under test, when it is a preview (pr.<n>.<domain>).
function previewNumberOf(baseURL: string): number | undefined {
  const [prefix, number] = new URL(baseURL).hostname.split('.');
  return prefix === 'pr' && number !== undefined && Number.isInteger(Number(number)) ? Number(number) : undefined;
}

// Production reads GitHub once per PREVIEWS_CACHE_MS, and a preview keeps that list for PREVIEWS_RELAY_CACHE_MS.
// So a preview that was just deployed shows up in the list at most this long after the deploy.
const LIST_DELAY_MS = PREVIEWS_CACHE_MS + PREVIEWS_RELAY_CACHE_MS;

test('the kitshn button lists the open previews and marks this one', async ({ open, baseURL }) => {
  if (baseURL === undefined) throw new Error('the config sets no baseURL');
  test.setTimeout(LIST_DELAY_MS + 60_000);
  const { page } = await open();
  const button = page.getByRole('button', { name: 'Previews of open pull requests' });
  const dialog = page.locator('#previews');
  const close = dialog.getByRole('button', { name: 'Close' });
  const note = dialog.locator('#previews-note');
  const list = dialog.locator('#previews-list');
  await button.click();
  await expect(dialog).toHaveAttribute('open');
  await expect(dialog.getByRole('heading', { name: 'Previews' })).toBeVisible();
  await expect(list).not.toContainText('Loading');

  // Other pull requests come and go, so the test checks only the preview under test.
  const number = previewNumberOf(baseURL);
  if (number !== undefined) {
    const here = list.locator('.preview.here');
    const hasError = () => note.evaluate((element) => element.classList.contains('error'));
    // Open the list again until this preview is in it, or until the server says that the list is empty or old.
    await expect(async () => {
      if ((await here.count()) === 1 || (await hasError())) return;
      await close.click();
      await button.click();
      await expect(list).not.toContainText('Loading');
      expect((await here.count()) === 1 || (await hasError())).toBe(true);
    }).toPass({ timeout: LIST_DELAY_MS + 15_000 });

    if ((await here.count()) === 0) {
      // GitHub (through production) did not answer, for example because the hourly limit of the VPS address is used up.
      // Then the list is empty or old, and this preview cannot be in it. The page must say so.
      // A list that loads without an error and lacks this preview still fails above.
      await expect(note).toBeVisible();
      await expect(note).not.toBeEmpty();
      test.info().annotations.push({ type: 'skip', description: `The previews list has an error, so the check of #${number} is skipped: ${await note.textContent()}` });
    } else {
      await expect(here).toContainText('You are here');
      // A title, then the number.
      await expect(here.locator('.preview-head b')).toHaveText(new RegExp(`\\S.* #${number}$`));
      await expect(here.getByRole('link', { name: 'Pull request' })).toHaveAttribute('href', new RegExp(`^https://github\\.com/.+/pull/${number}$`));
      await expect(here.getByRole('link', { name: 'Open preview' })).toHaveAttribute('href', new URL(baseURL).origin);
      // At least the author of the pull request, with a link to the profile.
      await expect(here.locator('.preview-people a').first()).toHaveAttribute('href', /^https:\/\/github\.com\/[\w-]+$/);
    }
  }

  await close.click();
  await expect(dialog).not.toHaveAttribute('open');
});
