// The render loop of every video: one bundle and one browser for the run, then for each crop the stills (one
// browser tab each) and the MP4 (H.264, AAC).
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { availableParallelism, platform } from 'node:os';
import { fileURLToPath } from 'node:url';
import { bundle } from '@remotion/bundler';
import { type ChromiumOptions, openBrowser, renderMedia, renderStill, selectComposition } from '@remotion/renderer';

// A path relative to video/scripts/.
export const path = (relative: string) => fileURLToPath(new URL(relative, import.meta.url));
// WebGL in headless Chrome: ANGLE on the GPU on macOS, ANGLE on SwiftShader (CPU) on Linux without a GPU (CI).
// A Linux host with a GPU also gets SwiftShader. Revisit if such a host renders the video.
const chromiumOptions: ChromiumOptions = { gl: platform() === 'darwin' ? 'angle' : 'swangle' };
// Browser tabs: one per core. A CI runner has 4.
const CONCURRENCY = availableParallelism();

const CROPS = ['landscape', 'portrait'] as const;
export type Crop = (typeof CROPS)[number];
const isCrop = (value: string): value is Crop => (CROPS as readonly string[]).includes(value);

// The crops of a --crop option: both without it.
export function cropsOf(option: string | undefined): readonly Crop[] {
  if (option === undefined) return CROPS;
  if (!isCrop(option)) throw new Error(`--crop ${option}: use ${CROPS.join(' or ')}`);
  return [option];
}

type Render = {
  // For the log: the name of the cut.
  name: string;
  crops: readonly Crop[];
  composition: (crop: Crop) => string;
  // The stills of a crop: the frame and the output path of each (relative to video/scripts/).
  stills: (crop: Crop) => readonly { frame: number; output: string }[];
  // Half-size JPEG stills.
  draft: boolean;
  // The output path of the MP4 of a crop, or undefined for the stills only.
  video: (crop: Crop) => string | undefined;
  envVariables?: Record<string, string>;
  inputProps?: Record<string, unknown>;
};

export async function render({ name, crops, composition: idOf, stills, draft, video, envVariables = {}, inputProps = {} }: Render): Promise<void> {
  const serveUrl = await bundle({ entryPoint: path('../src/index.ts'), publicDir: path('../public') });
  // One browser for the whole run: without it, every still starts its own browser.
  const puppeteerInstance = await openBrowser('chrome', { chromiumOptions });
  for (const crop of crops) {
    const id = idOf(crop);
    const composition = await selectComposition({ serveUrl, id, chromiumOptions, envVariables, inputProps, puppeteerInstance });
    // The stills of a crop render in parallel, one browser tab each, at most CONCURRENCY at a time: more tabs than
    // cores make a page miss the render timeout of Remotion.
    const format = draft ? { imageFormat: 'jpeg' as const, jpegQuality: 80, scale: 0.5 } : {};
    const shots = stills(crop);
    for (let i = 0; i < shots.length; i += CONCURRENCY) {
      await Promise.all(
        shots.slice(i, i + CONCURRENCY).map(({ frame, output }) => {
          mkdirSync(dirname(path(output)), { recursive: true });
          return renderStill({ composition, serveUrl, frame, output: path(output), chromiumOptions, envVariables, inputProps, puppeteerInstance, ...format });
        }),
      );
    }
    process.stdout.write(`${name} ${crop}: ${shots.length} ${draft ? 'draft ' : ''}stills done\n`);
    const output = video(crop);
    if (output === undefined) continue;
    mkdirSync(dirname(path(output)), { recursive: true });
    await renderMedia({
      composition,
      serveUrl,
      codec: 'h264',
      audioCodec: 'aac',
      outputLocation: path(output),
      concurrency: CONCURRENCY,
      chromiumOptions,
      envVariables,
      inputProps,
      puppeteerInstance,
      onProgress: ({ progress }) => {
        if (Math.round(progress * 100) % 10 === 0) process.stdout.write(`${crop}: ${Math.round(progress * 100)} %\r`);
      },
    });
    process.stdout.write(`${name} ${crop}: video done\n`);
  }
  await puppeteerInstance.close({ silent: false });
}
