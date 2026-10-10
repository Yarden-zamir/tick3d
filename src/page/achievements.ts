// The achievements section of My games, and the notice when a game unlocks one.
import { type AchievementGame, type AchievementId, type AchievementProgress, achievementOf, achievementProgress } from '../achievements.ts';
import { api, OnlineError } from '../online.ts';
import type { Code, GameId } from '../protocol.ts';
import { myGamesAchievements, myGamesAchievementsSummary } from './dom.ts';
import { showToast } from './feedback.ts';
import { page } from './state.ts';

// Three looks of the same list (see .achievements in src/style.css), for the maintainers to pick one.
// The two other looks go before the merge.
type AchievementView = 'grid' | 'list' | 'chips';
const VIEW: AchievementView = 'list';

// The progress from the games on this device, for when the server is out of reach.
async function deviceProgress(): Promise<AchievementProgress[]> {
  const results = (await page.deviceDb?.all('results')) ?? [];
  return achievementProgress(
    results.map(({ upload }): AchievementGame => ({
      id: upload.publicId,
      mode: upload.mode,
      game: upload.game,
      you: upload.you,
      difficulty: upload.difficulty,
      options: upload.options,
      tuned: upload.tuned,
      finishedAt: upload.finishedAt,
    })),
  );
}

// The server counts the games of every linked device. Without it, the games on this device count.
export async function currentProgress(): Promise<AchievementProgress[]> {
  if (!navigator.onLine) return deviceProgress();
  try {
    return await api.achievements();
  } catch (error) {
    if (!(error instanceof OnlineError)) throw error;
    return deviceProgress();
  }
}

const unlockedDate = (time: number) => new Date(time).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });

function achievementItem(entry: AchievementProgress): HTMLLIElement {
  const { name, description, mark, goal } = achievementOf(entry.id);
  const item = document.createElement('li');
  item.className = entry.unlockedAt === null ? 'locked' : 'unlocked';
  const badge = document.createElement('span');
  badge.className = 'achievement-mark';
  badge.setAttribute('aria-hidden', 'true');
  badge.textContent = mark;
  const text = document.createElement('div');
  const title = document.createElement('b');
  title.textContent = name;
  const detail = document.createElement('small');
  detail.textContent = entry.unlockedAt === null ? description : `${description} Unlocked ${unlockedDate(entry.unlockedAt)}.`;
  text.append(title, detail);
  item.title = detail.textContent;
  item.append(badge, text);
  // A goal of more than one game shows how far the player is.
  if (goal > 1) {
    const bar = document.createElement('progress');
    bar.max = goal;
    bar.value = entry.count;
    bar.setAttribute('aria-label', `${name}: ${entry.count} of ${goal}`);
    const count = document.createElement('span');
    count.className = 'achievement-count';
    count.textContent = `${entry.count}/${goal}`;
    item.append(bar, count);
  }
  return item;
}

export function showAchievements(progress: readonly AchievementProgress[]): void {
  const unlocked = progress.filter((entry) => entry.unlockedAt !== null).length;
  myGamesAchievementsSummary.textContent = `${unlocked} of ${progress.length} unlocked`;
  myGamesAchievements.dataset.view = VIEW;
  myGamesAchievements.replaceChildren(...progress.map(achievementItem));
}

// The achievements that a game unlocked in this visit, by session code and game index, for its end card.
const news = new Map<string, readonly AchievementId[]>();

const unlockText = (unlocked: readonly AchievementId[]) =>
  `${unlocked.length === 1 ? 'Achievement' : 'Achievements'} unlocked: ${unlocked.map((id) => achievementOf(id).name).join(', ')}`;

export function achievementNews(code: Code, index: number): string | undefined {
  const unlocked = news.get(`${code}:${index}`);
  return unlocked === undefined ? undefined : unlockText(unlocked);
}

// After a game ends: finds the achievements that the game with link `id` unlocked. Returns true when it found some.
// Limit: a game that the server does not have yet (offline, or an upload that waits) counts only the games
// on this device. Revisit this if players report a missing or a repeated notice.
export async function noteAchievements(code: Code, index: number, id: GameId): Promise<boolean> {
  const unlocked = (await currentProgress()).filter((entry) => entry.unlockedBy === id).map((entry) => entry.id);
  if (unlocked.length === 0) return false;
  news.set(`${code}:${index}`, unlocked);
  showToast(`${unlockText(unlocked)}.`);
  return true;
}
