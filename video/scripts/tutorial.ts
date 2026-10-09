// Renders the tutorial "How to win" (src/tutorial/): its soundtrack, then out/tutorial/tick3d-tutorial-<crop>.mp4
// (H.264, AAC) for both crops and one still per section in out/tutorial/stills/.
//   --crop landscape|portrait   one crop only (CI renders one crop per job)
//   --stills                    the full stills only, no MP4
//   --draft                     half-size JPEG stills only, in out/tutorial/draft/: the local check of an edit
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { DURATION_SECONDS, SECTIONS, stillOf } from '../src/tutorial/plan.ts';
import { tutorialSounds } from '../src/tutorial/soundtrack.ts';
import { mixdown } from './mixdown.ts';
import { cropsOf, path, render } from './remotion.ts';

const { values } = parseArgs({ options: { crop: { type: 'string' }, stills: { type: 'boolean' }, draft: { type: 'boolean' } } });
const draft = values.draft === true;
const stillsOnly = draft || values.stills === true;
const out = '../out/tutorial/';

const sounds = tutorialSounds();
const wav = await mixdown(sounds, DURATION_SECONDS);
mkdirSync(path(out), { recursive: true });
mkdirSync(path('../public/'), { recursive: true });
writeFileSync(path(`${out}soundtrack.wav`), wav);
writeFileSync(path('../public/tutorial.wav'), wav);
process.stdout.write(`tutorial soundtrack: ${sounds.length} sounds, ${DURATION_SECONDS.toFixed(3)} s\n`);

const stills = draft ? `${out}draft/` : `${out}stills/`;
// The stills are named after the sections, so stills of an older plan are removed first.
rmSync(path(stills), { recursive: true, force: true });
await render({
  name: 'tutorial',
  crops: cropsOf(values.crop),
  composition: (crop) => `tutorial-${crop}`,
  // One still per section, numbered in order, so a sheet of them reads as the plan.
  stills: (crop) => SECTIONS.map((section, i) => ({ frame: stillOf(section), output: `${stills}${crop}-${String(i + 1).padStart(2, '0')}-${section.name}.${draft ? 'jpg' : 'png'}` })),
  draft,
  video: (crop) => (stillsOnly ? undefined : `${out}tick3d-tutorial-${crop}.mp4`),
});
