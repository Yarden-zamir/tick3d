import { getInputProps } from 'remotion';
import { Film } from '../Film.tsx';
import { PLAN } from './plan.ts';
import { createMemoryWorld } from './world.ts';

// The render passes the cut twice: as MEMORY_CUT for the plan, and as an input prop for this check, so a render
// can never fall back to the full cut in silence.
function checkCut(): void {
  const props: unknown = getInputProps();
  const wanted = typeof props === 'object' && props !== null && 'cut' in props ? props.cut : 'full';
  if (wanted !== PLAN.cut) throw new Error(`the render asked for cut ${String(wanted)}, but the plan loaded ${PLAN.cut}`);
}

// The smart-memory ad over its soundtrack (scripts/memory.ts writes public/memory-<cut>.wav).
export const Ad = () => (
  <Film
    audio={`memory-${PLAN.cut}.wav`}
    create={(width, height, art) => {
      checkCut();
      return createMemoryWorld(width, height, art);
    }}
  />
);
