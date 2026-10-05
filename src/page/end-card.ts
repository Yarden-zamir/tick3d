// The end of a game: sounds, confetti, and the end card.
import { type CardInput, drawCard, shareImage, saveImage } from '../card.ts';
import { formatClock, describeClock } from '../clock.ts';
import { type Game, other, toCoords, winnerOf } from '../game.ts';
import { isDefaultTuning } from '../tuning.ts';
import { sounds } from '../sound.ts';
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
  cardCloseButton,
  showCardButton,
} from './dom.ts';
import { showToast } from './feedback.ts';
import { recordResult, noteSurvival, recordNews, hideLabel } from './results.ts';
import { startNewGame } from './sessions.ts';
import { settings } from './settings.ts';
import { me, page, isLive, matchOptions } from './state.ts';

const CARD_DELAY_MS = 1400;
let card: { index: number; canvas: HTMLCanvasElement } | undefined;

// Plays the sound for the last move of the live game, and the result if the move ended it.
export function announce(game: Game): void {
  const last = game.moves.at(-1);
  if (last === undefined) return;
  sounds.place(other(game.turn), toCoords(last).layer);
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
  if (page.session !== undefined) void recordResult(page.session, game, index);
  if (page.session?.mode === 'computer' && winner !== null && mine !== null && winner !== mine) noteSurvival(page.session, game, index);
  setTimeout(() => {
    // Show the card only if that game is still the finished live game and nothing else is open.
    if (page.games.length - 1 !== index || isLive() || page.review !== undefined) return;
    if (cardDialog.open || myGamesDialog.open || homeConfirm.open) return;
    void openCard(index);
  }, CARD_DELAY_MS);
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

function cardInput(game: Game, index: number): CardInput {
  const winner = winnerOf(game.status);
  const mine = me();
  const title =
    winner === null
      ? 'Draw'
      : mine === null
        ? `${winner} wins`
        : winner === mine
          ? 'You win!'
          : settings.mode === 'computer'
            ? 'Computer wins'
            : 'You lost';
  const subtitle =
    game.status.kind === 'won'
      ? `Four in a row in ${game.moves.length} moves`
      : game.status.kind === 'timeout'
        ? `${other(game.status.winner)} ran out of time after ${game.moves.length} moves`
        : 'The cube is full. Nobody got four in a row.';
  const level = `${settings.difficulty.charAt(0).toUpperCase()}${settings.difficulty.slice(1)}${isDefaultTuning(computerTuning()) ? '' : ' (tuned)'}`;
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
  const link = onlineCode ? `${location.host}/?code=${onlineCode}` : location.host;
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
  const input = cardInput(game, index);
  const canvas = await drawCard(input);
  card = { index, canvas };
  cardImage.src = canvas.toDataURL('image/png');
  cardImage.alt = `${input.title}. ${input.subtitle}.${input.record ? ` New record: ${input.record.moves} moves.` : ''}`;
  // Only the newest game can start the next one. A card of an older game has no New game button.
  cardNewGameButton.hidden = index !== page.games.length - 1;
  cardNewGameButton.disabled = newGameButton.disabled;
  if (!cardDialog.open) cardDialog.showModal();
}

function cardFilename(): string {
  return `tick3d-${new Date().toISOString().slice(0, 10)}.png`;
}

export function setupEndCard(): void {
  cardShareButton.addEventListener('click', () => {
    if (card === undefined) return;
    const { canvas, index } = card;
    const game = page.games[index];
    if (game === undefined) return;
    const input = cardInput(game, index);
    const isOnline = page.session?.mode === 'online';
    const url = cardLink.checked ? (isOnline ? location.href : location.origin) : undefined;
    const code = cardCode.checked && isOnline && page.session ? ` Code ${page.session.code}.` : '';
    void shareImage(canvas, cardFilename(), `${input.title}: ${input.subtitle} on tick3d.${code}`, url).then((outcome) => {
      if (outcome === 'copied') showToast('Image copied. Paste it anywhere.');
      if (outcome === 'saved') showToast('Image saved.');
    });
  });

  cardSaveButton.addEventListener('click', () => {
    if (card !== undefined) void saveImage(card.canvas, cardFilename());
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
