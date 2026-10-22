// The account button and the My games dialog.
import { winnerOf } from '../game.ts';
import type { LocalSummary } from '../local.ts';
import { avatarFor, type Person } from '../avatar.ts';
import { nameOf } from '../names.ts';
import { type Me, api, OnlineError, token } from '../online.ts';
import {
  type GameId,
  HISTORY_PAGE_SIZE,
  type HistoryEntry,
  type HistoryPage,
  type MyGames,
  type Outcome,
  type PlayerInfo,
  type SessionMode,
  type SessionSummary,
  type Tally,
  CUSTOM_NAME_MAX_LENGTH,
  CUSTOM_NAME_MIN_LENGTH,
  ALL_STATS,
  SESSION_MODES,
  outcomeOf,
  parseCustomName,
  statsQuery,
  toGame,
} from '../protocol.ts';
import { STATS_ICON } from '../icons.ts';
import { deviceDataKeys } from '../storage-keys.ts';
import { syncDeletions } from './deletions.ts';
import { accountLink } from '../header/header.ts';
import { platform } from '../platform.ts';
import {
  myGamesDialog,
  accountBox,
  myGamesHistory,
  myGamesMore,
  myGamesClear,
  clearConfirm,
  clearConfirmYes,
  clearConfirmNo,
  deleteConfirm,
  deleteConfirmForm,
  deleteConfirmNo,
  deleteConfirmScope,
  deleteConfirmSettings,
  deleteConfirmStatus,
  deleteConfirmYes,
  myGamesDelete,
  myGamesStats,
  myGamesNote,
  myGamesClose,
  myGamesStatsLink,
  myGamesPrivate,
  myGamesPrivateOption,
  myGamesSession,
  myGamesSessionBox,
  myGamesSessionCount,
} from './dom.ts';
import { type ShownAchievements, currentProgress, setupAchievements, showAchievements } from './achievements.ts';
import { type MyGamesTab, currentMyGamesTab, onMyGamesTabShown } from './my-games-layout.ts';
import { showError } from './feedback.ts';
import { openGameView } from './game-view.ts';
import { startReview } from './controls.ts';
import { openCard } from './end-card.ts';
import { render, resultText } from './render.ts';
import { loadBlocks, renderBlockedList } from './safety.ts';
import { deleteSentResults, flushResults, forgetRecords, syncRecords } from './results.ts';
import { openDeviceSession, joinSession, refresh } from './sessions.ts';
import { ownName, page, current, saveAccount } from './state.ts';

// A button of a list item. A click closes the dialog first.
type Action = { label: string; run: () => void };

// A small label on a list item, such as "Online" or "Won". `kind` colors it.
type Tag = { text: string; kind?: Outcome | 'turn' };

const LIST_AVATAR_PIXELS = 28;

// `person` is the other player of the game, when there is one: their picture leads the item.
function listItem(title: string, detail: string, actions: readonly Action[], tags: readonly Tag[] = [], person?: Person): HTMLLIElement {
  const item = document.createElement('li');
  if (person !== undefined) item.append(avatarFor(person, LIST_AVATAR_PIXELS, null));
  const text = document.createElement('div');
  const name = document.createElement('b');
  name.textContent = title;
  const small = document.createElement('small');
  small.textContent = detail;
  text.append(name);
  if (tags.length > 0) {
    const row = document.createElement('span');
    row.className = 'tags';
    for (const { text: label, kind } of tags) {
      const tag = document.createElement('span');
      tag.className = 'tag';
      if (kind !== undefined) tag.dataset.kind = kind;
      tag.textContent = label;
      row.append(tag);
    }
    text.append(row);
  }
  text.append(small);
  item.append(text);
  for (const { label, run } of actions) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'btn btn-small';
    button.textContent = label;
    button.addEventListener('click', () => {
      myGamesDialog.close();
      run();
    });
    item.append(button);
  }
  return item;
}

const ago = (time: number) => new Date(time).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });

// Stats from the results on this device, for when the server is out of reach.
async function deviceTallies(): Promise<Tally> {
  const tally: Tally = { played: 0, won: 0, lost: 0, drawn: 0 };
  for (const { upload } of (await page.deviceDb?.all('results')) ?? []) {
    tally.played++;
    if (upload.you === null) continue;
    const outcome = outcomeOf(winnerOf(toGame(upload.game).status), upload.you);
    if (outcome !== 'played') tally[outcome]++;
  }
  return tally;
}

// The same rule as playerName in render.ts. A null name means that the other seat is still empty.
function opponentOf({ opponent, opponentName }: { opponent: PlayerInfo | null; opponentName: string | null }): Person | undefined {
  const name = opponent?.login ?? opponentName;
  return name === null ? undefined : { player: opponent, name };
}

const gameCount = (count: number) => `${count} ${count === 1 ? 'game' : 'games'}`;

const MODE_NAMES: Record<SessionMode, string> = { computer: 'Computer', friend: 'Same screen', online: 'Online', nearby: 'Wi-Fi' };
const OUTCOME_NAMES: Record<Outcome, string> = { won: 'Won', lost: 'Lost', drawn: 'Draw', played: 'Played' };

function viewGame(id: GameId): void {
  void openGameView(id).catch(showError);
}

// One row of the games list: an open session or a finished game. `time` sorts the list, newest first.
type GamesRow = { time: number; mode: SessionMode; item: HTMLLIElement };

function row(kind: 'session' | 'game', mode: SessionMode, time: number, item: HTMLLIElement): GamesRow {
  item.dataset.kind = kind;
  item.dataset.mode = mode;
  return { time, mode, item };
}

function onlineRow(summary: SessionSummary): GamesRow {
  const person = opponentOf(summary);
  const tags: Tag[] = [{ text: 'Online' }];
  if (summary.yourTurn) tags.push({ text: 'Your turn', kind: 'turn' });
  const detail = `${person === undefined ? 'Waiting for a second player' : `vs ${person.name}`} · ${gameCount(summary.games)} · ${ago(summary.updatedAt)}`;
  const item = listItem(summary.name, detail, [{ label: 'Continue', run: () => void joinSession(summary.code, 'play') }], tags, person);
  return row('session', 'online', summary.updatedAt, item);
}

function deviceRow(entry: LocalSummary, mode: 'computer' | 'friend'): GamesRow {
  const item = listItem(entry.name, `${gameCount(entry.games)} · ${ago(entry.updatedAt)}`, [{ label: 'Open', run: () => void openDeviceSession(entry.code).catch(showError) }], [
    { text: MODE_NAMES[mode] },
    { text: 'On this device' },
  ]);
  return row('session', mode, entry.updatedAt, item);
}

function historyRow(entry: HistoryEntry): GamesRow {
  const person = opponentOf(entry);
  const title = entry.mode === 'computer' ? 'vs Computer' : entry.mode === 'friend' ? 'Same screen' : person === undefined ? MODE_NAMES[entry.mode] : `vs ${person.name}`;
  const mode = entry.difficulty === null ? MODE_NAMES[entry.mode] : `${MODE_NAMES[entry.mode]} · ${entry.difficulty}`;
  // A game stored before game links has no link to view.
  const id = entry.id;
  const actions = id === null ? [] : [{ label: 'View', run: () => viewGame(id) }];
  const item = listItem(title, `${entry.moves} moves · ${ago(entry.finishedAt)}`, actions, [{ text: OUTCOME_NAMES[entry.result], kind: entry.result }, { text: mode }], person);
  return row('game', entry.mode, entry.finishedAt, item);
}

// The finished games on this device that have a link, newest first, for when the server is out of reach.
async function deviceHistory(): Promise<HistoryEntry[]> {
  const entries: HistoryEntry[] = [];
  for (const { upload } of (await page.deviceDb?.all('results')) ?? []) {
    // A result from a version before game links has no id until the server gives it one.
    if (upload.publicId === null || upload.publicId === undefined) continue;
    entries.push({
      id: upload.publicId,
      mode: upload.mode,
      difficulty: upload.difficulty,
      result: outcomeOf(winnerOf(toGame(upload.game).status), upload.you),
      moves: upload.game.moves.length,
      opponent: null,
      opponentName: null,
      finishedAt: upload.finishedAt,
    });
  }
  return entries.sort((a, b) => b.finishedAt - a.finishedAt).slice(0, HISTORY_PAGE_SIZE);
}

// The games list: the open sessions and the finished games in one list, newest first. A mode chip
// above it shows only the rows of its mode.
// Limit: "More games" pages the finished games of every mode, so a filter shows only the loaded pages.
// Revisit this when players ask for one mode across all pages: the history request then needs a mode.
let sessionRows: GamesRow[] = [];
let gameRows: GamesRow[] = [];
let shownMode: SessionMode | 'all' = 'all';

function renderGamesList(): void {
  const rows = [...sessionRows, ...gameRows].sort((a, b) => b.time - a.time);
  for (const { mode, item } of rows) item.hidden = shownMode !== 'all' && mode !== shownMode;
  myGamesHistory.replaceChildren(...rows.map(({ item }) => item));
  if (rows.every(({ item }) => item.hidden)) {
    const empty = document.createElement('li');
    empty.className = 'empty';
    empty.textContent = shownMode === 'all' ? 'No games yet.' : `No ${MODE_NAMES[shownMode]} games here yet.`;
    myGamesHistory.append(empty);
  }
}

const tallyText = (tally: Tally) => (tally.won + tally.lost + tally.drawn === 0 ? `${tally.played}` : `${tally.won}–${tally.lost}`);

// The totals in one line, and a chip per mode that shows only that mode. Without `byMode` (offline), no chips.
function renderSummary(total: Tally, byMode: Record<SessionMode, Tally> | undefined): void {
  const line = document.createElement('p');
  line.className = 'my-games-total';
  line.textContent = `${gameCount(total.played)} · ${total.won} won · ${total.lost} lost · ${total.drawn} drawn`;
  myGamesStats.replaceChildren(line);
  if (byMode === undefined) return;
  const chips = document.createElement('div');
  chips.className = 'my-games-chips';
  const chip = (mode: SessionMode | 'all', label: string) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'btn btn-small';
    button.dataset.mode = mode;
    button.setAttribute('aria-pressed', String(mode === shownMode));
    button.textContent = label;
    button.addEventListener('click', () => {
      shownMode = mode;
      for (const other of chips.children) other.setAttribute('aria-pressed', String(other === button));
      renderGamesList();
    });
    return button;
  };
  chips.append(chip('all', 'All'), ...SESSION_MODES.map((mode) => chip(mode, `${MODE_NAMES[mode]} ${tallyText(byMode[mode])}`)));
  myGamesStats.append(chips);
}

let historyOffset = 0;

// The first page of the history replaces the finished games; a next page adds to them.
function showHistoryPage(next: HistoryPage, append: boolean): void {
  historyOffset = (append ? historyOffset : 0) + next.games.length;
  gameRows = [...(append ? gameRows : []), ...next.games.map(historyRow)];
  myGamesMore.hidden = !next.more;
  renderGamesList();
}

async function loadMoreHistory(request: number): Promise<void> {
  const next = await api.history(historyOffset);
  if (request === myGamesRequest) showHistoryPage(next, true);
}

// The answers of the server for the Games tab. The page loads them in the background after it starts
// (preloadMyGames), so My games shows them at once, and then asks again while it is open.
type ServerGames = { mine: MyGames; firstPage: HistoryPage };
let cachedGames: ServerGames | undefined;
let loadingGames: Promise<ServerGames> | undefined;
let cachedAchievements: ShownAchievements | undefined;

// One request for each list at a time: a second call waits for the first.
function fetchGames(): Promise<ServerGames> {
  loadingGames ??= Promise.all([api.myGames(), api.history(0)])
    .then(([mine, firstPage]) => (cachedGames = { mine, firstPage }))
    .finally(() => (loadingGames = undefined));
  return loadingGames;
}

const ignoreOffline = (error: unknown) => {
  if (!(error instanceof OnlineError)) showError(error);
};

// Loads My games in the background, once, so that the dialog opens with its lists.
export function preloadMyGames(): void {
  if (!navigator.onLine) return;
  if (cachedGames === undefined) void fetchGames().catch(ignoreOffline);
  if (cachedAchievements === undefined) void currentProgress().then((progress) => (cachedAchievements ??= progress), ignoreOffline);
}

// A change of the account, a logout or a cleared history makes the answers wrong.
function forgetMyGames(): void {
  cachedGames = undefined;
  cachedAchievements = undefined;
}

function showServerGames({ mine, firstPage }: ServerGames): void {
  myGamesNote.textContent = mine.user ? 'Your games on every device you logged in with.' : 'Your games on this browser.';
  renderSummary(mine.total, mine.byMode);
  sessionRows = [...sessionRows.filter(({ mode }) => mode !== 'online'), ...mine.sessions.map(onlineRow)];
  showHistoryPage(firstPage, false);
  myGamesClear.hidden = historyOffset === 0;
}

const ACCOUNT_AVATAR_PIXELS = 32;

// "Hide my stats" (StatsPrivacy in src/protocol.ts). Without a network or an answer, the switch stays hidden.
async function loadStatsPrivacy(request: number): Promise<void> {
  myGamesPrivateOption.hidden = true;
  if (!navigator.onLine) return;
  try {
    const privacy = await api.statsPrivacy();
    if (request !== myGamesRequest) return;
    myGamesPrivate.checked = privacy.private;
    myGamesPrivateOption.hidden = false;
  } catch (error) {
    if (!(error instanceof OnlineError)) throw error;
  }
}

async function changeStatsPrivacy(): Promise<void> {
  const wanted = myGamesPrivate.checked;
  try {
    myGamesPrivate.checked = (await api.setStatsPrivacy(wanted)).private;
  } catch (error) {
    myGamesPrivate.checked = !wanted;
    throw error;
  }
}

// The last answer shows at once, and the new answer replaces it.
async function loadAchievements(request: number): Promise<void> {
  if (cachedAchievements !== undefined) showAchievements(cachedAchievements);
  const progress = await currentProgress();
  cachedAchievements = progress;
  if (request === myGamesRequest) showAchievements(progress);
}

// Opening the dialog again while a list loads starts over, so a late answer never adds a second copy.
let myGamesRequest = 0;

// The Achievements and Account tabs load when they show, once per opening of the dialog. Then the Games
// tab does not wait behind their requests on the server. The Games tab loads at every opening.
const tabsLoaded = new Set<MyGamesTab>();

function loadTab(request: number, tab: MyGamesTab): void {
  if (tabsLoaded.has(tab)) return;
  tabsLoaded.add(tab);
  if (tab === 'Achievements') void loadAchievements(request).catch(showError);
  if (tab === 'Account') void loadStatsPrivacy(request).catch(showError);
}

// The page where a login returns, kept for a rebuild of the account box while My games is open.
let accountReturnTo: string | undefined;

// The account part of My games. refreshAccount rebuilds it when a slower /api/me answer changes the account.
function renderAccountBox(): void {
  accountBox.replaceChildren();
  if (page.account.user) {
    const avatar = avatarFor({ player: page.account.user, name: page.account.user.login }, ACCOUNT_AVATAR_PIXELS, null);
    const name = document.createElement('b');
    name.textContent = page.account.user.login;
    const logout = document.createElement('button');
    logout.type = 'button';
    logout.className = 'btn btn-small';
    logout.textContent = 'Log out';
    logout.addEventListener('click', () => void logOut().then(() => myGamesDialog.close(), showError));
    accountBox.append(avatar, name, logout);
  } else {
    // The same name that the server shows to the other players: the custom name, else the generated one (src/names.ts).
    const text = document.createElement('span');
    const name = document.createElement('b');
    name.textContent = ownName();
    text.append('You play as ', name, '.');
    accountBox.append(avatarFor({ player: null, name: ownName() }, ACCOUNT_AVATAR_PIXELS, null), text);
    if (navigator.onLine) accountBox.append(renameControls());
    // The iOS app offers no GitHub login: App Store rule 4.8 asks for Sign in with Apple next to it.
    if (page.account.loginAvailable && navigator.onLine && platform() === 'web') {
      text.append(' Log in with GitHub to use your GitHub name.');
      const login = document.createElement('a');
      login.className = 'btn btn-small btn-primary login-link';
      login.href = api.loginUrl(accountReturnTo);
      login.textContent = 'Log in with GitHub';
      accountBox.append(login);
    }
  }
}

// `returnTo` is the page that a GitHub login returns to. Without it, the login returns to this page.
export async function openMyGames(returnTo?: string): Promise<void> {
  const request = ++myGamesRequest;
  myGamesDialog.showModal();
  renderBlockedList();
  tabsLoaded.clear();
  loadTab(request, currentMyGamesTab());
  accountReturnTo = returnTo;
  renderAccountBox();
  // The last answer of the server shows at once (often from preloadMyGames). The new answer and the
  // sessions on this device come in parallel, and each one updates the list when it arrives.
  sessionRows = [];
  if (cachedGames !== undefined) showServerGames(cachedGames);
  else {
    gameRows = [];
    renderGamesList();
    if (navigator.onLine) {
      myGamesHistory.querySelector('li.empty')?.remove();
      const loading = document.createElement('li');
      loading.className = 'empty';
      loading.textContent = 'Loading your games…';
      myGamesHistory.append(loading);
    }
  }
  const fresh = navigator.onLine ? fetchGames() : Promise.reject(new OnlineError('offline'));
  // The catch below handles a failure, after the sessions of this device show.
  fresh.catch(() => undefined);
  const local = (await page.local?.list()) ?? [];
  if (request !== myGamesRequest) return;
  const deviceRows = local.flatMap((entry) => (entry.mode === 'nearby' ? [] : [deviceRow(entry, entry.mode)]));
  sessionRows = [...deviceRows, ...sessionRows.filter(({ mode }) => mode === 'online')];
  if (myGamesHistory.querySelector('li[data-kind]') !== null || cachedGames !== undefined || deviceRows.length > 0) renderGamesList();
  try {
    const games = await fresh;
    if (request !== myGamesRequest) return;
    showServerGames(games);
  } catch (error) {
    if (!(error instanceof OnlineError)) throw error;
    const tallies = await deviceTallies();
    const history = await deviceHistory();
    if (request !== myGamesRequest) return;
    myGamesNote.textContent = 'You are offline. These are the games on this device.';
    shownMode = 'all';
    renderSummary(tallies, undefined);
    sessionRows = deviceRows;
    gameRows = history.map(historyRow);
    myGamesMore.hidden = true;
    // Clearing needs the server.
    myGamesClear.hidden = true;
    renderGamesList();
  }
}

// Clears the history on the server (every device of the account) and the uploaded results on this device.
// The survival records and the achievements stay: they are kept apart from the history.
async function clearHistory(): Promise<void> {
  clearConfirmYes.disabled = true;
  try {
    // Upload what waits first, so a result that arrives later does not bring a cleared game back.
    await flushResults();
    await api.clearHistory();
    await deleteSentResults();
    clearConfirm.close();
    forgetMyGames();
    historyOffset = 0;
    gameRows = [];
    renderGamesList();
    // The dialog covers the toasts, so the dialog itself says what happened.
    myGamesNote.textContent = 'History cleared. Your survival records and achievements stay.';
    myGamesMore.hidden = true;
    myGamesClear.hidden = true;
  } finally {
    clearConfirmYes.disabled = false;
  }
}

// Logout. The server moves the finished games and seats of this browser to the account, so this
// device drops its copies of account data: the uploaded results, the survival records and the cached
// online games. Settings, sound, tuning and the sessions on this device stay.
// Limit: a result that does not upload before the logout stays, and uploads later for this browser.
// Revisit this if players report a logged-in game in the stats of a logged-out browser.
async function logOut(): Promise<void> {
  await flushResults();
  await api.logout();
  await deleteSentResults();
  forgetRecords();
  forgetMyGames();
  const db = page.deviceDb;
  if (db !== undefined) for (const cached of await db.all('remote')) await db.delete('remote', cached.code);
  await refreshAccount();
}

// Delete my data. The server deletes the data of this player, and of the account when this browser
// is logged in, and logs out. Then this device deletes its copies: saved sessions, results, cached
// online games and the stored data (deviceDataKeys). The player token stays, so the people who
// blocked or reported this player still recognise them. Closing the dialog then reloads the page,
// so no game in memory writes its data back.
let dataDeleted = false;

function openDeleteConfirm(): void {
  const user = page.account.user;
  deleteConfirmScope.textContent =
    user === null ? 'This deletes the data of this device, on the server and here:' : `This deletes the data of the GitHub account ${user.login} on every device, and of this device:`;
  deleteConfirmSettings.checked = false;
  deleteConfirmStatus.hidden = true;
  deleteConfirm.showModal();
  deleteConfirmNo.focus();
}

async function deleteMyData(): Promise<void> {
  deleteConfirmYes.disabled = true;
  try {
    await api.deleteData();
  } catch (error) {
    if (!(error instanceof OnlineError)) throw error;
    // The dialog covers the toasts, so it says what happened.
    deleteConfirmStatus.textContent = `Nothing was deleted: ${error.message}`;
    deleteConfirmStatus.hidden = false;
    return;
  } finally {
    deleteConfirmYes.disabled = false;
  }
  const db = page.deviceDb;
  if (db !== undefined) for (const store of ['sessions', 'results', 'remote'] as const) await db.clear(store);
  try {
    for (const key of deviceDataKeys(Object.keys(localStorage), deleteConfirmSettings.checked)) localStorage.removeItem(key);
  } catch {
    // Storage is blocked (private mode), so it holds no data.
  }
  dataDeleted = true;
  deleteConfirmForm.hidden = true;
  deleteConfirmYes.hidden = true;
  deleteConfirmNo.textContent = 'Close';
  deleteConfirmStatus.textContent = 'Your data is deleted. The page starts fresh when you close this.';
  deleteConfirmStatus.hidden = false;
}

// The games of the open session, oldest first, with Replay and the result card. render() calls this,
// so the list stays current while the dialog is open. A game from a link has no session here.
export function renderSessionGames(): void {
  myGamesSessionBox.hidden = page.session === undefined;
  myGamesSessionCount.textContent = gameCount(page.games.length);
  myGamesSession.replaceChildren(
    ...page.games.map((game, index) => {
      const actions: Action[] = [];
      // The live game has no moves to replay until it ends: the board shows it.
      if (game !== current() || game.status.kind !== 'playing') {
        actions.push({ label: page.review?.game === index ? 'Viewing' : 'Replay', run: () => startReview(index) });
      }
      if (game.status.kind !== 'playing') actions.push({ label: 'Card', run: () => void openCard(index).catch(showError) });
      const item = listItem(`Game ${index + 1}`, `${resultText(game, index)} · ${game.moves.length} ${game.moves.length === 1 ? 'move' : 'moves'}`, actions);
      item.classList.toggle('active', page.review?.game === index);
      return item;
    }),
  );
}

// Rename for a player without a GitHub login: an inline form, and a reset to the generated name.
// The dialog covers the toasts, so a refused name shows in the form.
function renameControls(): HTMLElement {
  const box = document.createElement('div');
  box.className = 'rename';
  const open = document.createElement('button');
  open.className = 'btn btn-small';
  open.type = 'button';
  open.textContent = 'Rename';
  const form = document.createElement('form');
  form.className = 'rename-form';
  form.hidden = true;
  const input = document.createElement('input');
  input.type = 'text';
  input.maxLength = CUSTOM_NAME_MAX_LENGTH;
  input.value = page.account.name ?? '';
  input.placeholder = nameOf(token);
  input.setAttribute('aria-label', 'Your name');
  const save = document.createElement('button');
  save.className = 'btn btn-small btn-primary';
  save.type = 'submit';
  save.textContent = 'Save';
  const cancel = document.createElement('button');
  cancel.className = 'btn btn-small';
  cancel.type = 'button';
  cancel.textContent = 'Cancel';
  const problem = document.createElement('small');
  problem.className = 'rename-problem';
  form.append(input, save, cancel, problem);
  box.append(open, form);
  if (page.account.name !== null) {
    const reset = document.createElement('button');
    reset.className = 'btn btn-small';
    reset.type = 'button';
    reset.textContent = 'Reset to generated name';
    reset.addEventListener('click', () => void changeName(() => api.clearName(), problem));
    box.append(reset);
  }
  open.addEventListener('click', () => {
    form.hidden = false;
    open.hidden = true;
    input.focus();
  });
  cancel.addEventListener('click', () => {
    form.hidden = true;
    open.hidden = false;
    problem.textContent = '';
  });
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const name = parseCustomName(input.value);
    if (name === undefined) {
      problem.textContent = `A name needs ${CUSTOM_NAME_MIN_LENGTH} to ${CUSTOM_NAME_MAX_LENGTH} letters, digits, spaces, "-" or "_".`;
      return;
    }
    void changeName(() => api.setName(name), problem);
  });
  return box;
}

async function changeName(call: () => Promise<Me>, problem: HTMLElement): Promise<void> {
  try {
    saveAccount(await call());
  } catch (error) {
    if (!(error instanceof OnlineError)) throw error;
    problem.textContent = error.message;
    return;
  }
  // The open game shows the new name at once. The server tells the other screens of the game.
  if (page.session?.mode === 'online') await refresh(page.session.code);
  render();
  await openMyGames();
}

// Asks the server who is logged in. Without a network the page keeps the last answer.
export async function refreshAccount(): Promise<void> {
  if (!navigator.onLine) return;
  try {
    const before = JSON.stringify(page.account);
    saveAccount(await api.me());
    if (JSON.stringify(page.account) !== before) {
      forgetMyGames();
      // Only on a change: a rebuild clears a rename that the player is typing.
      if (myGamesDialog.open) renderAccountBox();
    }
    void syncRecords();
    void syncDeletions().catch(showError);
    // The blocks follow a login, so they load after the account.
    void loadBlocks().catch(showError);
  } catch (error) {
    if (!(error instanceof OnlineError)) throw error;
  }
  render();
}

export function setupMyGames(): void {
  setupAchievements();
  onMyGamesTabShown((tab) => {
    if (myGamesDialog.open) loadTab(myGamesRequest, tab);
  });
  // The account button is a link to the My games request (src/header/my-games-link.ts). Here it opens
  // the dialog at once. A modified click opens a new tab, as for any link, and the dialog opens there.
  accountLink.addEventListener('click', (event) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    void openMyGames().catch(showError);
  });
  // A pointer on the account button, or a focus, loads My games before the click.
  for (const event of ['pointerenter', 'focus', 'touchstart'] as const) accountLink.addEventListener(event, preloadMyGames, { passive: true });
  myGamesClose.addEventListener('click', () => myGamesDialog.close());
  // The stats page, with your own games.
  myGamesStatsLink.href = `/stats${statsQuery({ ...ALL_STATS, scope: 'mine' })}`;
  myGamesStatsLink.insertAdjacentHTML('afterbegin', STATS_ICON);
  myGamesPrivate.addEventListener('change', () => void changeStatsPrivacy().catch(showError));
  myGamesMore.addEventListener('click', () => void loadMoreHistory(myGamesRequest).catch(showError));
  myGamesClear.addEventListener('click', () => {
    clearConfirm.showModal();
    clearConfirmNo.focus();
  });
  clearConfirmNo.addEventListener('click', () => clearConfirm.close());
  clearConfirmYes.addEventListener('click', () => void clearHistory().catch(showError));
  clearConfirm.addEventListener('click', (event) => {
    if (event.target === clearConfirm) clearConfirm.close();
  });
  myGamesDelete.addEventListener('click', openDeleteConfirm);
  deleteConfirmNo.addEventListener('click', () => deleteConfirm.close());
  deleteConfirmYes.addEventListener('click', () => void deleteMyData().catch(showError));
  deleteConfirm.addEventListener('click', (event) => {
    if (event.target === deleteConfirm) deleteConfirm.close();
  });
  deleteConfirm.addEventListener('close', () => {
    if (dataDeleted) location.assign('/');
  });
  myGamesDialog.addEventListener('click', (event) => {
    if (event.target === myGamesDialog) myGamesDialog.close();
  });
}
