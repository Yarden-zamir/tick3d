import { getInputProps } from 'remotion';
import { Film } from './Film.tsx';
import { VARIANT } from './timeline.ts';
import { createWorld } from './world.ts';

// The render passes the variant twice: as VIDEO_VARIANT for the timeline, and as an input prop for this check, so
// a render can never fall back to the base cut in silence.
function checkVariant(): void {
  const props: unknown = getInputProps();
  const wanted = typeof props === 'object' && props !== null && 'variant' in props ? props.variant : 'spot';
  if (wanted !== VARIANT) throw new Error(`the render asked for variant ${String(wanted)}, but the timeline loaded ${VARIANT}`);
}

export const Spot = () => (
  <Film
    audio="soundtrack.wav"
    create={(width, height, art) => {
      checkVariant();
      return createWorld(width, height, art);
    }}
  />
);
