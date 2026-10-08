// Renders the spot: out/tick3d-15s-<crop>.mp4 (H.264, AAC) for both crops, and a still of the middle of each
// bar in out/stills/. Run scripts/audio.ts first (`npm run video` does both).
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { bundle } from '@remotion/bundler';
import { type ChromiumOptions, renderMedia, renderStill, selectComposition } from '@remotion/renderer';
import { SIXTEENTHS_PER_BAR } from '../creative/beats.ts';
import { BEATS, frameOf } from '../src/timeline.ts';

const path = (relative: string) => fileURLToPath(new URL(relative, import.meta.url));
// WebGL in headless Chrome on a machine without a GPU: ANGLE on SwiftShader.
const chromiumOptions: ChromiumOptions = { gl: 'swangle' };
// Two browser tabs: the host also serves production.
const CONCURRENCY = 2;

mkdirSync(path('../out/stills'), { recursive: true });
const serveUrl = await bundle({ entryPoint: path('../src/index.ts'), publicDir: path('../public') });
for (const id of ['landscape', 'portrait'] as const) {
  const composition = await selectComposition({ serveUrl, id, chromiumOptions });
  for (const bar of BEATS.bars) {
    const frame = frameOf(bar.start + SIXTEENTHS_PER_BAR / 2);
    await renderStill({ composition, serveUrl, frame, output: path(`../out/stills/${id}-bar-${bar.bar}.png`), chromiumOptions });
  }
  process.stdout.write(`${id}: stills done\n`);
  if (process.argv.includes('--stills')) continue;
  await renderMedia({
    composition,
    serveUrl,
    codec: 'h264',
    audioCodec: 'aac',
    outputLocation: path(`../out/tick3d-15s-${id}.mp4`),
    concurrency: CONCURRENCY,
    chromiumOptions,
    onProgress: ({ progress }) => {
      if (Math.round(progress * 100) % 10 === 0) process.stdout.write(`${id}: ${Math.round(progress * 100)} %\r`);
    },
  });
  process.stdout.write(`${id}: video done\n`);
}
