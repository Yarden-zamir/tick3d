// The feature graphic and the ads, from art.html and the play-phone tower shot of store.spec.ts.
// Every size renders to SHOTS_DIR/art/<size>.png.
import { expect, type Page, test } from '@playwright/test';

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

// The desktop Play store crops and zooms the feature graphic. Google names no exact safe area, only "keep key
// elements out of the cutoff zones" (https://support.google.com/googleplay/android-developer/answer/9866151,
// checked 2026-11-08). So the logo, the tagline and the phone stay inside the centered 70% × 80%.
const SAFE_SHARE = { width: 0.7, height: 0.8 } as const;

async function expectInsideSafeArea(page: Page, width: number, height: number): Promise<void> {
  const left = (width * (1 - SAFE_SHARE.width)) / 2;
  const top = (height * (1 - SAFE_SHARE.height)) / 2;
  // The tilted sticker can reach out of its heading, so it gets its own check.
  for (const selector of ['.mark', '.mark span', 'p', '.phone']) {
    const box = await page.locator(selector).boundingBox();
    if (box === null) throw new Error(`${selector} is not on the feature graphic`);
    expect(box.x, `${selector} left`).toBeGreaterThanOrEqual(left);
    expect(box.y, `${selector} top`).toBeGreaterThanOrEqual(top);
    expect(box.x + box.width, `${selector} right`).toBeLessThanOrEqual(width - left);
    expect(box.y + box.height, `${selector} bottom`).toBeLessThanOrEqual(height - top);
  }
}

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
    if (size === 'feature') await expectInsideSafeArea(page, width, height);
    await page.screenshot({ path: `${OUT}/art/${size}.png` });
    await context.close();
  });
}
