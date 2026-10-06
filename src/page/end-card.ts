// The end of a game: sounds, confetti, and the end card.
import { type CardInput, drawCard, shareImage, saveImage, shareFile } from '../card.ts';
import { formatClock, describeClock } from '../clock.ts';
import { type Game, other, winnerOf } from '../game.ts';
import { isTunedFor } from '../tuning.ts';
import { SOUND_ON_ICON } from '../icons.ts';
import { songOf } from '../song.ts';
import { playSong, renderSong, sounds } from '../sound.ts';
import { encodeWav } from '../wav.ts';
import { computerTuning } from './advanced.ts';
import {
  cardDialog,
  myGamesDialog,
  homeConfirm,
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
  cardCloseButton,
  showCardButton,
} from './dom.ts';
import { showToast } from './feedback.ts';
import { previewsDialog } from '../header/previews.ts';
import { type GameId, onlineGameId } from '../protocol.ts';
import { nearbyKind, shareGameLink } from './nearby.ts';
import { recordResult, noteSurvival, recordNews, hideLabel, gameIdOf, sendOnlineMetrics, hostLinkOf, setHostLink } from './results.ts';
import { setUrlGame, startNewGame } from './sessions.ts';
import { playerName } from './render.ts';
import { settings } from './settings.ts';
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
    if (cardDialog.open || myGamesDialog.open || previewsDialog.open || homeConfirm.open) return;
    void openCard(index);
  }, CARD_DELAY_MS);
}

// Saves the result of a game that just ended and puts the link of the game in the address.
async function linkGame(open: Session, game: Game, index: number): Promise<void> {
  sendOnlineMetrics(open, index);
  const own = open.mode === 'online' ? onlineGameId(open.code, index) : await recordResult(open, game, index);
  // A Nearby host gives its link to the guests. A guest uses the host's link when it came already.
  if (own !== undefined && open.mode === 'nearby' && nearbyKind() === 'hosting') shareGameLink(index, own);
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
  const winner = winnerOf(game.status);
  const mine = me();
  // The same names as the rest of the page (playerName), so the card matches the score and the chat.
  const title = winner === null ? 'Draw' : winner === mine ? 'You win!' : `${playerName(winner)} wins!`;
  const subtitle =
    game.status.kind === 'won'
      ? `Four in a row in ${game.moves.length} moves`
      : game.status.kind === 'timeout'
        ? `${playerName(other(game.status.winner))} ran out of time after ${game.moves.length} moves`
        : 'The cube is full. Nobody got four in a row.';
  const level = `${settings.difficulty.charAt(0).toUpperCase()}${settings.difficulty.slice(1)}${isTunedFor(computerTuning(), settings.difficulty) ? ' (tuned)' : ''}`;
  const matchup =
    page.session?.mode === 'computer'
      ? `vs Computer · ${level} · You played ${page.session.you ?? settings.human}`
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

function cardFilename(extension: 'png' | 'wav'): string {
  return `tick3d-${new Date().toISOString().slice(0, 10)}.${extension}`;
}

// ---- The game as a song ----

// A press this long on the song button shares the song as a file.
const LONG_PRESS_MS = 600;
type SongState = 'idle' | 'playing' | 'held' | 'rendering';
const SONG_LABELS: Record<SongState, string> = { idle: 'Song', playing: 'Playing…', held: 'Release to share', rendering: 'Making the file…' };
// A pointer press on the song button. `file` is the render that starts when the press becomes long.
type SongPress = { timer: ReturnType<typeof setTimeout>; file: Promise<File> | undefined };
let songPress: SongPress | undefined;
let songTimer: ReturnType<typeof setTimeout> | undefined;

function showSongState(state: SongState): void {
  cardSongButton.dataset.state = state;
  cardSongButton.innerHTML = `${SOUND_ON_ICON}<span>${SONG_LABELS[state]}</span>`;
}

function cardGame(): { game: Game; index: number; gameId: GameId | undefined } | undefined {
  if (card === undefined) return undefined;
  const game = page.games[card.index];
  return game === undefined ? undefined : { game, index: card.index, gameId: card.gameId };
}

function playCardSong(): void {
  const shown = cardGame();
  if (shown === undefined || cardSongButton.dataset.state !== 'idle') return;
  if (settings.muted) return showToast('Turn the sound on to hear the song.');
  const song = songOf(shown.game);
  playSong(song);
  showSongState('playing');
  clearTimeout(songTimer);
  songTimer = setTimeout(() => showSongState('idle'), song.duration * 1000);
}

// Renders the song offline with the voices of live play, into a WAV file named like the card image.
async function songFile(game: Game): Promise<File> {
  const buffer = await renderSong(songOf(game));
  const channels = Array.from({ length: buffer.numberOfChannels }, (_, channel) => buffer.getChannelData(channel));
  return new File([encodeWav(channels, buffer.sampleRate)], cardFilename('wav'), { type: 'audio/wav' });
}

async function shareSong(file: Promise<File>): Promise<void> {
  const shown = cardGame();
  if (shown === undefined) return;
  const input = cardInput(shown.game, shown.index, shown.gameId);
  showSongState('rendering');
  try {
    const outcome = await shareFile(await file, `${input.title}: ${input.subtitle} on tick3d, as a song.`);
    if (outcome === 'saved') showToast('Song saved as a sound file.');
  } finally {
    showSongState('idle');
  }
}

function endSongPress(): void {
  if (songPress === undefined) return;
  clearTimeout(songPress.timer);
  if (songPress.file === undefined) songPress = undefined;
  else if (cardSongButton.dataset.state === 'held') showSongState('idle');
}

function setupSong(): void {
  showSongState('idle');
  cardSongButton.addEventListener('pointerdown', (event) => {
    if (!event.isPrimary || event.button !== 0 || cardSongButton.dataset.state !== 'idle') return;
    const shown = cardGame();
    if (shown === undefined) return;
    const press: SongPress = {
      file: undefined,
      timer: setTimeout(() => {
        // The render starts during the press, so the file is ready soon after the release.
        press.file = songFile(shown.game);
        showSongState('held');
      }, LONG_PRESS_MS),
    };
    songPress = press;
  });
  // A touch browser gives the page a share sheet only during a gesture, and a release is one. So the
  // long press shares at the release, not at the end of the wait.
  cardSongButton.addEventListener('pointerup', () => {
    const file = songPress?.file;
    if (file !== undefined && cardSongButton.dataset.state === 'held') void shareSong(file);
    endSongPress();
  });
  // A pointer that leaves the button cancels the press.
  cardSongButton.addEventListener('pointerleave', () => {
    endSongPress();
    songPress = undefined;
  });
  cardSongButton.addEventListener('pointercancel', () => {
    endSongPress();
    songPress = undefined;
  });
  cardSongButton.addEventListener('click', () => {
    // The click after a long press does not also play the song.
    const long = songPress?.file !== undefined;
    songPress = undefined;
    if (!long) playCardSong();
  });
  // The context menu (a right click, the menu key, Shift+F10) shares the song too. During a touch long
  // press, the browser menu stays closed and the release shares.
  cardSongButton.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    const shown = cardGame();
    if (songPress !== undefined || shown === undefined || cardSongButton.dataset.state !== 'idle') return;
    void shareSong(songFile(shown.game));
  });
}

export function setupEndCard(): void {
  setupSong();
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
