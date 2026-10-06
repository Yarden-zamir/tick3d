// The header of every page: the wordmark, the account button, Info, kitshn and GitHub.
// Each page has the same header markup (src/markup.test.ts checks it). The Info button opens the
// #info-panel popover of the page, so each page writes its own Info text, and Info needs no script.
import { element } from '../element.ts';
import { api, OnlineError } from '../online.ts';
import type { PlayerInfo } from '../protocol.ts';
import { myGamesHref } from './my-games-link.ts';
import { setupPreviews } from './previews.ts';

export const homeLink = element('#home-link', HTMLAnchorElement);
export const accountLink = element('#account-button', HTMLAnchorElement);
const accountAvatar = element('#account-avatar', HTMLImageElement);
const accountName = element('#account-name', HTMLSpanElement);
export const infoButton = element('#info-button', HTMLButtonElement);

export function showAccount(user: PlayerInfo | null): void {
  accountAvatar.hidden = user === null;
  if (user !== null) accountAvatar.src = `${user.avatar}&s=48`;
  accountName.textContent = user?.login ?? 'My games';
  // On narrow phones only the icon shows, so the spoken name carries the login too.
  accountLink.setAttribute('aria-label', user === null ? 'My games' : `My games, logged in as ${user.login}`);
}

// The game page wires the account button and the wordmark itself (src/page/my-games.ts and home.ts).
export function setupGameHeader(): void {
  setupPreviews();
}

// A page other than the game: the account button opens My games on the game page, and a login there
// returns here. Offline, the button shows "My games" without the login.
export function setupPageHeader(): void {
  setupPreviews();
  accountLink.href = myGamesHref(`${location.pathname}${location.search}`);
  if (!navigator.onLine) return;
  api
    .me()
    .then(({ user }) => showAccount(user))
    .catch((error: unknown) => {
      if (!(error instanceof OnlineError)) throw error;
    });
}
