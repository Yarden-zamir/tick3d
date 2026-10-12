// Puts each store shot of a target with caption: true under its scene caption (caption.html), at the
// target's exact size. Every style renders to SHOTS_DIR/captioned-<style>/<target>/<scene>.png.
import { test } from '@playwright/test';
import { SCENES, TARGETS } from './targets.ts';

const OUT = process.env.SHOTS_DIR ?? '';
if (OUT === '') throw new Error('Set SHOTS_DIR to the output folder');

const STYLES = ['sticker', 'yellow'] as const;

for (const { name: target, size: [width, height], scale } of TARGETS.filter((target) => target.caption)) {
  for (const scene of SCENES) {
    test(`${target} ${scene.name}`, async ({ browser }) => {
      const context = await browser.newContext({ viewport: { width: width / scale, height: height / scale }, deviceScaleFactor: scale });
      const page = await context.newPage();
      for (const style of STYLES) {
        const url = new URL('caption.html', import.meta.url);
        url.searchParams.set('shot', new URL(`file://${OUT}/${target}/${scene.name}.png`).href);
        url.searchParams.set('caption', scene.caption);
        url.searchParams.set('style', style);
        await page.goto(url.href);
        await page.evaluate(() => document.fonts.ready);
        await page.waitForFunction(() => document.body.style.getPropertyValue('--shot-ratio') !== '');
        await page.screenshot({ path: `${OUT}/captioned-${style}/${target}/${scene.name}.png` });
      }
      await context.close();
    });
  }
}
