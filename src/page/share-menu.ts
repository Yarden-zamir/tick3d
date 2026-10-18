// The Share button of the game header: "Play online with a friend" starts an online game and shares its play link,
// and "Share tick3d" shares the invite link of /share with the person id of this player (src/share/invite.ts).
// The iOS app hides "Share tick3d": /share offers Google Play codes, and the App Store does not allow a pointer to
// another store ([data-hide-in~="ios"] in src/style.css).
import { inviteUrl } from '../share/invite.ts';
import { startOnlineGame } from './controls.ts';
import { element } from './dom.ts';
import { copyText, showError, showToast } from './feedback.ts';
import { shareLink } from './online-box.ts';
import { page } from './state.ts';

const menu = element('#game-share-menu', HTMLDivElement);

async function playWithFriend(): Promise<void> {
  await startOnlineGame();
  // The create failed (offline, for example), and its error shows already.
  if (page.session?.mode !== 'online') return;
  await shareLink('play');
}

// Only the link, as on /share: a chat app pastes it, and its preview tells the rest.
async function shareTick3d(): Promise<void> {
  const url = inviteUrl(location.origin, page.account.person);
  if (typeof navigator.share === 'function') {
    try {
      await navigator.share({ url });
      return;
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return;
    }
  }
  try {
    await copyText(url);
    showToast('Link copied.');
  } catch {
    showToast(`Send this link: ${url}`);
  }
}

export function setupShareMenu(): void {
  element('#game-share-play', HTMLButtonElement).addEventListener('click', () => {
    menu.hidePopover();
    void playWithFriend().catch(showError);
  });
  element('#game-share-site', HTMLButtonElement).addEventListener('click', () => {
    menu.hidePopover();
    void shareTick3d().catch(showError);
  });
}
