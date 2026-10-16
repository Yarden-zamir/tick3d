// In one column the settings cards sit under the board, and on a phone the tower fills the screen.
// A gear at the side of the screen shows that the settings exist and scrolls to them.
// It hides while the settings card is in view. src/style.css shows it in one column only.
import { element } from './dom.ts';

const hint = element('#settings-hint', HTMLButtonElement);
const settingsCard = element('.panel', HTMLElement);

export function setupSettingsHint(): void {
  new IntersectionObserver(([entry]) => {
    if (entry === undefined) throw new Error('the settings hint observes no element');
    hint.hidden = entry.isIntersecting;
  }).observe(settingsCard);
  hint.addEventListener('click', () => settingsCard.scrollIntoView({ behavior: 'smooth', block: 'start' }));
}
