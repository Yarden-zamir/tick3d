import './style.css';
import { type DeviceDb, openDeviceDb, memoryDeviceDb } from './device-db.ts';
import { createLocalBackend } from './local.ts';
import { EMPTY_SESSION_TTL_MS } from './session/core.ts';
import { setupPwa } from './pwa.ts';
import { token } from './online.ts';
import { normalizeCode, parseGameId } from './protocol.ts';
import { readLinkIntent } from './session-link.ts';
import { setMuted, setSoundSet } from './sound.ts';
import { checkUnlocks, setupAchievementPopup } from './page/achievement-popup.ts';
import { setupIdentityNudge } from './page/identity-nudge.ts';
import { setupAdvanced } from './page/advanced.ts';
import { reportAppOpen } from './page/app-copy.ts';
import { playWithFriend, setupShareMenu } from './page/share-menu.ts';
import { applyCamera, setupBoard } from './page/board.ts';
import { setupChat } from './page/chat.ts';
import { setupPanelAnchor } from './page/panel-anchor.ts';
import { setupClocks, tickClock } from './page/clocks.ts';
import { setupControls } from './page/controls.ts';
import { soundSetList, updateBar, updateReload } from './page/dom.ts';
import { setupEndCard } from './page/end-card.ts';
import { showToast, showProblem, showError } from './page/feedback.ts';
import { openGameView, setupGameView } from './page/game-view.ts';
import { setupHome } from './page/home.ts';
import { renderCoords, setupKeypad } from './page/keypad.ts';
import { setupReports } from './page/metrics.ts';
import { openMyGames, refreshAccount, setupMyGames, preloadMyGames } from './page/my-games.ts';
import { offerGoogleOneTap } from './page/google-one-tap.ts';
import { setupGameHeader } from './header/header.ts';
import { readMyGamesRequest, withoutMyGamesRequest } from './header/my-games-link.ts';
import { takePlayOnlineRequest } from './header/play-online-link.ts';
import { setupMyGamesTabs } from './page/my-games-layout.ts';
import { openNearbyLink, openNearby, setupNearby } from './page/nearby.ts';
import { checkLanHost, setupOnlineBox } from './page/online-box.ts';
import { setupPlayers } from './page/players.ts';
import { setupSafety } from './page/safety.ts';
import { setupAvatarViewer } from './page/avatar-viewer.ts';
import { render } from './page/render.ts';
import { flushResults } from './page/results.ts';
import { refresh, setUrlCode, setUrlGame, joinSession, openLocalSession } from './page/sessions.ts';
import { settings } from './page/settings.ts';
import { page, shared } from './page/state.ts';
import { applyTheme, setupTheme } from './page/theme.ts';
import { setupSettingsHint } from './page/settings-hint.ts';
import { setupSlidePills } from './page/slide-pill.ts';
import { setupSoundSets } from './page/sound-set.ts';
import { setupTutorial } from './page/tutorial.ts';
import { setupVoice } from './page/voice.ts';

// Every module only declares things on import. These calls add the listeners and build the
// board, tuning and theme controls, in the order of the old single page script.
setupBoard();
setupControls();
setupVoice();
setupNearby();
setupMyGames();
setupMyGamesTabs();
setupGameHeader();

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
setupAchievementPopup();
setupIdentityNudge();
setupShareMenu();
setupTheme();
setupSoundSets(soundSetList, (id) => {
  setSoundSet(id);
  // The speaker by the keypad depends on the set.
  renderCoords();
});
setupKeypad();
setupChat();
setupPanelAnchor();
// The pop of a control that turns on starts with the first press or key of the player (src/style.css
// data-ready). The first renders turn on the saved choices, and those should not all pop at load.
for (const type of ['pointerdown', 'keydown'] as const) {
  addEventListener(type, () => document.documentElement.toggleAttribute('data-ready', true), { once: true, capture: true });
}
setupSettingsHint();
setupSlidePills();
setupTutorial();
setupOnlineBox();
setupPlayers();
setupSafety();
setupAvatarViewer();
setupHome();
setupGameView();
setupReports();

// Another tab or the installed app can hold the device database: a frozen page in the middle of a write
// keeps its transaction open. Every transaction of this page then waits, with no end and no error, and
// the page stays on "Getting the game ready…". After this wait the game starts with storage for this visit.
const STORAGE_WAIT_MS = 4000;

class StorageWaitError extends Error {}

// Opens the device database and prunes empty sessions. The prune reads the sessions store, so it also
// proves that no other tab holds that store.
async function openStorage(): Promise<DeviceDb> {
  const db = await openDeviceDb();
  // Before any session opens, so a session the start opens is never pruned under it.
  await createLocalBackend(db, token, () => page.account.user).pruneEmpty(EMPTY_SESSION_TTL_MS);
  return db;
}

// Limit: only the start has this wait. A tab that takes the database later still stalls a move of this tab.
// Revisit this if players report a stuck game after the start.
async function startStorage(): Promise<DeviceDb> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const waited = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new StorageWaitError()), STORAGE_WAIT_MS);
  });
  try {
    // A late success after the wait leaves one unused connection open. It closes with the page.
    return await Promise.race([openStorage(), waited]);
  } catch (error) {
    // Games then last for this visit only.
    showToast(
      error instanceof StorageWaitError
        ? 'tick3d is open in another tab or the app. Close it, then reload.'
        : // The browser blocks storage (some private modes), or an older tab blocks it.
          'This browser does not let the game store data, so games last for this visit only.',
    );
    return memoryDeviceDb();
  } finally {
    clearTimeout(timer);
  }
}

async function start(): Promise<void> {
  page.deviceDb = await startStorage();
  page.local = createLocalBackend(page.deviceDb, token, () => page.account.user);
  const account = refreshAccount();
  void checkLanHost();
  // The unlocks that this device did not show yet, such as an invite on /share. A login links this browser first.
  void account.then(checkUnlocks).catch(showError);
  void account.then(() => offerGoogleOneTap(showError)).catch(showError);
  // The Android app reports its open: the copy of this device, and the invite of the inviter. A login links this browser first.
  void account.then(reportAppOpen).catch(showError);
  // My games loads in the background when the page is idle, so the dialog opens with its lists.
  void account.then(() => (window.requestIdleCallback === undefined ? setTimeout(preloadMyGames, 2000) : requestIdleCallback(preloadMyGames, { timeout: 5000 })));
  // The account button of another page asks to open My games. The dialog opens after the account
  // is known, so it shows the right login.
  const myGamesRequest = readMyGamesRequest(new URL(location.href));
  if (myGamesRequest !== undefined) {
    history.replaceState(null, '', withoutMyGamesRequest(new URL(location.href)));
    void account.then(() => openMyGames(myGamesRequest.returnTo)).catch(showError);
  }
  // "Play online with a friend" in the Share menu of /share. The game starts after the account is known.
  const playOnline = takePlayOnlineRequest(new URL(location.href));
  if (playOnline !== undefined) {
    history.replaceState(null, '', playOnline);
    void account.then(playWithFriend).catch(showError);
  }
  const params = new URLSearchParams(location.search);
  const loginProblem = new Map([
    ['failed', 'The login did not work. Try again.'],
    ['taken', 'That login cannot join this account: one of them already has a login of the same kind.'],
  ]).get(params.get('login') ?? '');
  if (loginProblem !== undefined) {
    showProblem(loginProblem);
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
  // A page that comes back to the front reads its game again. A phone that sleeps can miss changes on
  // the live stream, and a page from the back-forward cache shows the game from before it left.
  const reread = () => {
    if (shared() && page.session !== undefined) void refresh(page.session.code);
  };
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') reread();
  });
  addEventListener('pageshow', (event) => {
    if (event.persisted) reread();
  });

  const linkCode = new URLSearchParams(location.search).get('code');
  const code = linkCode === null ? undefined : normalizeCode(linkCode);
  if (linkCode !== null && code === undefined) {
    setUrlCode(undefined);
    showToast(`The link code "${linkCode}" is not valid.`);
  }
  if (code !== undefined) {
    const intent = readLinkIntent(params);
    // A broken watch value still only watches: a seat taken by mistake is worse than no seat.
    if (intent === 'invalid') showToast(`The link value watch="${params.getAll('watch').join(',')}" is not valid. Use watch=1.`);
    await joinSession(code, intent === 'play' ? 'play' : 'watch');
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
