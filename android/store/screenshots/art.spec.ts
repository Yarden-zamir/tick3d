// The feature graphic and the ads, from art.html and the play-phone tower shot of store.spec.ts.
// Every size renders to SHOTS_DIR/art/<size>.png.
import { expect, test } from '@playwright/test';

const OUT = process.env.SHOTS_DIR ?? '';
if (OUT === '') throw new Error('Set SHOTS_DIR to the output folder');

// The Play feature graphic, then the ad sizes of the common feeds and link cards.
const SIZES = {
  feature: [1024, 500],
  square: [1080, 1080],
  portrait: [1080, 1350],
  story: [1080, 1920],
  link: [1200, 628],
} as const;

for (const [size, [width, height]] of Object.entries(SIZES)) {
  test(size, async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1 });
    const page = await context.newPage();
    const url = new URL('art.html', import.meta.url);
    url.searchParams.set('tower', new URL(`file://${OUT}/play-phone/1-tower.png`).href);
    await page.goto(url.href);
    await page.evaluate(() => document.fonts.ready);
    const tower = page.locator('#tower');
    await expect(tower).toHaveJSProperty('complete', true);
    expect(await tower.evaluate((element: HTMLImageElement) => element.naturalWidth)).toBeGreaterThan(0);
    await page.screenshot({ path: `${OUT}/art/${size}.png` });
    await context.close();
  });
}
