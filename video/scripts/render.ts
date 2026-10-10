// Renders the spot. Without options: out/tick3d-15s-<crop>.mp4 (H.264, AAC) for both crops, and a still of
// the middle of each bar in out/stills/. Run scripts/audio.ts first (`npm run video` does both).
//   --crop landscape|portrait   one crop only (CI renders one crop per job)
//   --stills                    the full stills only, no MP4
//   --draft                     half-size JPEG stills only, in out/draft/: the local check of an edit
//   --bars 2,5                  only these bars of the stills
import { parseArgs } from 'node:util';
import { SIXTEENTHS_PER_BAR } from '../creative/beats.ts';
import { BEATS, VARIANT, frameOf } from '../src/timeline.ts';
import { cropsOf, render } from './remotion.ts';

const { values } = parseArgs({ options: { crop: { type: 'string' }, stills: { type: 'boolean' }, draft: { type: 'boolean' }, bars: { type: 'string' } } });
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
const out = VARIANT === 'spot' ? '../out/' : `../out/variants/${VARIANT}/`;
const stills = draft ? `${out}draft/` : `${out}stills/`;
await render({
  name: VARIANT,
  crops: cropsOf(values.crop),
  composition: (crop) => crop,
  stills: (crop) => bars.map((bar) => ({ frame: frameOf(bar.start + SIXTEENTHS_PER_BAR / 2), output: `${stills}${crop}-bar-${bar.bar}.${draft ? 'jpg' : 'png'}` })),
  draft,
  video: (crop) => (stillsOnly ? undefined : `${out}tick3d-15s-${crop}.mp4`),
  envVariables: { VIDEO_VARIANT: VARIANT },
  inputProps: { variant: VARIANT },
});
