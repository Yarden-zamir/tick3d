// The end of a game: sounds, confetti, and the end card.
import { type CardInput, cardCellBox, cardFilename, drawCard, shareImage, saveImage } from '../card.ts';
import { formatClock, describeClock } from '../clock.ts';
import { type Game, other, winnerOf } from '../game.ts';
import { isTunedFor } from '../tuning.ts';
import { sounds } from '../sound.ts';
import { computerTuning } from './advanced.ts';
import {
  cardDialog,
  myGamesDialog,
  homeConfirm,
  seatPrompt,
  burstEl,
  cardCode,
  cardLink,
  cardCodeOption,
  cardImage,
  cardNewGameButton,
  newGameButton,
  cardShareButton,
  cardSaveButton,
  cardSongButton,
  cardLight,
  cardVoiceOption,
  cardVoice,
  cardCloseButton,
  showCardButton,
} from './dom.ts';
import { showToast } from './feedback.ts';
import { previewsDialog } from '../header/previews.ts';
import { type GameId, onlineGameId } from '../protocol.ts';
import { nearbyKind, shareGameLink } from './nearby.ts';
import { recordResult, noteSurvival, recordNews, hideLabel, gameIdOf, sendOnlineMetrics, hostLinkOf, setHostLink } from './results.ts';
import { setUrlGame, startNewGame } from './sessions.ts';
import { playerName, seatNow } from './render.ts';
import { settings } from './settings.ts';
import { songControl } from './song-control.ts';
import { lightSungCell } from './board.ts';
import { voiceClips } from './voice.ts';
import { type Session, me, page, isLive, matchOptions } from './state.ts';

const CARD_DELAY_MS = 1400;
let card: { index: number; canvas: HTMLCanvasElement; gameId: GameId | undefined } | undefined;

// Plays the sound for the last move of the live game, and the result if the move ended it.
export function announce(game: Game): void {
  const last = game.moves.at(-1);
  if (last === undefined) return;
  sounds.place(other(game.turn), last);
  if (game.status.kind !== 'playing') finish(game);
}

// The live game just ended: result sound, celebration, and the end card a moment later.
export function finish(game: Game): void {
  const winner = winnerOf(game.status);
  const mine = me();
  if (winner === null) sounds.draw();
  else if (mine !== null && winner !== mine) sounds.lose();
  else {
    sounds.win();
    celebrate();
  }
  const index = page.games.length - 1;
  if (page.session !== undefined) void linkGame(page.session, game, index);
  if (page.session?.mode === 'computer' && winner !== null && mine !== null && winner !== mine) noteSurvival(page.session, game, index);
  setTimeout(() => {
    // Show the card only if that game is still the finished live game and nothing else is open.
    if (page.games.length - 1 !== index || isLive() || page.review !== undefined) return;
    if (cardDialog.open || myGamesDialog.open || previewsDialog.open || homeConfirm.open || seatPrompt.open) return;
    void openCard(index);
  }, CARD_DELAY_MS);
}

// Saves the result of a game that just ended and puts the link of the game in the address.
async function linkGame(open: Session, game: Game, index: number): Promise<void> {
  sendOnlineMetrics(open, index);
  const device = open.mode === 'online' ? undefined : await recordResult(open, game, index);
  // A Nearby host gives its link to the guests. A guest uses the host's link when it came already.
  if (device !== undefined && open.mode === 'nearby' && nearbyKind() === 'hosting') shareGameLink(index, device);
  const own = open.mode === 'online' ? onlineGameId(open.code, index) : device;
  const id = (open.mode === 'nearby' ? hostLinkOf(open.code, index) : undefined) ?? own;
  // The player can move on while the result saves. Only the same finished game gets the link.
  if (id !== undefined && showsFinished(open, index)) setUrlGame(id);
}

const showsFinished = (open: Session, index: number) => page.session?.code === open.code && page.games.length - 1 === index && !isLive();

// A Nearby guest got the link of a finished game from the host: the address and the end card use it.
export function useHostLink(open: Session, index: number, id: GameId): void {
  setHostLink(open.code, index, id);
  if (showsFinished(open, index)) setUrlGame(id);
  if (card?.index === index && cardDialog.open) void openCard(index);
}

// The confetti animation lasts 1.4 s after a delay of up to 0.12 s.
const CONFETTI_MS = 1600;
let confettiTimer: ReturnType<typeof setTimeout> | undefined;

function celebrate(): void {
  const css = getComputedStyle(document.documentElement);
  const colors = ['--x', '--primary', '--o', '--toggle-on', '--win'].map((name) => css.getPropertyValue(name).trim());
  burstEl.replaceChildren(
    ...Array.from({ length: 36 }, (_, i) => {
      const spark = document.createElement('span');
      const angle = (i / 36) * Math.PI * 2;
      const distance = 120 + Math.random() * 160;
      spark.style.setProperty('--x', `${Math.cos(angle) * distance}px`);
      spark.style.setProperty('--y', `${Math.sin(angle) * distance}px`);
      spark.style.setProperty('--c', colors[i % colors.length] ?? '#fff');
      spark.style.animationDelay = `${Math.random() * 120}ms`;
      return spark;
    }),
  );
  // Spent sparks would stay in the page, invisible, so remove them.
  clearTimeout(confettiTimer);
  confettiTimer = setTimeout(() => burstEl.replaceChildren(), CONFETTI_MS);
}

function cardInput(game: Game, index: number, gameId: GameId | undefined): CardInput {
  // The seats can rotate between games: `winner` is the seat now of the player who won game `index`.
  const result = winnerOf(game.status);
  const winner = result === null ? null : seatNow(index, result);
  const mine = me();
  // The same names as the rest of the page (playerName), so the card matches the score and the chat.
  const title = winner === null ? 'Draw' : winner === mine ? 'You win!' : `${playerName(winner)} wins!`;
  const subtitle =
    game.status.kind === 'won'
      ? `Four in a row in ${game.moves.length} moves`
      : game.status.kind === 'timeout' && winner !== null
        ? `${playerName(other(winner))} ran out of time after ${game.moves.length} moves`
        : 'The cube is full. Nobody got four in a row.';
  const level = `${settings.difficulty.charAt(0).toUpperCase()}${settings.difficulty.slice(1)}${isTunedFor(computerTuning(), settings.difficulty) ? ' (tuned)' : ''}`;
  const matchup =
    page.session?.mode === 'computer'
      ? `vs Computer · ${level} · You played ${seatNow(index, page.session.you ?? settings.human)}`
      : page.session?.mode === 'online'
        ? `Online · ${page.session.name}`
        : page.session?.mode === 'nearby'
          ? `Nearby · ${page.session.name}`
          : 'Two players, one screen';
  const first = game.times[0] ?? 0;
  const last = game.times.at(-1) ?? 0;
  const duration = first > 0 && last > first ? ` · Game time ${formatClock(last - first)}` : '';
  const onlineCode = page.session?.mode === 'online' ? page.session.code : undefined;
  const news = page.session === undefined ? undefined : recordNews.get(`${page.session.code}:${index}`);
  // The link of this game, else the session, else the site.
  const link = gameId ? `${location.host}/?game=${gameId}` : onlineCode ? `${location.host}/?code=${onlineCode}` : location.host;
  return {
    game,
    title,
    subtitle,
    matchup,
    details: [`Game ${index + 1}`, describeClock(game.clock), hideLabel(matchOptions())].filter((part) => part !== undefined).join(' · ') + duration,
    date: new Date(last > 0 ? last - page.serverOffset : Date.now()),
    footer: [onlineCode && cardCode.checked ? `Code ${onlineCode}` : '', cardLink.checked ? link : '']
      .filter((part) => part !== '')
      .join(' · '),
    ...(news === undefined ? {} : { record: news }),
  };
}

export async function openCard(index: number): Promise<void> {
  const game = page.games[index];
  if (game === undefined || game.status.kind === 'playing') throw new Error(`game ${index} has no result to show`);
  // A local game has no code, so only the link option applies.
  cardCodeOption.hidden = page.session?.mode !== 'online';
  cardVoiceOption.hidden = voiceClips(index).size === 0;
  // "Include my voice" is off each time the card opens. A redraw of the open card keeps the choice.
  if (!cardDialog.open) cardVoice.checked = false;
  const gameId = page.session === undefined ? undefined : await gameIdOf(page.session, index);
  const input = cardInput(game, index, gameId);
  const canvas = await drawCard(input);
  card = { index, canvas, gameId };
  cardImage.src = canvas.toDataURL('image/png');
  // A title such as "You win!" ends with its own mark.
  const titleText = input.title.endsWith('!') ? input.title : `${input.title}.`;
  cardImage.alt = `${titleText} ${input.subtitle}.${input.record ? ` New record: ${input.record.moves} moves.` : ''}`;
  // Only the newest game can start the next one. A card of an older game has no New game button.
  cardNewGameButton.hidden = index !== page.games.length - 1;
  cardNewGameButton.disabled = newGameButton.disabled;
  if (!cardDialog.open) cardDialog.showModal();
}


// Lights a cell of the card image while the song plays: a box over the image, placed in shares of its size.
function lightCardCell(cell: number | undefined): void {
  cardLight.hidden = cell === undefined;
  if (cell === undefined) return;
  const box = cardCellBox(cell);
  cardLight.style.left = `${box.left * 100}%`;
  cardLight.style.top = `${box.top * 100}%`;
  cardLight.style.width = `${box.width * 100}%`;
  cardLight.style.height = `${box.height * 100}%`;
}

export function setupEndCard(): void {
  const song = songControl(cardSongButton, () => {
    if (card === undefined) return undefined;
    const game = page.games[card.index];
    if (game === undefined) return undefined;
    const input = cardInput(game, card.index, card.gameId);
    // The board behind the card shows the same game only when the card is of the newest game.
    const onBoard = card.index === page.games.length - 1 && page.review === undefined;
    const light = (cell: number | undefined) => {
      lightCardCell(cell);
      if (onBoard) lightSungCell(cell);
    };
    return { game, filename: cardFilename('wav'), text: `${input.title}: ${input.subtitle} on tick3d, as a song.`, light, clips: voiceClips(card.index), shareVoice: cardVoice.checked };
  });
  cardDialog.addEventListener('close', song.stop);
  cardShareButton.addEventListener('click', () => {
    if (card === undefined) return;
    const { canvas, index, gameId } = card;
    const game = page.games[index];
    if (game === undefined) return;
    const input = cardInput(game, index, gameId);
    const isOnline = page.session?.mode === 'online';
    const gameLink = gameId === undefined ? undefined : `${location.origin}/?game=${gameId}`;
    const url = cardLink.checked ? (gameLink ?? (isOnline ? location.href : location.origin)) : undefined;
    const code = cardCode.checked && isOnline && page.session ? ` Code ${page.session.code}.` : '';
    void shareImage(canvas, cardFilename('png'), `${input.title}: ${input.subtitle} on tick3d.${code}`, url).then((outcome) => {
      if (outcome === 'copied') showToast('Image copied. Paste it anywhere.');
      if (outcome === 'saved') showToast('Image saved.');
    });
  });

  cardSaveButton.addEventListener('click', () => {
    if (card !== undefined) void saveImage(card.canvas, cardFilename('png'));
  });
  cardCloseButton.addEventListener('click', () => cardDialog.close());
  cardNewGameButton.addEventListener('click', () => {
    cardDialog.close();
    startNewGame();
  });
  for (const option of [cardCode, cardLink]) {
    option.addEventListener('change', () => {
      if (card !== undefined) void openCard(card.index);
    });
  }
  // A click on the dimmed backdrop lands on the dialog element itself.
  cardDialog.addEventListener('click', (event) => {
    if (event.target === cardDialog) cardDialog.close();
  });
  showCardButton.addEventListener('click', () => {
    if (!isLive()) void openCard(page.games.length - 1);
  });
}
