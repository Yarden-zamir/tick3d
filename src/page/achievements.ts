// The achievements section of My games, and the unlock strip of the end card.
import { ACHIEVEMENT_ICONS, LOCK_ICON, iconSvg } from '../achievement-icons.ts';
import { type AchievementGame, type AchievementId, type AchievementProgress, achievementOf, achievementProgress } from '../achievements.ts';
import { api, OnlineError } from '../online.ts';
import type { Code, GameId } from '../protocol.ts';
import { sounds } from '../sound.ts';
import { myGamesAchievements, myGamesAchievementsBar, myGamesAchievementsSummary } from './dom.ts';
import { page } from './state.ts';

// The badge of one achievement: the icon on a tile in the color of its tier.
function badge<K extends 'span' | 'button'>(tag: K, id: AchievementId): HTMLElementTagNameMap[K] {
  const tile = document.createElement(tag);
  tile.className = 'achievement-icon';
  tile.dataset.tier = achievementOf(id).tier;
  tile.innerHTML = iconSvg(ACHIEVEMENT_ICONS[id]);
  return tile;
}

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

// The achievements that a game unlocked in this visit, by session code and game index, for its end card.
const news = new Map<string, readonly AchievementId[]>();
const isNew = (id: AchievementId) => [...news.values()].some((unlocked) => unlocked.includes(id));

function achievementItem(entry: AchievementProgress): HTMLLIElement {
  const { name, description, goal } = achievementOf(entry.id);
  const item = document.createElement('li');
  item.className = 'achievement';
  item.dataset.state = entry.unlockedAt === null ? 'locked' : 'unlocked';
  item.dataset.tier = achievementOf(entry.id).tier;
  const tile = badge('span', entry.id);
  if (entry.unlockedAt === null) tile.insertAdjacentHTML('beforeend', `<span class="achievement-lock">${iconSvg(LOCK_ICON)}</span>`);
  const text = document.createElement('div');
  text.className = 'achievement-text';
  const title = document.createElement('b');
  title.textContent = name;
  const detail = document.createElement('small');
  detail.textContent = description;
  text.append(title, detail);
  // A goal of more than one game shows how far the player is, until it unlocks.
  if (goal > 1 && entry.unlockedAt === null) {
    const bar = document.createElement('progress');
    bar.max = goal;
    bar.value = entry.count;
    bar.setAttribute('aria-label', `${name}: ${entry.count} of ${goal}`);
    const count = document.createElement('span');
    count.className = 'achievement-count';
    count.textContent = `${entry.count} / ${goal}`;
    const row = document.createElement('span');
    row.className = 'achievement-progress';
    row.append(bar, count);
    text.append(row);
  }
  item.append(tile, text);
  if (entry.unlockedAt !== null) {
    const when = document.createElement('span');
    when.className = 'achievement-when';
    when.textContent = isNew(entry.id) ? 'New!' : `Unlocked ${unlockedDate(entry.unlockedAt)}`;
    if (isNew(entry.id)) when.dataset.new = '';
    item.append(when);
  }
  return item;
}

// As in Steam: the unlocked achievements first, newest on top, then the locked ones, closest to the goal first.
function steamOrder(progress: readonly AchievementProgress[]): AchievementProgress[] {
  const share = (entry: AchievementProgress) => entry.count / achievementOf(entry.id).goal;
  return progress.toSorted((a, b) => {
    if (a.unlockedAt !== null && b.unlockedAt !== null) return b.unlockedAt - a.unlockedAt;
    if (a.unlockedAt !== null) return -1;
    if (b.unlockedAt !== null) return 1;
    return share(b) - share(a);
  });
}

export function showAchievements(progress: readonly AchievementProgress[]): void {
  const unlocked = progress.filter((entry) => entry.unlockedAt !== null).length;
  myGamesAchievementsSummary.textContent = `${unlocked} of ${progress.length} unlocked`;
  myGamesAchievementsBar.max = progress.length;
  myGamesAchievementsBar.value = unlocked;
  myGamesAchievements.replaceChildren(...steamOrder(progress).map(achievementItem));
}

// Three looks of the unlock on the end card (see .unlock in src/style.css), for the maintainers to pick one.
// pop: the band under the picture comes in like a sticker. slide: the band lands on the corner of the picture,
// then slides down under it. breakout: the first badge is bigger and sticks out over the top of the band.
// The other looks go before the merge.
type UnlockView = 'pop' | 'slide' | 'breakout';
const UNLOCK_VIEW: UnlockView = 'pop';
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
  box.dataset.view = UNLOCK_VIEW;
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
  const unlocked = (await currentProgress()).filter((entry) => entry.unlockedBy === id).map((entry) => entry.id);
  if (unlocked.length === 0) return unlocked;
  news.set(`${code}:${index}`, unlocked);
  sounds.achievement();
  return unlocked;
}
