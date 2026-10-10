// The achievements section of My games, and the unlock strip of the end card.
import { type AchievementGame, type AchievementId, type AchievementProgress, achievementOf, achievementProgress } from '../achievements.ts';
import { api, OnlineError } from '../online.ts';
import type { Code, GameId } from '../protocol.ts';
import { sounds } from '../sound.ts';
import { myGamesAchievements, myGamesAchievementsBar, myGamesAchievementsSummary } from './dom.ts';
import { page } from './state.ts';

// The badge icons: the style of src/icons.ts (a 24 unit box, round strokes), drawn in black on the tier color.
const ROBOT = '<path d="M12 4.5V7M2.5 12v3M21.5 12v3"/><circle cx="12" cy="3.5" r="1"/><rect x="4.5" y="7" width="15" height="13" rx="3"/>';
const EYES = '<circle cx="9" cy="12" r="1.3" fill="currentColor"/><circle cx="15" cy="12" r="1.3" fill="currentColor"/>';
const ICONS: Record<AchievementId, string> = {
  'first-win': '<path d="M7 4h10v4a5 5 0 0 1-10 0V4ZM7 6H4a3 3 0 0 0 3 4M17 6h3a3 3 0 0 1-3 4M12 13v3M8 20h8l-1-4H9l-1 4Z"/>',
  'beat-easy': `${ROBOT}${EYES}<path d="M9 15.5a3.5 3.5 0 0 0 6 0"/>`,
  'beat-medium': `${ROBOT}${EYES}<path d="M7.5 9.5l3 1M16.5 9.5l-3 1M9 16.5h6"/>`,
  'beat-hard': `${ROBOT}<path d="M7.5 10.5l3 3M10.5 10.5l-3 3M13.5 10.5l3 3M16.5 10.5l-3 3M8.5 17.5l1.75-1 1.75 1 1.75-1 1.75 1M14.5 7l-1.5 2.5 2 1"/>`,
  'fastest-win': '<path d="M13.5 2 4.5 13.5H11L10 22l9.5-12H13L13.5 2Z" fill="currentColor"/>',
  'space-diagonal': '<rect x="3" y="9" width="12" height="12" rx="1"/><path d="M3 9l6-6h12v12l-6 6M15 9l6-6" stroke-width="1.8"/><path d="M3.5 20.5l17-17" stroke-width="3"/>',
  'board-hidden': '<path d="M2.5 9.5c2.5 4 5.5 5.5 9.5 5.5s7-1.5 9.5-5.5M6 13.5 4.5 16.5M12 15v3.5M18 13.5l1.5 3"/>',
  'coordinates-hidden': '<path d="M4 15v-3a8 8 0 0 1 16 0v3"/><rect x="3" y="14" width="4.5" height="7" rx="1.5"/><rect x="16.5" y="14" width="4.5" height="7" rx="1.5"/>',
  'timed-win': '<circle cx="12" cy="13.5" r="7.5"/><path d="M12 13.5V9.5M9.5 2.5h5M12 2.5V6M18.5 6.5 20 5"/>',
  'streak-3': '<path d="M3 19h18M7 19V6h10v13M7 15h10"/>',
  'streak-5':
    '<path d="M12 2.5c1 3.5 5.5 5.5 5.5 11a5.5 5.5 0 0 1-11 0c0-2.5 1.5-4 2.5-5 .5 2 1.5 3 2.5 3 0-3-1-6 .5-9Z"/><path d="M12 21a2.5 2.5 0 0 1-2.5-2.5c0-1.5 1.5-2.5 2.5-4 1 1.5 2.5 2.5 2.5 4A2.5 2.5 0 0 1 12 21Z" fill="currentColor"/>',
  'online-win': '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.5 3.5 5.5 3.5 9s-1 6.5-3.5 9c-2.5-2.5-3.5-5.5-3.5-9s1-6.5 3.5-9Z"/>',
  'nearby-win': '<circle cx="7.5" cy="8" r="3"/><circle cx="16.5" cy="8" r="3"/><path d="M2 20a5.5 5.5 0 0 1 11 0M11 20a5.5 5.5 0 0 1 11 0"/>',
  'full-cube': '<path d="M12 2.5 20.5 7 12 11.5 3.5 7Z" fill="currentColor"/><path d="M12 2.5 20.5 7v10L12 21.5 3.5 17V7ZM12 11.5v10"/>',
  'games-10':
    '<path d="M8 2.5l2.5 6.5M16 2.5 13.5 9"/><circle cx="12" cy="15" r="6"/><path d="M12 12l.9 1.9 2.1.3-1.5 1.4.4 2.1-1.9-1-1.9 1 .4-2.1-1.5-1.4 2.1-.3Z" fill="currentColor" stroke-width="1"/>',
  'games-100': '<path d="M5 20v-6.5a7 7 0 0 1 14 0V20M5 16h4.5v4M19 16h-4.5v4M9 12.5h6M6 7.5C7 4 9.5 2.5 12 2.5S17 4 18 7.5"/>',
};
const LOCK = '<rect x="5" y="11" width="14" height="10" rx="2.5"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>';

const svg = (body: string) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

// The badge of one achievement: the icon on a tile in the color of its tier.
function badge<K extends 'span' | 'button'>(tag: K, id: AchievementId): HTMLElementTagNameMap[K] {
  const tile = document.createElement(tag);
  tile.className = 'achievement-icon';
  tile.dataset.tier = achievementOf(id).tier;
  tile.innerHTML = svg(ICONS[id]);
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
  if (entry.unlockedAt === null) tile.insertAdjacentHTML('beforeend', `<span class="achievement-lock">${svg(LOCK)}</span>`);
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

// Two looks of the unlock on the end card (see .unlock in src/style.css), for the maintainers to pick one.
// strip: a dark band under the card picture. sticker: the same band, smaller, stuck on the corner of the picture.
// The other look goes before the merge.
type UnlockView = 'strip' | 'sticker';
const UNLOCK_VIEW: UnlockView = 'strip';
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
    kicker.textContent = unlocked.length === 1 ? 'Achievement unlocked' : `Achievement unlocked · ${index + 1} of ${unlocked.length}`;
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
