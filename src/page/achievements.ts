// The achievements section of My games, and the unlock band of the end card.
import { achievementItems, badge } from '../achievement-list.ts';
import { type AchievementGame, type AchievementId, type AchievementProgress, type AchievementRarity, achievementOf, achievementProgress } from '../achievements.ts';
import { api, OnlineError } from '../online.ts';
import type { Code, GameId } from '../protocol.ts';
import { sounds } from '../sound.ts';
import {
  myGamesAchievements,
  myGamesAchievementsBar,
  myGamesAchievementsSummary,
  myGamesResetAchievements,
  resetAchievementsConfirm,
  resetAchievementsNo,
  resetAchievementsYes,
} from './dom.ts';
import { showError } from './feedback.ts';
import { page } from './state.ts';

// The progress, and the rarity when the server answered. Without the server, the games on this device count.
type ShownAchievements = { achievements: AchievementProgress[]; rarity: AchievementRarity | null };

async function deviceProgress(): Promise<ShownAchievements> {
  const results = (await page.deviceDb?.all('results')) ?? [];
  const achievements = achievementProgress(
    results.map(({ upload }): AchievementGame => ({
      id: upload.publicId,
      mode: upload.mode,
      game: upload.game,
      you: upload.you,
      difficulty: upload.difficulty,
      options: upload.options,
      tuned: upload.tuned,
      finishedAt: upload.finishedAt,
      // Limit: the device does not know who the opponent was, so the goals about people need the server.
      // Revisit this if the device stores a person id with each result.
      opponent: null,
    })),
  );
  return { achievements, rarity: null };
}

// The server counts the games of every linked device.
export async function currentProgress(): Promise<ShownAchievements> {
  if (!navigator.onLine) return deviceProgress();
  try {
    return await api.achievements();
  } catch (error) {
    if (!(error instanceof OnlineError)) throw error;
    return deviceProgress();
  }
}

// The achievements that a game unlocked in this visit, by session code and game index, for its end card.
const news = new Map<string, readonly AchievementId[]>();
const isNew = (id: AchievementId) => [...news.values()].some((unlocked) => unlocked.includes(id));

export function showAchievements({ achievements, rarity }: ShownAchievements): void {
  const unlocked = achievements.filter((entry) => entry.unlockedAt !== null).length;
  myGamesAchievementsSummary.textContent = `${unlocked} of ${achievements.length} unlocked`;
  myGamesAchievementsBar.max = achievements.length;
  myGamesAchievementsBar.value = unlocked;
  myGamesAchievements.replaceChildren(...achievementItems(achievements, rarity, isNew));
  // A reset needs the server, and a player without progress has nothing to reset.
  myGamesResetAchievements.hidden = rarity === null || achievements.every((entry) => entry.count === 0);
}

// "Reset achievements": from now on, only new games count, on every device. "Clear history" leaves them alone.
// Limit: offline, the device counts every game on it, also from before the reset. Revisit this if
// players report old unlocks after a reset.
async function resetAchievements(): Promise<void> {
  resetAchievementsYes.disabled = true;
  try {
    const answer = await api.resetAchievements();
    news.clear();
    resetAchievementsConfirm.close();
    showAchievements(answer);
  } finally {
    resetAchievementsYes.disabled = false;
  }
}

export function setupAchievements(): void {
  myGamesResetAchievements.addEventListener('click', () => {
    resetAchievementsConfirm.showModal();
    resetAchievementsNo.focus();
  });
  resetAchievementsNo.addEventListener('click', () => resetAchievementsConfirm.close());
  resetAchievementsYes.addEventListener('click', () => void resetAchievements().catch(showError));
  resetAchievementsConfirm.addEventListener('click', (event) => {
    if (event.target === resetAchievementsConfirm) resetAchievementsConfirm.close();
  });
}

// The strip shows each unlocked achievement in turn, once, and then stays on the first one.
const UNLOCK_TURN_MS = 2600;
// The bits of the burst behind the badges.
const SPARKS = 14;
let unlockTimer: ReturnType<typeof setInterval> | undefined;

export function unlockedBy(code: Code, index: number): readonly AchievementId[] | undefined {
  return news.get(`${code}:${index}`);
}

export const unlockLabel = (unlocked: readonly AchievementId[]) =>
  `${unlocked.length === 1 ? 'Achievement' : 'Achievements'} unlocked: ${unlocked.map((id) => achievementOf(id).name).join(', ')}`;

// Fills `box` with the badges of `unlocked`, which pop in one after another, and the name of one of them.
// A tap on a badge shows its name and stops the turns.
export function showUnlocks(box: HTMLElement, unlocked: readonly AchievementId[]): void {
  clearInterval(unlockTimer);
  box.setAttribute('aria-label', unlockLabel(unlocked));
  const medals = document.createElement('div');
  medals.className = 'unlock-medals';
  const burst = document.createElement('span');
  burst.className = 'unlock-burst';
  burst.setAttribute('aria-hidden', 'true');
  for (let spark = 0; spark < SPARKS; spark++) {
    const bit = document.createElement('i');
    bit.style.setProperty('--angle', `${(360 / SPARKS) * spark}deg`);
    const id = unlocked[spark % unlocked.length];
    if (id === undefined) throw new Error('an unlock strip needs an achievement');
    bit.dataset.tier = achievementOf(id).tier;
    burst.append(bit);
  }
  medals.append(burst);
  const kicker = document.createElement('small');
  const title = document.createElement('b');
  const detail = document.createElement('span');
  const text = document.createElement('div');
  text.className = 'unlock-text';
  text.append(kicker, title, detail);
  const buttons = unlocked.map((id, index) => {
    const button = badge('button', id);
    button.type = 'button';
    button.style.setProperty('--i', String(index));
    button.setAttribute('aria-label', achievementOf(id).name);
    button.addEventListener('click', () => {
      clearInterval(unlockTimer);
      show(index);
    });
    medals.append(button);
    return button;
  });
  const show = (index: number) => {
    const id = unlocked[index];
    if (id === undefined) throw new Error(`no unlocked achievement ${index}`);
    const { name, description, tier } = achievementOf(id);
    buttons.forEach((button, at) => button.setAttribute('aria-pressed', String(at === index)));
    text.dataset.tier = tier;
    kicker.textContent = unlocked.length === 1 ? 'Achievement unlocked' : `Unlocked · ${index + 1} of ${unlocked.length}`;
    title.textContent = name;
    detail.textContent = description;
    // A new animation for each name.
    text.classList.remove('turn');
    void text.offsetWidth;
    text.classList.add('turn');
  };
  box.replaceChildren(medals, text);
  show(0);
  let shown = 0;
  if (unlocked.length > 1) {
    unlockTimer = setInterval(() => {
      shown += 1;
      // A closed card or a new strip stops the turns.
      if (!box.isConnected || shown > unlocked.length) return clearInterval(unlockTimer);
      show(shown % unlocked.length);
    }, UNLOCK_TURN_MS);
  }
}

// After a game ends: finds the achievements that the game with link `id` unlocked, and plays the unlock sound.
// Returns them, or an empty list.
// Limit: a game that the server does not have yet (offline, or an upload that waits) counts only the games
// on this device. Revisit this if players report a missing or a repeated notice.
export async function noteAchievements(code: Code, index: number, id: GameId): Promise<readonly AchievementId[]> {
  const unlocked = (await currentProgress()).achievements.filter((entry) => entry.unlockedBy === id).map((entry) => entry.id);
  if (unlocked.length === 0) return unlocked;
  news.set(`${code}:${index}`, unlocked);
  sounds.achievement();
  return unlocked;
}
