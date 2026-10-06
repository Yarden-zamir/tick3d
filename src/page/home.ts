// The home link, which goes back to an empty board against the computer.
import { sounds } from '../sound.ts';
import { scheduleComputer } from './computer.ts';
import {
  cardDialog,
  myGamesDialog,
  homeConfirm,
  seatPrompt,
  burstEl,
  homeConfirmText,
  homeConfirmStay,
  homeConfirmLeave,
} from './dom.ts';
import { showError } from './feedback.ts';
import { homeLink } from '../header/header.ts';
import { previewsDialog } from '../header/previews.ts';
import { nearbyKind, endNearby } from './nearby.ts';
import { render } from './render.ts';
import { leaveSession, openLocalSession, applyView } from './sessions.ts';
import { settings, saveSettings } from './settings.ts';
import { page, isLive, current } from './state.ts';

// What a player loses when they go home now, or undefined when there is nothing to lose.
function homeWarning(): string | undefined {
  if (nearbyKind() === 'hosting') return 'End the Nearby game for everyone?';
  if (nearbyKind() !== 'idle') return 'Leave the Nearby game?';
  if (page.session?.mode === 'online') return 'Leave this online game? You can open it again from My games.';
  if (page.session !== undefined && isLive() && current().moves.length > 0) return 'Leave this game? The game in progress ends.';
  return undefined;
}

// Home is the first visit: an empty board against the computer, with no game code in the address.
// The theme, the view and the other settings stay.
async function goHome(): Promise<void> {
  for (const dialog of [cardDialog, myGamesDialog, previewsDialog, homeConfirm, seatPrompt]) if (dialog.open) dialog.close();
  if (nearbyKind() !== 'idle') endNearby();
  leaveSession();
  history.replaceState(null, '', location.pathname);
  page.review = undefined;
  settings.mode = 'computer';
  saveSettings();
  render();
  await openLocalSession('computer');
  const opened = page.session;
  if (opened === undefined || current().moves.length === 0) return;
  // The newest computer session holds a game with moves: a new game gives the empty board.
  page.round++;
  page.computerThinkMs = [];
  page.thinking = false;
  burstEl.replaceChildren();
  applyView(await opened.backend.newGame(opened.code));
  scheduleComputer();
}

export function setupHome(): void {
  homeLink.addEventListener('click', (event) => {
    // A modified click opens a new tab, as for any link.
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    sounds.click();
    const warning = homeWarning();
    if (warning === undefined) return void goHome().catch(showError);
    homeConfirmText.textContent = warning;
    homeConfirm.showModal();
    homeConfirmStay.focus();
  });
  homeConfirmLeave.addEventListener('click', () => void goHome().catch(showError));
  homeConfirmStay.addEventListener('click', () => homeConfirm.close());
  homeConfirm.addEventListener('click', (event) => {
    if (event.target === homeConfirm) homeConfirm.close();
  });
}
