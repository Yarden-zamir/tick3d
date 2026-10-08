// The one sound rule for controls on every page (README, Features). A press plays the click at once, on
// the click event, so a key press counts too. A control whose handler plays an own sound (a move, a
// refusal, a sample) plays only that sound. A control with data-own-sound (a board cell, a song) never
// clicks. A disabled control gets no click event, so it plays nothing. The mute of the game holds.
import { settings } from './page/settings.ts';
import { soundRequestCount, sounds } from './sound.ts';

const CONTROLS = 'button, summary, input[type="checkbox"], input[type="radio"], .home-link';

export function setupClickSound(): void {
  let requestsBefore = 0;
  // The capture runs before the handlers of the control, and the bubble after them.
  addEventListener('click', () => (requestsBefore = soundRequestCount()), { capture: true });
  addEventListener('click', (event) => {
    if (!(event.target instanceof Element) || settings.muted) return;
    const control = event.target.closest(CONTROLS);
    if (control === null || control.closest('[data-own-sound]') !== null) return;
    if (soundRequestCount() === requestsBefore) sounds.click();
  });
}
