import { getInputProps } from 'remotion';
import { Film } from '../Film.tsx';
import { PACE } from './plan.ts';
import { createTutorialWorld } from './world.ts';

// The render passes the pace twice: as TUTORIAL_PACE for the plan, and as an input prop for this check, so a
// render can never fall back to the long pace in silence.
function checkPace(): void {
  const props: unknown = getInputProps();
  const wanted = typeof props === 'object' && props !== null && 'pace' in props ? props.pace : 'long';
  if (wanted !== PACE) throw new Error(`the render asked for pace ${String(wanted)}, but the plan loaded ${PACE}`);
}

// The tutorial "How to win" over its soundtrack (scripts/tutorial.ts writes public/tutorial-<pace>.wav).
export const Tutorial = () => (
  <Film
    audio={`tutorial-${PACE}.wav`}
    create={(width, height, art) => {
      checkPace();
      return createTutorialWorld(width, height, art);
    }}
  />
);
