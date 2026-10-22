// The popup of the achievements that unlocked away from an end card of this device: an invite on /share, a
// game on another device, or the unlocks from before the popup existed. It checks when the page opens and when
// it comes back to the front. It is no modal: the game stays playable under it, and Close or My games hide it.
import { badge, setupUnlockRow } from '../achievement-list.ts';
import { type AchievementId, achievementOf } from '../achievements.ts';
import { OnlineError, api } from '../online.ts';
import { sounds } from '../sound.ts';
import { loadSeen, markSeen, unseenUnlocks } from './achievement-seen.ts';
import { element } from './dom.ts';
import { showError } from './feedback.ts';
import { openMyGames } from './my-games.ts';
import { showMyGamesTab } from './my-games-layout.ts';
import { previewUnlocks } from './preview-unlocks.ts';

const popup = element('#achievement-popup', HTMLElement);
const title = element('#achievement-popup-title', HTMLHeadingElement);
const list = element('#achievement-popup-list', HTMLUListElement);
const more = element('#achievement-popup-more', HTMLButtonElement);

// The unlocks in the popup now, newest first, in a row that scrolls sideways: the first check of a device can
// find dozens. A check while it shows adds its unlocks at the top.
let shown: AchievementId[] = [];
let checking = false;

function item(id: AchievementId, index: number): HTMLLIElement {
  const { name, description, tier } = achievementOf(id);
  const entry = document.createElement('li');
  entry.className = 'achievement-popup-item';
  entry.dataset.tier = tier;
  entry.style.setProperty('--i', String(index));
  const text = document.createElement('div');
  text.className = 'unlock-text';
  const label = document.createElement('b');
  label.textContent = name;
  const detail = document.createElement('span');
  detail.textContent = description;
  text.append(label, detail);
  entry.append(badge('span', id), text);
  return entry;
}

function show(fresh: readonly AchievementId[]): void {
  shown = [...fresh, ...shown.filter((id) => !fresh.includes(id))];
  title.textContent = shown.length === 1 ? 'Achievement unlocked' : `${shown.length} achievements unlocked`;
  list.replaceChildren(...shown.map(item));
  list.scrollTo({ left: 0 });
  popup.hidden = false;
  // A new list plays the entrance again (.achievement-popup in src/style.css).
  popup.classList.remove('pop');
  void popup.offsetWidth;
  popup.classList.add('pop');
  sounds.achievement();
}

function hide(): void {
  popup.hidden = true;
  shown = [];
}

// Asks the server for the achievements of this player, and shows the unlocks that this device did not show yet.
// Only an answer of the server counts: without it, the device knows no invite and no game of another device.
export async function checkUnlocks(): Promise<void> {
  if (checking || !navigator.onLine) return;
  checking = true;
  try {
    const { achievements } = await api.achievements();
    const fresh = unseenUnlocks(achievements, loadSeen()).map((entry) => entry.id);
    markSeen(achievements.filter((entry) => entry.unlockedAt !== null).map((entry) => entry.id));
    if (fresh.length > 0) show(fresh);
  } catch (error) {
    if (!(error instanceof OnlineError)) throw error;
  } finally {
    checking = false;
  }
}

export function setupAchievementPopup(): void {
  setupUnlockRow(list);
  const preview = previewUnlocks();
  if (preview !== undefined) show(preview);
  element('#achievement-popup-close', HTMLButtonElement).addEventListener('click', hide);
  more.addEventListener('click', () => {
    hide();
    showMyGamesTab('Achievements');
    void openMyGames().catch(showError);
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void checkUnlocks();
  });
}
