import { Composition } from 'remotion';
import { Spot } from './Spot.tsx';
import { DURATION_FRAMES, FPS } from './timeline.ts';
import { Tutorial } from './tutorial/Tutorial.tsx';
import { DURATION_FRAMES as TUTORIAL_FRAMES } from './tutorial/plan.ts';

// The two crops of each video. Everything important stays in the centre 1080 × 1080 square of both.
const COMPOSITIONS = { landscape: { width: 1920, height: 1080 }, portrait: { width: 1080, height: 1920 } } as const;

export const Root = () => (
  <>
    {Object.entries(COMPOSITIONS).map(([id, size]) => (
      <Composition key={id} id={id} component={Spot} fps={FPS} durationInFrames={DURATION_FRAMES} {...size} />
    ))}
    {Object.entries(COMPOSITIONS).map(([id, size]) => (
      <Composition key={`tutorial-${id}`} id={`tutorial-${id}`} component={Tutorial} fps={FPS} durationInFrames={TUTORIAL_FRAMES} {...size} />
    ))}
  </>
);
