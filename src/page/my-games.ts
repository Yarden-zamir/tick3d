// The account button and the My games dialog.
import { winnerOf } from '../game.ts';
import { api, OnlineError } from '../online.ts';
import { type Tally, toGame } from '../protocol.ts';
import {
  accountAvatar,
  accountName,
  accountButton,
  myGamesDialog,
  accountBox,
  myGamesDevice,
  myGamesStats,
  myGamesOnline,
  myGamesNote,
  myGamesOnlineBox,
  myGamesClose,
} from './dom.ts';
import { showError, reject } from './feedback.ts';
import { render } from './render.ts';
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

function listItem(title: string, detail: string, action: string, onClick: () => void, badge?: string): HTMLLIElement {
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
    const winner = winnerOf(toGame(upload.game).status);
    tally[winner === null ? 'drawn' : winner === upload.you ? 'won' : 'lost']++;
  }
  return tally;
}

const gameCount = (count: number) => `${count} ${count === 1 ? 'game' : 'games'}`;

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
  } catch (error) {
    if (!(error instanceof OnlineError)) throw error;
    const tallies = await deviceTallies();
    if (request !== myGamesRequest) return;
    myGamesNote.textContent = 'You are offline. These are the games on this device.';
    myGamesStats.append(tallyBox('Games on this device', tallies));
    myGamesOnlineBox.hidden = true;
  }
}

// Asks the server who is logged in. Without a network the page keeps the last answer.
export async function refreshAccount(): Promise<void> {
  if (!navigator.onLine) return;
  try {
    page.account = await api.me();
  } catch (error) {
    if (!(error instanceof OnlineError)) throw error;
  }
  render();
}

export function setupMyGames(): void {
  accountButton.addEventListener('click', () => void openMyGames().catch(showError));
  myGamesClose.addEventListener('click', () => myGamesDialog.close());
  myGamesDialog.addEventListener('click', (event) => {
    if (event.target === myGamesDialog) myGamesDialog.close();
  });
}
