// Draws the whole page from the settings and the open session.
import { hasLimit } from '../clock.ts';
import { showSegmented } from '../board/view-controls.ts';
import { type Player, other, type Game, replay, toCoords, winnerOf } from '../game.ts';
import { applyCamera, cells, marks } from './board.ts';
import { renderChat } from './chat.ts';
import { renderClockEditor, renderClocks } from './clocks.ts';
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
  newGameButton,
  tuningEl,
  undoButton,
  showCardButton,
  lockButton,
  soundButton,
  trainLink,
} from './dom.ts';
import { renderGameView, viewerName } from './game-view.ts';
import { renderCoords } from './keypad.ts';
import { renderSessionGames } from './my-games.ts';
import { showAccount } from '../header/header.ts';
import { LOCK_CLOSED_ICON, LOCK_OPEN_ICON, SOUND_OFF_ICON, SOUND_ON_ICON } from '../icons.ts';
import { nearbyKind } from './nearby.ts';
import { renderOnlineQr } from './online-box.ts';
import { renderPlayers } from './players.ts';
import { settings, type Toggle } from './settings.ts';
import { syncVoice } from './voice.ts';
import { me, page, shared, current, isLive, isWatching, matchOptions, settingsLocked, canChangeMatch, bothSeated } from './state.ts';

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

export function resultText(game: Game): string {
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

// The status in Nearby mode before a game opens, by the Nearby step of this device.
const NEARBY_STEPS: Record<ReturnType<typeof nearbyKind>, string> = {
  idle: 'Host a game, or join one.',
  starting: 'Starting the game…',
  joining: 'Connecting to the host…',
  guest: 'Joining the game…',
  // The host opens its session before it counts as hosting, so this shows only for a moment.
  hosting: 'Starting the game…',
};

function statusText(): string {
  const game = current();
  if (page.review) {
    const reviewed = page.games[page.review.game];
    return `Game ${page.review.game + 1} · move ${page.review.move} of ${reviewed?.moves.length ?? 0}`;
  }
  if (settings.mode === 'online' && page.session === undefined) {
    return navigator.onLine ? 'Create a game or enter a code' : 'You are offline. Online games need a connection.';
  }
  if (settings.mode === 'nearby' && page.session === undefined) return NEARBY_STEPS[nearbyKind()];
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

// Why Undo cannot run now, or undefined. With another device, only the own last move can go back,
// and the other player must accept (src/page/players.ts). The session rules check the same again.
function undoProblemText(): string | undefined {
  const game = current();
  if (!isLive()) return 'The game is over.';
  if (game.moves.length === 0) return 'No move to take back yet.';
  if (hasLimit(game.clock)) return 'A timed game has no undo.';
  if (!shared()) return undefined;
  if (page.session?.you == null) return 'Only the two players can undo.';
  if (game.turn === page.session.you) return 'Only your own last move can go back, before the other player moves.';
  if (page.session.seatRequest !== null) return 'Wait for the open request first.';
  return undefined;
}

// A panel control shows only where it applies (see the table in README "Controls per mode").
// data-show-mode lists the modes of a control, and such a control is for play, so a game from a link
// hides it. data-needs-session marks a control of an open game, which online and Nearby mode have
// only after a create, a join or a host.
function applies(field: HTMLElement): boolean {
  const modes = field.dataset.showMode;
  if (modes !== undefined && (page.viewing !== undefined || !modes.split(' ').includes(settings.mode))) return false;
  const waiting = page.session === undefined && page.viewing === undefined && (settings.mode === 'online' || settings.mode === 'nearby');
  return !(field.dataset.needsSession !== undefined && waiting);
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
  renderPlayers();
  renderGameView();

  document.querySelectorAll<HTMLElement>('[data-show-mode], [data-needs-session]').forEach((field) => {
    field.hidden = !applies(field);
  });
  showSegmented(document, settings, frozen);
  document.querySelectorAll<HTMLButtonElement>('[data-toggle]').forEach((button) => {
    button.setAttribute('aria-pressed', String(options[button.dataset.toggle as Toggle]));
    button.disabled = frozen || page.busy || !canChangeMatch();
  });
  // With the coordinates hidden, the game goes by ear: the ear training link stands out.
  trainLink.classList.toggle('highlight', options.hideCoordinates);

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

  renderSessionGames();

  // With another device, a game must end before the next one starts.
  const sharedLive = shared() && isLive() && current().moves.length > 0;
  // A game from a link: New game goes back to play.
  newGameButton.disabled = page.viewing === undefined && (frozen || page.busy || page.thinking || page.session?.you == null || sharedLive);
  for (const input of tuningEl.querySelectorAll('input')) input.disabled = frozen;
  const undoProblem = undoProblemText();
  undoButton.disabled = frozen || page.thinking || page.busy || page.review !== undefined || undoProblem !== undefined;
  undoButton.title = undoProblem ?? (shared() ? 'Ask the other player to take back your last move.' : 'Take back the last move.');
  // Undo is for a live game, and the result card for a finished one. So they share one place in the actions row.
  // A watcher has no move to take back, so a watcher sees no Undo at all.
  if (!isLive() || isWatching()) undoButton.hidden = true;
  showCardButton.hidden = isLive() || page.review !== undefined;
  renderClockEditor(frozen);
  renderClocks();
  // A watcher sees the lock of the session, but the lock does not hold the watcher's own settings.
  const locked = page.session?.locked ?? false;
  // A held lock stays enabled, so its tooltip shows on hover. A click on it changes nothing.
  lockButton.disabled = !locked && (page.busy || !isLive() || page.review !== undefined || !canChangeMatch() || !bothSeated());
  const lockScope = shared() ? ' for both players' : '';
  lockButton.dataset.tip = locked
    ? `Locked${lockScope} until this game ends. Leaving stays possible.`
    : bothSeated()
      ? `Lock${lockScope}: no setting changes (level, time limit, hide options, view) until this game ends. Leaving stays possible.`
      : 'Lock: waits for the second player.';
  lockButton.innerHTML = locked ? `${LOCK_CLOSED_ICON}<span>Locked</span>` : `${LOCK_OPEN_ICON}<span>Lock</span>`;
  lockButton.setAttribute('aria-pressed', String(locked));
  showAccount(page.account.user);
  soundButton.innerHTML = settings.muted ? SOUND_OFF_ICON : SOUND_ON_ICON;
  soundButton.setAttribute('aria-pressed', String(!settings.muted));
  syncVoice();
}
