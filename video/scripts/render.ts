// Renders the spot. Without options: out/tick3d-15s-<crop>.mp4 (H.264, AAC) for both crops, and a still of
// the middle of each bar in out/stills/. Run scripts/audio.ts first (`npm run video` does both).
//   --crop landscape|portrait   one crop only (CI renders one crop per job)
//   --stills                    the full stills only, no MP4
//   --draft                     half-size JPEG stills only, in out/draft/: the local check of an edit
//   --bars 2,5                  only these bars of the stills
import { mkdirSync } from 'node:fs';
import { availableParallelism, platform } from 'node:os';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { bundle } from '@remotion/bundler';
import { type ChromiumOptions, openBrowser, renderMedia, renderStill, selectComposition } from '@remotion/renderer';
import { SIXTEENTHS_PER_BAR } from '../creative/beats.ts';
import { BEATS, VARIANT, frameOf } from '../src/timeline.ts';

const path = (relative: string) => fileURLToPath(new URL(relative, import.meta.url));
// WebGL in headless Chrome: ANGLE on the GPU on macOS, ANGLE on SwiftShader (CPU) on Linux without a GPU (CI).
// A Linux host with a GPU also gets SwiftShader. Revisit if such a host renders the video.
const chromiumOptions: ChromiumOptions = { gl: platform() === 'darwin' ? 'angle' : 'swangle' };
// Browser tabs: one per core. A CI runner has 4.
const CONCURRENCY = availableParallelism();

const CROPS = ['landscape', 'portrait'] as const;
type Crop = (typeof CROPS)[number];
const isCrop = (value: string): value is Crop => (CROPS as readonly string[]).includes(value);

const { values } = parseArgs({ options: { crop: { type: 'string' }, stills: { type: 'boolean' }, draft: { type: 'boolean' }, bars: { type: 'string' } } });
if (values.crop !== undefined && !isCrop(values.crop)) throw new Error(`--crop ${values.crop}: use ${CROPS.join(' or ')}`);
const crops: readonly Crop[] = values.crop === undefined || !isCrop(values.crop) ? CROPS : [values.crop];
const bars =
  values.bars === undefined
    ? BEATS.bars
    : values.bars.split(',').map((number) => {
        const bar = BEATS.bars.find((entry) => entry.bar === Number(number));
        if (bar === undefined) throw new RangeError(`--bars ${number}: no such bar`);
        return bar;
      });
const draft = values.draft === true;
const stillsOnly = draft || values.stills === true;

// The base cut renders into out/, a variant into out/variants/<name>/. The variant goes to the render browser as
// VIDEO_VARIANT (the timeline reads it) and as an input prop (Spot.tsx checks that both agree).
const out = VARIANT === 'classic' ? '../out/' : `../out/variants/${VARIANT}/`;
const stills = draft ? `${out}draft/` : `${out}stills/`;
const envVariables = { VIDEO_VARIANT: VARIANT };
const inputProps = { variant: VARIANT };
mkdirSync(path(stills), { recursive: true });
const serveUrl = await bundle({ entryPoint: path('../src/index.ts'), publicDir: path('../public') });
// One browser for the whole run: without it, every still starts its own browser.
const puppeteerInstance = await openBrowser('chrome', { chromiumOptions });
for (const id of crops) {
  const composition = await selectComposition({ serveUrl, id, chromiumOptions, envVariables, inputProps, puppeteerInstance });
  // The stills of a crop render in parallel, one browser tab each, at most CONCURRENCY at a time: more tabs than
  // cores make a page miss the render timeout of Remotion.
  const format = draft ? { imageFormat: 'jpeg' as const, jpegQuality: 80, scale: 0.5 } : {};
  for (let i = 0; i < bars.length; i += CONCURRENCY) {
    await Promise.all(
      bars.slice(i, i + CONCURRENCY).map((bar) => {
        const frame = frameOf(bar.start + SIXTEENTHS_PER_BAR / 2);
        const output = path(`${stills}${id}-bar-${bar.bar}.${draft ? 'jpg' : 'png'}`);
        return renderStill({ composition, serveUrl, frame, output, chromiumOptions, envVariables, inputProps, puppeteerInstance, ...format });
      }),
    );
  }
  process.stdout.write(`${VARIANT} ${id}: ${bars.length} ${draft ? 'draft ' : ''}stills done\n`);
  if (stillsOnly) continue;
  await renderMedia({
    composition,
    serveUrl,
    codec: 'h264',
    audioCodec: 'aac',
    outputLocation: path(`${out}tick3d-15s-${id}.mp4`),
    concurrency: CONCURRENCY,
    chromiumOptions,
    envVariables,
    inputProps,
    puppeteerInstance,
    onProgress: ({ progress }) => {
      if (Math.round(progress * 100) % 10 === 0) process.stdout.write(`${id}: ${Math.round(progress * 100)} %\r`);
    },
  });
  process.stdout.write(`${VARIANT} ${id}: video done\n`);
}
await puppeteerInstance.close({ silent: false });
