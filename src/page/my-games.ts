// The account button and the My games dialog.
import { winnerOf } from '../game.ts';
import { nameOf } from '../names.ts';
import { type Me, api, OnlineError, token } from '../online.ts';
import {
  type GameId,
  HISTORY_PAGE_SIZE,
  type HistoryEntry,
  type Outcome,
  type SessionMode,
  type SessionSummary,
  type Tally,
  CUSTOM_NAME_MAX_LENGTH,
  CUSTOM_NAME_MIN_LENGTH,
  outcomeOf,
  parseCustomName,
  toGame,
} from '../protocol.ts';
import { accountLink } from '../header/header.ts';
import {
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
  myGamesSession,
  myGamesSessionBox,
} from './dom.ts';
import { showError, reject } from './feedback.ts';
import { openGameView } from './game-view.ts';
import { startReview } from './controls.ts';
import { openCard } from './end-card.ts';
import { render, resultText } from './render.ts';
import { deleteSentResults, flushResults, forgetRecords, syncRecords } from './results.ts';
import { openDeviceSession, joinSession, refresh } from './sessions.ts';
import { ownName, page, current, saveAccount, settingsLocked } from './state.ts';

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

// A button of a list item. A click closes the dialog first.
type Action = { label: string; run: () => void };

function listItem(title: string, detail: string, actions: readonly Action[], badge?: string): HTMLLIElement {
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
function opponentOf(summary: SessionSummary): string {
  const name = summary.opponent?.login ?? summary.opponentName;
  return name === null ? 'Waiting for a second player' : `vs ${name}`;
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
  const opponentName = entry.opponent?.login ?? entry.opponentName;
  const opponent = opponentName === null ? '' : ` · vs ${opponentName}`;
  const title = `${OUTCOME_NAMES[entry.result]} · ${MODE_NAMES[entry.mode]}${level}`;
  const detail = `${entry.moves} moves${opponent} · ${ago(entry.finishedAt)}`;
  // A game stored before game links has no link to view.
  const id = entry.id;
  return listItem(title, detail, id === null ? [] : [{ label: 'View', run: () => viewGame(id) }]);
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

// `returnTo` is the page that a GitHub login returns to. Without it, the login returns to this page.
export async function openMyGames(returnTo?: string): Promise<void> {
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
    accountBox.append(text);
    if (navigator.onLine) accountBox.append(renameControls());
    if (page.account.loginAvailable && navigator.onLine) {
      text.append(' Log in with GitHub to use your GitHub name.');
      const login = document.createElement('a');
      login.className = 'btn btn-small btn-primary login-link';
      login.href = api.loginUrl(returnTo);
      login.textContent = 'Log in with GitHub';
      accountBox.append(login);
    }
  }
  // Device sessions
  const deviceSessions = (await page.local?.list()) ?? [];
  if (request !== myGamesRequest) return;
  myGamesDevice.replaceChildren(
    ...deviceSessions
      .filter((entry) => entry.mode !== 'nearby')
      .map((entry) =>
        listItem(entry.name, `${entry.mode === 'computer' ? 'Computer' : 'Friend'} · ${gameCount(entry.games)} · ${ago(entry.updatedAt)}`, [
          {
            label: 'Open',
            run: () => {
              if (settingsLocked()) return reject(undefined, 'locked');
              void openDeviceSession(entry.code).catch(showError);
            },
          },
        ]),
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
          `${opponentOf(summary)} · ${gameCount(summary.games)} · ${ago(summary.updatedAt)}`,
          [{ label: 'Continue', run: () => (settingsLocked() ? reject(undefined, 'locked') : void joinSession(summary.code)) }],
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
    await deleteSentResults();
    clearConfirm.close();
    historyOffset = 0;
    // The dialog covers the toasts, so the list itself says what happened.
    myGamesHistory.innerHTML = '<li class="empty">History cleared. Your survival records stay.</li>';
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
  const db = page.deviceDb;
  if (db !== undefined) for (const cached of await db.all('remote')) await db.delete('remote', cached.code);
  await refreshAccount();
}

// The games of the open session, oldest first, with Replay and the result card. render() calls this,
// so the list stays current while the dialog is open. A game from a link has no session here.
export function renderSessionGames(): void {
  myGamesSessionBox.hidden = page.session === undefined;
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
    saveAccount(await api.me());
    void syncRecords();
  } catch (error) {
    if (!(error instanceof OnlineError)) throw error;
  }
  render();
}

export function setupMyGames(): void {
  // The account button is a link to the My games request (src/header/my-games-link.ts). Here it opens
  // the dialog at once. A modified click opens a new tab, as for any link, and the dialog opens there.
  accountLink.addEventListener('click', (event) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    void openMyGames().catch(showError);
  });
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
