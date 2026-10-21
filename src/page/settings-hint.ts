// In one column the settings cards sit under the board, and on a phone the tower fills the screen.
// A gear at the side of the screen shows that the settings exist and scrolls to them.
// It hides while the game actions or either card (the settings card, More) is in view, so it never covers
// New game, Undo or the speaker. src/style.css shows it in one column only.
import { element, scrollMotion } from './dom.ts';

const hint = element('#settings-hint', HTMLButtonElement);
const settingsCard = element('.panel', HTMLElement);
const moreCard = element('#more', HTMLDetailsElement);
const gameActions = element('.game-actions', HTMLDivElement);

export function setupSettingsHint(): void {
  const inView = new Map<Element, boolean>();
  // The entries come oldest first, so a later entry of the same card wins.
  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) inView.set(entry.target, entry.isIntersecting);
    hint.hidden = [...inView.values()].some(Boolean);
  });
  observer.observe(settingsCard);
  observer.observe(moreCard);
  observer.observe(gameActions);
  hint.addEventListener('click', () => settingsCard.scrollIntoView({ behavior: scrollMotion(), block: 'start' }));
}
