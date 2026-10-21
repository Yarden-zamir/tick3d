import { getInputProps } from 'remotion';
import { Film } from '../Film.tsx';
import { PLAN } from './plan.ts';
import { createMemoryWorld } from './world.ts';

// The render passes the plan twice: as MEMORY_PLAN for plan.ts, and as an input prop for this check, so a render
// can never fall back to the default plan in silence.
function checkPlan(): void {
  const props: unknown = getInputProps();
  const wanted = typeof props === 'object' && props !== null && 'plan' in props ? props.plan : 'a-full';
  if (wanted !== PLAN.id) throw new Error(`the render asked for plan ${String(wanted)}, but plan.ts loaded ${PLAN.id}`);
}

// The smart-memory ad over its soundtrack (scripts/memory.ts writes public/memory-<plan>.wav).
export const Ad = () => (
  <Film
    audio={`memory-${PLAN.id}.wav`}
    create={(width, height, art) => {
      checkPlan();
      return createMemoryWorld(width, height, art);
    }}
  />
);
