import { getInputProps } from 'remotion';
import { Film } from '../Film.tsx';
import { NAME, PACE, TUTORIAL } from './plan.ts';
import { createTutorialWorld } from './world.ts';

// The render passes the tutorial and the pace twice: as TUTORIAL and TUTORIAL_PACE for the plan, and as input
// props for this check, so a render can never fall back to the default in silence.
function checkPlan(): void {
  const props: unknown = getInputProps();
  const prop = (key: string, fallback: string): unknown => (typeof props === 'object' && props !== null && key in props ? (props as Record<string, unknown>)[key] : fallback);
  const tutorial = prop('tutorial', 'basics');
  const pace = prop('pace', 'long');
  if (tutorial !== TUTORIAL || pace !== PACE) throw new Error(`the render asked for ${String(tutorial)} at pace ${String(pace)}, but the plan loaded ${TUTORIAL} at ${PACE}`);
}

// A tutorial over its soundtrack (scripts/tutorial.ts writes public/<name>.wav).
export const Tutorial = () => (
  <Film
    audio={`${NAME}.wav`}
    create={(width, height, art) => {
      checkPlan();
      return createTutorialWorld(width, height, art);
    }}
  />
);
