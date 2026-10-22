// Renders a tutorial (src/tutorial/): TUTORIAL picks basics (the default) or strong, TUTORIAL_PACE picks long (the
// default) or short. It writes its soundtrack, then <out>/tick3d-<name>-<crop>.mp4 (H.264, AAC) for both crops
// and one still per section in <out>/stills/. <name> is the name of the plan, for example tutorial-basics or
// tutorial-strong-short, and <out> is out/<name>/.
// It also writes <out>/chapters.json, the checkpoints, and one still per checkpoint at its frame in
// <out>/checkpoints/, so a check of each one sees the picture that the Info panel shows. After the landscape MP4
// it makes the web encode for the Info panel of the game, <out>/tick3d-<name>-<sha7>-web.mp4, and a poster from
// the title, <out>/tick3d-<name>-<sha7>-poster.jpg. The long basics tutorial then writes ../src/tutorial-chapters.json, the
// copy that the game reads. The game copies the web MP4 and the poster into public/tutorial/ itself.
//   --crop landscape|portrait   one crop only (CI renders one crop per job)
//   --stills                    the full stills only, no MP4
//   --draft                     half-size JPEG stills only, in <out>/draft/: the local check of an edit
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { FPS, frameOf } from '../src/grid.ts';
import { DURATION_SECONDS, NAME, PACE, SECTIONS, TUTORIAL, chaptersOf, stillOf } from '../src/tutorial/plan.ts';
import { tutorialSounds } from '../src/tutorial/soundtrack.ts';
import { mixdown } from './mixdown.ts';
import { cropsOf, path, render } from './remotion.ts';

const { values } = parseArgs({ options: { crop: { type: 'string' }, stills: { type: 'boolean' }, draft: { type: 'boolean' } } });
const draft = values.draft === true;
const stillsOnly = draft || values.stills === true;
const name = NAME;
const out = `../out/${name}/`;

// The web encode must load fast in the Info panel.
const WEB_LIMIT = 4 * 1024 * 1024;

const sounds = tutorialSounds();
const wav = await mixdown(sounds, DURATION_SECONDS);
mkdirSync(path(out), { recursive: true });
mkdirSync(path('../public/'), { recursive: true });
writeFileSync(path(`${out}soundtrack.wav`), wav);
writeFileSync(path(`../public/${name}.wav`), wav);
process.stdout.write(`${name} soundtrack: ${sounds.length} sounds, ${DURATION_SECONDS.toFixed(3)} s\n`);
const chapters = chaptersOf(TUTORIAL, PACE);
writeFileSync(path(`${out}chapters.json`), `${JSON.stringify(chapters, null, 2)}\n`);

const crops = cropsOf(values.crop);
const number = (i: number) => String(i + 1).padStart(2, '0');
const stills = draft ? `${out}draft/` : `${out}stills/`;
const checkpoints = `${out}checkpoints/`;
// The stills are named after the sections and the checkpoints, so stills of an older plan are removed first.
rmSync(path(stills), { recursive: true, force: true });
rmSync(path(checkpoints), { recursive: true, force: true });
const format = draft ? 'jpg' : 'png';
await render({
  name,
  crops,
  composition: (crop) => `tutorial-${crop}`,
  // One still per section, numbered in order, so a sheet of them reads as the plan. Then one per checkpoint.
  stills: (crop) => [
    ...SECTIONS.map((section, i) => ({ frame: stillOf(section), output: `${stills}${crop}-${number(i)}-${section.name}.${format}` })),
    ...SECTIONS.flatMap(({ chapter }) => (chapter === undefined ? [] : [chapter])).map((chapter, i) => ({ frame: frameOf(chapter.frame), output: `${checkpoints}${crop}-${number(i)}.${format}` })),
  ],
  draft,
  video: (crop) => (stillsOnly ? undefined : `${out}tick3d-${name}-${crop}.mp4`),
  envVariables: { TUTORIAL, TUTORIAL_PACE: PACE },
  inputProps: { tutorial: TUTORIAL, pace: PACE },
});

// The web encode and the poster need the landscape MP4 of this run.
if (!stillsOnly && crops.includes('landscape')) {
  const sha = execFileSync('git', ['rev-parse', '--short=7', 'HEAD'], { encoding: 'utf8' }).trim();
  const web = `tick3d-${name}-${sha}-web.mp4`;
  const poster = `tick3d-${name}-${sha}-poster.jpg`;
  const landscape = path(`${out}tick3d-${name}-landscape.mp4`);
  // The ffmpeg of Remotion, so the encode needs no system ffmpeg (CI has none). It has libx264, aac and mjpeg.
  const ffmpeg = (args: readonly string[]) => execFileSync('npx', ['--no-install', 'remotion', 'ffmpeg', '-v', 'error', '-y', ...args], { stdio: 'inherit' });
  ffmpeg(['-i', landscape, '-vf', 'scale=960:540', '-c:v', 'libx264', '-preset', 'slow', '-crf', '28', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '96k', '-movflags', '+faststart', path(`${out}${web}`)]);
  // The poster: the frame of the title checkpoint, from the home view with "How to win" on.
  const title = SECTIONS[0]?.chapter;
  if (title === undefined) throw new Error('the first section has no checkpoint');
  ffmpeg(['-ss', (frameOf(title.frame) / FPS).toFixed(3), '-i', landscape, '-frames:v', '1', '-vf', 'scale=960:-2', '-q:v', '4', path(`${out}${poster}`)]);
  const size = statSync(path(`${out}${web}`)).size;
  if (size > WEB_LIMIT) throw new Error(`${web} is ${(size / 1024 / 1024).toFixed(2)} MB, over the 4 MB limit`);
  process.stdout.write(`${name} web: ${web} (${(size / 1024 / 1024).toFixed(2)} MB), ${poster}\n`);
  if (TUTORIAL === 'basics' && PACE === 'long') writeFileSync(path('../../src/tutorial-chapters.json'), `${JSON.stringify({ video: web, poster, chapters }, null, 2)}\n`);
}
