// The header of every page: the wordmark, the account button and Info. kitshn and GitHub sit in the
// footer of every page. Each page has the same header and footer markup (src/markup.test.ts checks it). The Info button opens the
// #info-panel popover of the page, so each page writes its own Info text, and Info needs no script.
// The header setup also installs the click sound of every control (src/click-sound.ts).
import { element } from '../element.ts';
import { type Me, api, OnlineError, storedMe } from '../online.ts';
import { type PlayerInfo, accountNameOf } from '../protocol.ts';
import { avatarSrc } from '../avatar.ts';
import { myGamesHref } from './my-games-link.ts';
import { setupTooltips } from '../tooltip.ts';
import { setupClickSound } from '../click-sound.ts';
import { setupPreviews } from './previews.ts';
import { markPlatform } from '../platform.ts';

export const homeLink = element('#home-link', HTMLAnchorElement);
export const accountLink = element('#account-button', HTMLAnchorElement);
const accountAvatar = element('#account-avatar', HTMLImageElement);
const accountName = element('#account-name', HTMLSpanElement);

export function showAccount(user: PlayerInfo | null): void {
  accountAvatar.hidden = user === null;
  if (user !== null) accountAvatar.src = avatarSrc({ player: user, name: user.login }, 24);
  accountName.textContent = accountNameOf(user) ?? 'My games';
  // On narrow phones only the icon shows, so the spoken name carries the login too.
  accountLink.setAttribute('aria-label', user === null ? 'My games' : `My games, logged in as ${user.login}`);
}

// The game page wires the account button and the wordmark itself (src/page/my-games.ts and home.ts).
export function setupGameHeader(): void {
  markPlatform();
  setupClickSound();
  setupTooltips();
  setupPreviews();
}

// A page other than the game: the account button opens My games on the game page, and a login there
// returns here. The button shows the account of the last answer at once, also offline, or "My games" before any answer.
// `onAccount` gets the answer of GET /api/me, when one comes.
export function setupPageHeader(onAccount?: (me: Me) => void): void {
  markPlatform();
  setupClickSound();
  setupTooltips();
  setupPreviews();
  accountLink.href = myGamesHref(`${location.pathname}${location.search}`);
  // The last answer shows at once, also offline. The new answer replaces it.
  showAccount(storedMe()?.user ?? null);
  if (!navigator.onLine) return;
  api
    .me()
    .then((me) => {
      // Null: a newer change of the account came meanwhile, and the header shows it already.
      if (me === null) return;
      showAccount(me.user);
      onAccount?.(me);
    })
    .catch((error: unknown) => {
      if (!(error instanceof OnlineError)) throw error;
    });
}
