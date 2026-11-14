// Renders the smart-memory ad (src/memory/, issue #130) in the cut of MEMORY_PLAN (full by default, or short):
// its soundtrack, then out/smart-memory[-short]-<format>.mp4 (H.264, AAC) for each format, and the stills of the
// cut in out/smart-memory[-short]/stills/. The 'threat' still is the cover image of a format.
//   --format 4x5|1x1|9x16   one format only (CI renders one format per job)
//   --stills                the full stills only, no MP4
//   --draft                 half-size JPEG stills only, in out/smart-memory[-short]/draft/
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { FORMAT_IDS, isFormat } from '../src/memory/formats.ts';
import { PLAN, stillsOf } from '../src/memory/plan.ts';
import { memorySounds } from '../src/memory/soundtrack.ts';
import { mixdown } from './mixdown.ts';
import { path, render } from './remotion.ts';

const { values } = parseArgs({ options: { format: { type: 'string' }, stills: { type: 'boolean' }, draft: { type: 'boolean' } } });
const draft = values.draft === true;
const stillsOnly = draft || values.stills === true;
const format = values.format;
if (format !== undefined && !isFormat(format)) throw new Error(`--format ${format}: use ${FORMAT_IDS.join(', ')}`);
const name = PLAN.id === 'full' ? 'smart-memory' : `smart-memory-${PLAN.id}`;
const out = `../out/${name}/`;

const sounds = memorySounds();
const wav = await mixdown(sounds, PLAN.seconds);
mkdirSync(path(out), { recursive: true });
mkdirSync(path('../public/'), { recursive: true });
writeFileSync(path(`${out}soundtrack.wav`), wav);
writeFileSync(path(`../public/memory-${PLAN.id}.wav`), wav);
process.stdout.write(`${name} soundtrack: ${sounds.length} sounds, ${PLAN.seconds.toFixed(3)} s\n`);

const stills = draft ? `${out}draft/` : `${out}stills/`;
rmSync(path(stills), { recursive: true, force: true });
await render({
  name,
  crops: format === undefined ? FORMAT_IDS : [format],
  composition: (crop) => `memory-${crop}`,
  stills: (crop) => stillsOf().map((still, i) => ({ frame: still.frame, output: `${stills}${crop}-${i + 1}-${still.name}.${draft ? 'jpg' : 'png'}` })),
  draft,
  video: (crop) => (stillsOnly ? undefined : `../out/${name}-${crop}.mp4`),
  envVariables: { MEMORY_PLAN: PLAN.id },
  inputProps: { plan: PLAN.id },
});
