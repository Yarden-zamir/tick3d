import { Film } from '../Film.tsx';
import { createTutorialWorld } from './world.ts';

// The tutorial "How to win" over its soundtrack (scripts/tutorial.ts writes public/tutorial.wav).
export const Tutorial = () => <Film audio="tutorial.wav" create={createTutorialWorld} />;
