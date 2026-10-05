// Draws the whole page from the settings and the open session.
import { hasLimit } from '../clock.ts';
import { type Player, other, type Game, replay, toCoords, winnerOf } from '../game.ts';
import { applyCamera, cells, marks } from './board.ts';
import { renderChat } from './chat.ts';
import { renderClockEditor, renderClocks } from './clocks.ts';
import { startReview } from './controls.ts';
import {
  boardEl,
  boardHiddenEl,
  statusEl,
  reviewEl,
  reviewLabel,
  coordsForm,
  onlineCodeEl,
  shareButton,
  shareQrButton,
  sessionNameInput,
  joinCodeInput,
  newCodeButton,
  scoreEl,
  historyEl,
  newGameButton,
  advancedBox,
  tuningEl,
  undoButton,
  showCardButton,
  lockButton,
  soundButton,
} from './dom.ts';
import { openCard } from './end-card.ts';
import { renderGameView, viewerName } from './game-view.ts';
import { renderCoords } from './keypad.ts';
import { renderAccount } from './my-games.ts';
import { renderOnlineQr } from './online-box.ts';
import { settings, type Settings, type Toggle } from './settings.ts';
import { me, page, shared, current, isLive, matchOptions, settingsLocked, canChangeMatch } from './state.ts';

// Inline icons draw in the text color, so they follow the theme. Emoji do not.
const SPEAKER = '<path d="M4 9h4l5-4v14l-5-4H4z" fill="currentColor"/>';
const SOUND_ON_ICON = `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" aria-hidden="true">${SPEAKER}<path d="M16.5 9a4 4 0 0 1 0 6M19 6.5a7.5 7.5 0 0 1 0 11"/></svg>`;
const SOUND_OFF_ICON = `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" aria-hidden="true">${SPEAKER}<path d="M16 9.5l5 5M21 9.5l-5 5"/></svg>`;

// One name per seat, the same in the score, status, chat, clocks, keypad, history and end card.
// This screen's own seat is "You". Then come "Computer", the GitHub login and the generated name.
// A friend game has one player id on both seats, so its seats are "Player X" and "Player O".
// An older server or Nearby host sends no generated names: then the seat is "Player X" or "Player O".
export function playerName(player: Player): string {
  if (page.viewing !== undefined) return viewerName(page.viewing, player);
  const session = page.session;
  if (session === undefined || session.mode === 'friend') return `Player ${player}`;
  if (player === me()) return 'You';
  if (session.mode === 'computer') return 'Computer';
  return session.players[player]?.login ?? session.names[player] ?? `Player ${player}`;
}

// "You win!", or the winner's name: "Computer wins!", "braveOtter wins!", "Player X wins!".
const winText = (winner: Player) => (winner === me() ? 'You win!' : `${playerName(winner)} wins!`);

// The other player in a game with another device, when they took a seat but closed the game.
function awayPlayer(): Player | undefined {
  if (page.session === undefined || !shared() || page.session.you === null) return undefined;
  const opponent = other(page.session.you);
  return page.session.seats[opponent] && !page.session.presence[opponent] ? opponent : undefined;
}

function resultText(game: Game): string {
  switch (game.status.kind) {
    case 'won':
      return `${playerName(game.status.winner)} won`;
    case 'timeout':
      return `${playerName(game.status.winner)} won on time`;
    case 'draw':
      return 'Draw';
    case 'playing':
      return game === current() ? 'Live' : 'Not finished';
  }
}

function statusText(): string {
  const game = current();
  if (page.review) {
    const reviewed = page.games[page.review.game];
    return `Game ${page.review.game + 1} · move ${page.review.move} of ${reviewed?.moves.length ?? 0}`;
  }
  if (settings.mode === 'online' && page.session === undefined) {
    return navigator.onLine ? 'Create a game or enter a code' : 'You are offline. Online games need a connection.';
  }
  if (page.session === undefined) return 'Getting the game ready…';
  const mine = me();
  switch (game.status.kind) {
    case 'won':
      return winText(game.status.winner);
    case 'timeout': {
      if (mine !== null && game.status.winner !== mine) return 'You ran out of time.';
      return `${playerName(other(game.status.winner))} ran out of time. ${winText(game.status.winner)}`;
    }
    case 'draw':
      return 'Draw. The cube is full.';
    case 'playing':
      if (page.thinking) return 'Computer is thinking…';
      if (settings.mode === 'friend') return `Player ${game.turn} to move`;
      if (shared()) {
        if (page.session.you === null) return `Watching · ${playerName(game.turn)} to move`;
        const opponent = other(page.session.you);
        if (!page.session.seats[opponent]) {
          return page.session.mode === 'online' ? 'Waiting for a second player. Share the code.' : 'Waiting for a second device to join.';
        }
        // An async game goes on while a player is away: a move waits for them.
        const away = awayPlayer() !== undefined;
        if (game.turn === page.session.you) return away ? `Your move (${game.turn}) · ${playerName(opponent)} is away and sees it later` : `Your move (${game.turn})`;
        return away ? `${playerName(opponent)} is away · the game waits for their move` : `${playerName(opponent)}'s move (${game.turn})`;
      }
      return `Your move (${game.turn})`;
  }
}

function shownGame(): Game {
  if (page.review === undefined) return current();
  const reviewed = page.games[page.review.game];
  if (reviewed === undefined) throw new Error(`no game ${page.review.game} to review`);
  return replay(reviewed.moves.slice(0, page.review.move), { first: reviewed.first, clock: reviewed.clock });
}

export function render(): void {
  applyCamera();
  const game = shownGame();
  const live = page.review === undefined && isLive();
  const options = matchOptions();
  const hideBoard = options.hideBoard && live;
  const hideHistory = options.hideHistory && live;
  const frozen = settingsLocked();

  document.body.dataset.turn = game.turn;
  boardEl.className = `board ${settings.view} layout-${settings.layout}`;
  boardEl.classList.toggle('finished', game.status.kind !== 'playing');
  boardEl.classList.toggle('thinking', page.thinking || page.busy);
  boardEl.hidden = hideBoard;
  boardHiddenEl.hidden = !hideBoard;

  const winLine: readonly number[] = game.status.kind === 'won' ? game.status.line : [];
  const last = game.moves.at(-1);
  cells.forEach((button, cell) => {
    const actual = game.board[cell] ?? null;
    const mark = hideHistory && cell !== last ? null : actual;
    const { layer, row, column } = toCoords(cell);
    button.classList.toggle('x', mark === 'X');
    button.classList.toggle('o', mark === 'O');
    button.classList.toggle('win', winLine.includes(cell));
    button.classList.toggle('last', cell === last);
    const piece = marks[cell];
    if (piece) {
      piece.classList.toggle('x', mark === 'X');
      piece.classList.toggle('o', mark === 'O');
      piece.classList.toggle('win', winLine.includes(cell));
    }
    button.setAttribute('aria-label', `Layer ${layer + 1}, row ${row + 1}, column ${column + 1}: ${mark ?? 'empty'}`);
  });

  statusEl.textContent = statusText();
  statusEl.dataset.state = page.review ? 'review' : current().status.kind;

  reviewEl.hidden = page.review === undefined;
  if (page.review) reviewLabel.textContent = statusText();
  coordsForm.hidden = page.review !== undefined;
  renderCoords();
  renderChat();
  renderGameView();

  document.querySelectorAll<HTMLElement>('[data-show-mode]').forEach((field) => {
    field.hidden = field.dataset.showMode !== settings.mode;
  });
  document.querySelectorAll<HTMLElement>('[data-show-view]').forEach((field) => {
    field.hidden = field.dataset.showView !== settings.view;
  });
  document.querySelectorAll<HTMLElement>('.segmented').forEach((group) => {
    const value = settings[group.dataset.setting as keyof Settings];
    // Segmented controls exist for the text settings only (mode, level, view and the like).
    if (typeof value !== 'string') throw new Error(`segmented control for a setting that is not text: ${group.dataset.setting}`);
    group.querySelectorAll<HTMLButtonElement>('button').forEach((button) => {
      button.setAttribute('aria-pressed', String(button.dataset.value === value));
      button.disabled = frozen;
    });
  });
  document.querySelectorAll<HTMLButtonElement>('[data-toggle]').forEach((button) => {
    button.setAttribute('aria-pressed', String(options[button.dataset.toggle as Toggle]));
    button.disabled = frozen || page.busy || !canChangeMatch();
  });

  // Online box
  const onlineSession = page.session?.mode === 'online' ? page.session : undefined;
  onlineCodeEl.textContent = onlineSession?.code ?? '····';
  shareButton.disabled = onlineSession === undefined;
  shareQrButton.disabled = onlineSession === undefined;
  renderOnlineQr(onlineSession?.code);
  if (document.activeElement !== sessionNameInput) sessionNameInput.value = onlineSession?.name ?? '';
  sessionNameInput.disabled = onlineSession?.you == null || page.busy;
  joinCodeInput.disabled = frozen || page.busy;
  newCodeButton.disabled = frozen || page.busy;

  // Score: finished games of this session only.
  const score = { X: 0, O: 0, draw: 0 };
  for (const g of page.games) {
    const winner = winnerOf(g.status);
    if (winner !== null) score[winner]++;
    if (g.status.kind === 'draw') score.draw++;
  }
  const away = awayPlayer();
  scoreEl.replaceChildren(
    ...([
      ['X', playerName('X'), score.X],
      ['draw', 'Draws', score.draw],
      ['O', playerName('O'), score.O],
    ] as const).map(([key, label, value]) => {
      const tally = document.createElement('div');
      tally.className = `tally ${key}`;
      tally.classList.toggle('away', key === away);
      const count = document.createElement('b');
      count.textContent = String(value);
      const name = document.createElement('span');
      const info = key === 'draw' || page.session === undefined ? null : page.session.players[key];
      if (info) {
        const avatar = document.createElement('img');
        avatar.src = `${info.avatar}&s=48`;
        avatar.alt = '';
        avatar.className = 'avatar';
        name.append(avatar);
      }
      name.append(key === away ? `${label} · away` : label);
      tally.append(count, name);
      return tally;
    }),
  );

  historyEl.replaceChildren(
    ...page.games.map((g, index) => {
      const item = document.createElement('li');
      const reviewable = g !== current() || g.status.kind !== 'playing';
      item.innerHTML = `<span>Game ${index + 1}</span><span class="result">${resultText(g)} · ${g.moves.length} moves</span>`;
      if (reviewable) {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = page.review?.game === index ? 'Viewing' : 'Replay';
        button.addEventListener('click', () => startReview(index));
        item.append(button);
      }
      // A game from a link has no session for the card to describe.
      if (g.status.kind !== 'playing' && page.viewing === undefined) {
        const cardButton = document.createElement('button');
        cardButton.type = 'button';
        cardButton.textContent = 'Card';
        cardButton.addEventListener('click', () => void openCard(index));
        item.append(cardButton);
      }
      item.classList.toggle('active', page.review?.game === index);
      return item;
    }),
  );

  // With another device, a game must end before the next one starts.
  const sharedLive = shared() && isLive() && current().moves.length > 0;
  // A game from a link: New game goes back to play.
  newGameButton.disabled = page.viewing === undefined && (frozen || page.busy || page.thinking || page.session?.you == null || sharedLive);
  advancedBox.hidden = settings.mode !== 'computer';
  for (const input of tuningEl.querySelectorAll('input')) input.disabled = frozen;
  undoButton.hidden = settings.mode === 'online' || settings.mode === 'nearby';
  undoButton.disabled =
    frozen || page.thinking || page.review !== undefined || !isLive() || current().moves.length === 0 || hasLimit(current().clock);
  showCardButton.hidden = isLive() || page.review !== undefined;
  renderClockEditor(frozen);
  renderClocks();
  lockButton.disabled = frozen || page.busy || !isLive() || page.review !== undefined || !canChangeMatch();
  const lockScope = shared() ? ' for both players' : '';
  lockButton.textContent = frozen ? '🔒 Locked' : '🔓 Lock';
  lockButton.title = frozen ? `Settings are locked${lockScope} until this game ends.` : `Lock every setting${lockScope} until this game ends.`;
  lockButton.setAttribute('aria-pressed', String(frozen));
  renderAccount();
  soundButton.innerHTML = settings.muted ? SOUND_OFF_ICON : SOUND_ON_ICON;
  soundButton.setAttribute('aria-pressed', String(!settings.muted));
}
