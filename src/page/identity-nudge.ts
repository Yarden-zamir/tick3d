// The prompt for a name or a login: once per device, after two wins in a row against any opponent, for a player
// with no login and no name of their own. A name of their own ties the player to their stats and achievements.
// It opens when an end card closes, after the move up to medium (src/page/level-up.ts), so the two never show
// together. It is no modal, like the achievement popup, and it waits while that popup shows.
import { avatarFor } from '../avatar.ts';
import { STORAGE_KEYS } from '../storage-keys.ts';
import { element } from './dom.ts';
import { showError } from './feedback.ts';
import { winsInARow } from './level-up.ts';
import { openMyGames } from './my-games.ts';
import { showMyGamesTab } from './my-games-layout.ts';
import { ownName, page } from './state.ts';

const WINS_TO_ASK = 2;
// 2.5rem in src/style.css, sharp on a screen with two device pixels per CSS pixel.
const AVATAR_PIXELS = 80;

const nudge = element('#identity-nudge', HTMLElement);
const avatarSlot = element('#identity-nudge-avatar', HTMLSpanElement);
const text = element('#identity-nudge-text', HTMLElement);
const achievementPopup = element('#achievement-popup', HTMLElement);

function wasShown(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEYS.identityNudge) !== null;
  } catch {
    // Without storage the prompt cannot remember that it showed, so it never shows.
    return true;
  }
}

function markShown(): void {
  try {
    localStorage.setItem(STORAGE_KEYS.identityNudge, 'shown');
  } catch {
    // wasShown already returns true without storage.
  }
}

// A login or a name of their own. `person` comes with each answer of the server, so null means that a rename
// cannot reach the server now. The prompt then waits for the next two wins in a row.
const canAsk = () => page.account.person !== null && navigator.onLine && page.account.user === null && page.account.name === null;

// An end card closed, and the move up (if any) is over.
export function runIdentityNudge(): void {
  if (winsInARow() < WINS_TO_ASK || !canAsk() || !achievementPopup.hidden || !nudge.hidden || wasShown()) return;
  markShown();
  const name = ownName();
  const bold = document.createElement('b');
  bold.textContent = name;
  text.replaceChildren('Your wins and achievements sit under ', bold, ', a name we picked. Choose your own, or log in.');
  avatarSlot.replaceChildren(avatarFor({ player: null, name }, AVATAR_PIXELS, null));
  nudge.hidden = false;
  // The same entrance as the achievement popup (.achievement-popup.pop in src/style.css).
  nudge.classList.remove('pop');
  void nudge.offsetWidth;
  nudge.classList.add('pop');
}

export function setupIdentityNudge(): void {
  element('#identity-nudge-close', HTMLButtonElement).addEventListener('click', () => {
    nudge.hidden = true;
  });
  // The Account tab holds Rename and the login choices.
  element('#identity-nudge-pick', HTMLButtonElement).addEventListener('click', () => {
    nudge.hidden = true;
    showMyGamesTab('Account');
    void openMyGames().catch(showError);
  });
}
