// The feature graphic and the ads, from art.html and the play-phone shots of store.spec.ts.
// Every variant renders at every size to SHOTS_DIR/art/<variant>-<size>.png. convert.py picks the variant.
import { expect, test } from '@playwright/test';

const OUT = process.env.SHOTS_DIR ?? '';
if (OUT === '') throw new Error('Set SHOTS_DIR to the output folder');

const VARIANTS = ['sticker', 'dare', 'midnight'] as const;
// The Play feature graphic, then the ad sizes of the common feeds and link cards.
const SIZES = {
  feature: [1024, 500],
  square: [1080, 1080],
  portrait: [1080, 1350],
  story: [1080, 1920],
  link: [1200, 628],
} as const;
// The art.html parameter of each shot, and its scene.
const SHOTS = { tower: '1-tower', win: '2-win', online: '3-online' } as const;

for (const variant of VARIANTS) {
  for (const [size, [width, height]] of Object.entries(SIZES)) {
    test(`${variant} ${size}`, async ({ browser }) => {
      const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1 });
      const page = await context.newPage();
      const url = new URL('art.html', import.meta.url);
      url.searchParams.set('variant', variant);
      for (const [shot, scene] of Object.entries(SHOTS)) url.searchParams.set(shot, new URL(`file://${OUT}/play-phone/${scene}.png`).href);
      await page.goto(url.href);
      await page.evaluate(() => document.fonts.ready);
      for (const image of await page.locator('.phone:visible img').all()) {
        await expect(image).toHaveJSProperty('complete', true);
        expect(await image.evaluate((element: HTMLImageElement) => element.naturalWidth)).toBeGreaterThan(0);
      }
      await page.screenshot({ path: `${OUT}/art/${variant}-${size}.png` });
      await context.close();
    });
  }
}
