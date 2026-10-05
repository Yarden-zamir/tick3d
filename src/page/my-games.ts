// The account button and the My games dialog.
import { winnerOf } from '../game.ts';
import { api, OnlineError } from '../online.ts';
import { type GameId, HISTORY_PAGE_SIZE, type HistoryEntry, type Outcome, type SessionMode, type Tally, outcomeOf, toGame } from '../protocol.ts';
import {
  accountAvatar,
  accountName,
  accountButton,
  myGamesDialog,
  accountBox,
  myGamesDevice,
  myGamesHistory,
  myGamesMore,
  myGamesClear,
  clearConfirm,
  clearConfirmYes,
  clearConfirmNo,
  myGamesStats,
  myGamesOnline,
  myGamesNote,
  myGamesOnlineBox,
  myGamesClose,
} from './dom.ts';
import { showError, showToast, reject } from './feedback.ts';
import { openGameView } from './game-view.ts';
import { render } from './render.ts';
import { flushResults, syncRecords } from './results.ts';
import { openDeviceSession, joinSession } from './sessions.ts';
import { page, settingsLocked } from './state.ts';

export function renderAccount(): void {
  const user = page.account.user;
  accountAvatar.hidden = user === null;
  if (user !== null) accountAvatar.src = `${user.avatar}&s=48`;
  accountName.textContent = user?.login ?? 'My games';
  // On narrow phones only the icon shows, so the spoken name carries the login too.
  accountButton.setAttribute('aria-label', user === null ? 'My games' : `My games, logged in as ${user.login}`);
}

function tallyBox(label: string, tally: Tally): HTMLElement {
  const box = document.createElement('div');
  box.className = 'my-tally';
  const title = document.createElement('b');
  title.textContent = label;
  const numbers = document.createElement('span');
  numbers.textContent =
    tally.won + tally.lost + tally.drawn === 0 && tally.played > 0
      ? `${tally.played} played`
      : `${tally.won} won · ${tally.lost} lost · ${tally.drawn} drawn`;
  box.append(title, numbers);
  return box;
}

// Without an action the item has no button.
function listItem(title: string, detail: string, action: string | undefined, onClick: () => void, badge?: string): HTMLLIElement {
  const item = document.createElement('li');
  const text = document.createElement('div');
  const name = document.createElement('b');
  name.textContent = title;
  const small = document.createElement('small');
  small.textContent = detail;
  text.append(name, small);
  item.append(text);
  if (badge) {
    const mark = document.createElement('span');
    mark.className = 'badge';
    mark.textContent = badge;
    item.append(mark);
  }
  if (action === undefined) return item;
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = action;
  button.addEventListener('click', () => {
    myGamesDialog.close();
    onClick();
  });
  item.append(button);
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

const gameCount = (count: number) => `${count} ${count === 1 ? 'game' : 'games'}`;

const MODE_NAMES: Record<SessionMode, string> = { computer: 'Computer', friend: 'Friend', online: 'Online', nearby: 'Nearby' };
const OUTCOME_NAMES: Record<Outcome, string> = { won: 'Won', lost: 'Lost', drawn: 'Draw', played: 'Played' };

function viewGame(id: GameId): void {
  if (settingsLocked()) return reject(undefined, 'locked');
  void openGameView(id).catch(showError);
}

function historyItem(entry: HistoryEntry): HTMLLIElement {
  const level = entry.difficulty === null ? '' : `, ${entry.difficulty}`;
  const opponent = entry.opponent === null ? '' : ` · vs ${entry.opponent.login}`;
  const title = `${OUTCOME_NAMES[entry.result]} · ${MODE_NAMES[entry.mode]}${level}`;
  const detail = `${entry.moves} moves${opponent} · ${ago(entry.finishedAt)}`;
  // A game stored before game links has no link to view.
  const id = entry.id;
  return id === null ? listItem(title, detail, undefined, () => undefined) : listItem(title, detail, 'View', () => viewGame(id));
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
      finishedAt: upload.finishedAt,
    });
  }
  return entries.sort((a, b) => b.finishedAt - a.finishedAt).slice(0, HISTORY_PAGE_SIZE);
}

function showHistory(entries: HistoryEntry[], append: boolean): void {
  if (!append) myGamesHistory.replaceChildren();
  myGamesHistory.append(...entries.map(historyItem));
  if (myGamesHistory.childElementCount === 0) myGamesHistory.innerHTML = '<li class="empty">No finished games yet.</li>';
}

let historyOffset = 0;

// The next page of the history from the server.
async function loadHistory(request: number, append: boolean): Promise<void> {
  const next = await api.history(append ? historyOffset : 0);
  if (request !== myGamesRequest) return;
  historyOffset = (append ? historyOffset : 0) + next.games.length;
  showHistory(next.games, append);
  myGamesMore.hidden = !next.more;
}

// Opening the dialog again while a list loads starts over, so a late answer never adds a second copy.
let myGamesRequest = 0;

async function openMyGames(): Promise<void> {
  const request = ++myGamesRequest;
  myGamesDialog.showModal();
  // Account
  accountBox.replaceChildren();
  if (page.account.user) {
    const avatar = document.createElement('img');
    avatar.className = 'avatar';
    avatar.src = `${page.account.user.avatar}&s=64`;
    avatar.alt = '';
    const name = document.createElement('b');
    name.textContent = page.account.user.login;
    const logout = document.createElement('button');
    logout.type = 'button';
    logout.textContent = 'Log out';
    logout.addEventListener('click', () => void api.logout().then(refreshAccount).then(() => myGamesDialog.close(), showError));
    accountBox.append(avatar, name, logout);
  } else if (page.account.loginAvailable && navigator.onLine) {
    const text = document.createElement('span');
    text.textContent = 'Log in to keep your games and stats on every device.';
    const login = document.createElement('a');
    login.className = 'login-link';
    login.href = api.loginUrl();
    login.textContent = 'Log in with GitHub';
    accountBox.append(text, login);
  }
  // Device sessions
  const deviceSessions = (await page.local?.list()) ?? [];
  if (request !== myGamesRequest) return;
  myGamesDevice.replaceChildren(
    ...deviceSessions
      .filter((entry) => entry.mode !== 'nearby')
      .map((entry) =>
        listItem(entry.name, `${entry.mode === 'computer' ? 'Computer' : 'Friend'} · ${gameCount(entry.games)} · ${ago(entry.updatedAt)}`, 'Open', () => {
          if (settingsLocked()) return reject(undefined, 'locked');
          void openDeviceSession(entry.code).catch(showError);
        }),
      ),
  );
  if (myGamesDevice.childElementCount === 0) myGamesDevice.innerHTML = '<li class="empty">No games on this device yet.</li>';
  // Server stats and online sessions
  myGamesStats.replaceChildren();
  myGamesOnline.replaceChildren();
  try {
    if (!navigator.onLine) throw new OnlineError('offline');
    const mine = await api.myGames();
    if (request !== myGamesRequest) return;
    myGamesNote.textContent = mine.user ? 'Your games on every device you logged in with.' : 'Your games on this browser.';
    myGamesStats.append(
      tallyBox('All games', mine.total),
      tallyBox('Online', mine.byMode.online),
      tallyBox('Computer', mine.byMode.computer),
      tallyBox('Nearby', mine.byMode.nearby),
      tallyBox('Friend', mine.byMode.friend),
    );
    myGamesOnline.append(
      ...mine.sessions.map((summary) =>
        listItem(
          summary.name,
          `vs ${summary.opponent?.login ?? 'Opponent'} · ${gameCount(summary.games)} · ${ago(summary.updatedAt)}`,
          'Continue',
          () => (settingsLocked() ? reject(undefined, 'locked') : void joinSession(summary.code)),
          summary.yourTurn ? 'Your turn' : undefined,
        ),
      ),
    );
    if (mine.sessions.length === 0) myGamesOnline.innerHTML = '<li class="empty">No online sessions yet.</li>';
    myGamesOnlineBox.hidden = false;
    await loadHistory(request, false);
    myGamesClear.hidden = historyOffset === 0;
  } catch (error) {
    if (!(error instanceof OnlineError)) throw error;
    const tallies = await deviceTallies();
    if (request !== myGamesRequest) return;
    myGamesNote.textContent = 'You are offline. These are the games on this device.';
    myGamesStats.append(tallyBox('Games on this device', tallies));
    myGamesOnlineBox.hidden = true;
    showHistory(await deviceHistory(), false);
    myGamesMore.hidden = true;
    // Clearing needs the server.
    myGamesClear.hidden = true;
  }
}

// Clears the history on the server (every device of the account) and the uploaded results on this device.
// The survival records stay: they are a best value per setup, kept apart from the history.
async function clearHistory(): Promise<void> {
  clearConfirmYes.disabled = true;
  try {
    // Upload what waits first, so a result that arrives later does not bring a cleared game back.
    await flushResults();
    await api.clearHistory();
    const db = page.deviceDb;
    if (db !== undefined) for (const result of await db.all('results')) if (result.sent) await db.delete('results', result.id);
    clearConfirm.close();
    historyOffset = 0;
    showHistory([], false);
    myGamesMore.hidden = true;
    myGamesClear.hidden = true;
    showToast('Your history is clear. Your survival records stay.');
  } finally {
    clearConfirmYes.disabled = false;
  }
}

// Asks the server who is logged in. Without a network the page keeps the last answer.
export async function refreshAccount(): Promise<void> {
  if (!navigator.onLine) return;
  try {
    page.account = await api.me();
    void syncRecords();
  } catch (error) {
    if (!(error instanceof OnlineError)) throw error;
  }
  render();
}

export function setupMyGames(): void {
  accountButton.addEventListener('click', () => void openMyGames().catch(showError));
  myGamesClose.addEventListener('click', () => myGamesDialog.close());
  myGamesMore.addEventListener('click', () => void loadHistory(myGamesRequest, true).catch(showError));
  myGamesClear.addEventListener('click', () => {
    clearConfirm.showModal();
    clearConfirmNo.focus();
  });
  clearConfirmNo.addEventListener('click', () => clearConfirm.close());
  clearConfirmYes.addEventListener('click', () => void clearHistory().catch(showError));
  clearConfirm.addEventListener('click', (event) => {
    if (event.target === clearConfirm) clearConfirm.close();
  });
  myGamesDialog.addEventListener('click', (event) => {
    if (event.target === myGamesDialog) myGamesDialog.close();
  });
}
