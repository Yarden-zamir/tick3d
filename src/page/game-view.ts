// A finished game from its link (/?game=<id>), read-only: the final board with the replay
// controls, the players and the game details. No moves, and no next game.
import { describeClock } from '../clock.ts';
import { type Player, other, winnerOf } from '../game.ts';
import { api, OnlineError } from '../online.ts';
import { type GameId, type PublicGame, parseResultUpload, toGame } from '../protocol.ts';
import { gameViewEl, gameViewTitle, gameViewPlayers, gameViewDetails, gameViewPlay, reviewExit } from './dom.ts';
import { showError, showProblem } from './feedback.ts';
import { openNearby } from './nearby.ts';
import { render } from './render.ts';
import { hideLabel } from './results.ts';
import { beginSwitch, leaveSession, openLocalSession, setUrlGame } from './sessions.ts';
import { settings } from './settings.ts';
import { page } from './state.ts';

// The device's own copy, so a game that is not uploaded yet opens too, also offline.
async function deviceCopy(id: GameId): Promise<PublicGame | undefined> {
  for (const { upload } of (await page.deviceDb?.all('results')) ?? []) {
    if (upload.publicId !== id) continue;
    // The same check as on the server, so a result from an older version gets its defaults.
    const result = parseResultUpload(upload, Infinity);
    if (result === undefined) throw new Error(`the stored result of game ${id} does not parse`);
    const seatInfo = (seat: Player) => (result.you === null || result.you === seat ? page.account.user : null);
    return {
      id,
      mode: result.mode,
      game: result.game,
      options: result.options,
      difficulty: result.difficulty,
      tuned: result.tuned,
      computer: result.mode === 'computer' && result.you !== null ? other(result.you) : null,
      players: { X: seatInfo('X'), O: seatInfo('O') },
      finishedAt: result.finishedAt,
    };
  }
  return undefined;
}

// Opens the game of a link. Returns false when it opens nothing: the problem shows already, or
// the player chose another game meanwhile.
export async function openGameView(id: GameId): Promise<boolean> {
  const switchNumber = beginSwitch();
  let shown: PublicGame;
  try {
    shown = (await deviceCopy(id)) ?? (await api.game(id));
  } catch (error) {
    if (!(error instanceof OnlineError)) throw error;
    showProblem(error.status === undefined ? 'This game is not on this device. Open its link with a network.' : error.message);
    return false;
  }
  if (switchNumber !== page.navigation) return false;
  leaveSession();
  page.viewing = shown;
  const game = toGame(shown.game);
  page.games = [game];
  // The replay controls start at the final position.
  page.review = { game: 0, move: game.moves.length };
  setUrlGame(id);
  render();
  return true;
}

// Back to play: the screen's own mode, as on a first visit.
export async function closeGameView(): Promise<void> {
  leaveSession();
  page.review = undefined;
  render();
  if (settings.mode === 'online') return;
  if (settings.mode === 'nearby') return openNearby();
  await openLocalSession(settings.mode);
}

export function viewerName(shown: PublicGame, seat: Player): string {
  if (shown.computer === seat) return 'Computer';
  return shown.players[seat]?.login ?? (shown.mode === 'friend' ? `Player ${seat}` : 'Anonymous');
}

function modeLabel(shown: PublicGame): string {
  switch (shown.mode) {
    case 'computer': {
      const level = shown.difficulty === null ? '' : ` · ${shown.difficulty[0]?.toUpperCase()}${shown.difficulty.slice(1)}`;
      return `vs Computer${level}${shown.tuned ? ' (tuned)' : ''}`;
    }
    case 'online':
      return `Online · game ${shown.id.split('-')[1] ?? ''} of session ${shown.id.split('-')[0] ?? ''}`;
    case 'nearby':
      return 'Nearby';
    case 'friend':
      return 'Two players, one screen';
  }
}

export function renderGameView(): void {
  const shown = page.viewing;
  gameViewEl.hidden = shown === undefined;
  // The game has no live position to go back to.
  reviewExit.hidden = shown !== undefined;
  if (shown === undefined) return;
  const game = toGame(shown.game);
  const winner = winnerOf(game.status);
  gameViewTitle.textContent = winner === null ? 'Draw' : `${viewerName(shown, winner)} won${game.status.kind === 'timeout' ? ' on time' : ''}`;
  gameViewPlayers.textContent = `${viewerName(shown, 'X')} (X) vs ${viewerName(shown, 'O')} (O)`;
  const date = new Date(shown.finishedAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  gameViewDetails.textContent = [modeLabel(shown), `${game.moves.length} moves`, describeClock(game.clock), hideLabel(shown.options), date]
    .filter((part) => part !== undefined)
    .join(' · ');
}

export function setupGameView(): void {
  gameViewPlay.addEventListener('click', () => void closeGameView().catch(showError));
}
