import './style.css';
import { openDeviceDb, memoryDeviceDb } from './device-db.ts';
import { createLocalBackend } from './local.ts';
import { EMPTY_SESSION_TTL_MS } from './session/core.ts';
import { setupPwa } from './pwa.ts';
import { token } from './online.ts';
import { normalizeCode, parseGameId } from './protocol.ts';
import { setMuted, setSoundSet } from './sound.ts';
import { setupAdvanced } from './page/advanced.ts';
import { applyCamera, setupBoard } from './page/board.ts';
import { setupChat } from './page/chat.ts';
import { setupClocks, tickClock } from './page/clocks.ts';
import { setupControls } from './page/controls.ts';
import { soundSetList, updateBar, updateReload } from './page/dom.ts';
import { setupEndCard } from './page/end-card.ts';
import { showToast, showProblem, showError } from './page/feedback.ts';
import { openGameView, setupGameView } from './page/game-view.ts';
import { setupHome } from './page/home.ts';
import { setupKeypad } from './page/keypad.ts';
import { setupReports } from './page/metrics.ts';
import { refreshAccount, setupMyGames } from './page/my-games.ts';
import { setupPreviews } from './page/previews.ts';
import { openNearbyLink, openNearby, setupNearby } from './page/nearby.ts';
import { checkLanHost, setupOnlineBox } from './page/online-box.ts';
import { render } from './page/render.ts';
import { flushResults } from './page/results.ts';
import { refresh, setUrlCode, setUrlGame, joinSession, openLocalSession } from './page/sessions.ts';
import { settings } from './page/settings.ts';
import { page } from './page/state.ts';
import { applyTheme, setupTheme } from './page/theme.ts';
import { setupSoundSets } from './page/sound-set.ts';

// Every module only declares things on import. These calls add the listeners and build the
// board, tuning and theme controls, in the order of the old single page script.
setupBoard();
setupControls();
setupNearby();
setupMyGames();
setupPreviews();

setupPwa({
  onNeedRefresh(reload) {
    updateBar.hidden = false;
    updateReload.disabled = false;
    updateReload.textContent = 'Reload';
    updateReload.onclick = () => {
      // Feedback at once: the new version can take a moment to take over.
      updateReload.disabled = true;
      updateReload.textContent = 'Updating…';
      void reload();
    };
  },
});

setupClocks();
setupAdvanced();
setupEndCard();
setupTheme();
setupSoundSets(soundSetList, setSoundSet);
setupKeypad();
setupChat();
setupOnlineBox();
setupHome();
setupGameView();
setupReports();

async function start(): Promise<void> {
  try {
    page.deviceDb = await openDeviceDb();
  } catch {
    // The browser blocks storage (some private modes). Games then last for this visit only.
    page.deviceDb = memoryDeviceDb();
    showToast('This browser does not let the game store data, so games last for this visit only.');
  }
  page.local = createLocalBackend(page.deviceDb, token, () => page.account.user);
  // Before any session opens, so a session the start opens is never pruned under it.
  await page.local.pruneEmpty(EMPTY_SESSION_TTL_MS);
  void refreshAccount();
  void checkLanHost();
  const params = new URLSearchParams(location.search);
  if (params.get('login') === 'failed') {
    showProblem('The GitHub login did not work. Try again.');
    const url = new URL(location.href);
    url.searchParams.delete('login');
    history.replaceState(null, '', url);
  }
  void flushResults();
  addEventListener('online', () => {
    void flushResults();
    void refreshAccount();
    if (page.session?.mode === 'online') void refresh(page.session.code);
    render();
  });
  addEventListener('offline', () => render());

  const linkCode = new URLSearchParams(location.search).get('code');
  const code = linkCode === null ? undefined : normalizeCode(linkCode);
  if (linkCode !== null && code === undefined) {
    setUrlCode(undefined);
    showToast(`The link code "${linkCode}" is not valid.`);
  }
  if (code !== undefined) {
    await joinSession(code);
    if (page.session?.code === code) return;
    // The code opened no game (none with that code, or no network), and the error shows already.
    // The address drops the code, so a reload does not repeat the error, and the page starts as usual.
    setUrlCode(undefined);
  }
  // A game link opens that game read-only. With a code too, the session opens instead.
  const gameLink = params.get('game');
  if (gameLink !== null && linkCode === null) {
    const id = parseGameId(gameLink);
    if (id === undefined) showToast(`The game link "${gameLink}" is not valid.`);
    else if (await openGameView(id)) return;
    setUrlGame(undefined);
  }
  const nearbyCode = params.get('nearby');
  if (nearbyCode !== null) return openNearbyLink(nearbyCode);
  if (settings.mode === 'online') return render();
  if (settings.mode === 'nearby') return openNearby();
  await openLocalSession(settings.mode);
}

setMuted(settings.muted);
setInterval(tickClock, 200);
applyTheme();
applyCamera();
render();
void start().catch(showError);
