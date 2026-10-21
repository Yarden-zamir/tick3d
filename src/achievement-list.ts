// The achievements list in the style of Steam, for My games and the stats page, and the badge of one achievement.
import { ACHIEVEMENT_ICONS, HIDDEN_ICON, LOCK_ICON, iconSvg } from './achievement-icons.ts';
import { type AchievementId, type AchievementProgress, type AchievementRarity, achievementOf, rarityLabel } from './achievements.ts';

// The badge of one achievement: the icon on a tile in the color of its tier.
export function badge<K extends 'span' | 'button'>(tag: K, id: AchievementId): HTMLElementTagNameMap[K] {
  const tile = document.createElement(tag);
  tile.className = 'achievement-icon';
  tile.dataset.tier = achievementOf(id).tier;
  tile.innerHTML = iconSvg(ACHIEVEMENT_ICONS[id]);
  return tile;
}

const unlockedDate = (time: number) => new Date(time).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });

// A hidden achievement before its unlock: a question mark, with no name, goal or rarity.
function hiddenItem(): HTMLLIElement {
  const item = document.createElement('li');
  item.className = 'achievement';
  item.dataset.state = 'hidden';
  const tile = document.createElement('span');
  tile.className = 'achievement-icon';
  tile.innerHTML = iconSvg(HIDDEN_ICON);
  const text = document.createElement('div');
  text.className = 'achievement-text';
  const title = document.createElement('b');
  title.textContent = 'Hidden achievement';
  const detail = document.createElement('small');
  detail.textContent = 'Keep playing to find it.';
  text.append(title, detail);
  item.append(tile, text);
  return item;
}

function achievementItem(entry: AchievementProgress, rarity: AchievementRarity | null, isNew: boolean): HTMLLIElement {
  const { name, description, goal, hidden } = achievementOf(entry.id);
  if (hidden && entry.unlockedAt === null) return hiddenItem();
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
  const rare = rarity === null ? null : rarityLabel(rarity, entry.id);
  if (rare !== null) {
    const share = document.createElement('span');
    share.className = 'achievement-rarity';
    share.textContent = `${rare} of players`;
    text.append(share);
  }
  item.append(tile, text);
  if (entry.unlockedAt !== null) {
    const when = document.createElement('span');
    when.className = 'achievement-when';
    when.textContent = isNew ? 'New!' : `Unlocked ${unlockedDate(entry.unlockedAt)}`;
    if (isNew) when.dataset.new = '';
    item.append(when);
  }
  return item;
}

// As in Steam: the unlocked achievements first, newest on top, then the locked ones, closest to the goal first,
// and the hidden ones last.
function steamOrder(progress: readonly AchievementProgress[]): AchievementProgress[] {
  const share = (entry: AchievementProgress) => (achievementOf(entry.id).hidden ? -1 : entry.count / achievementOf(entry.id).goal);
  return progress.toSorted((a, b) => {
    if (a.unlockedAt !== null && b.unlockedAt !== null) return b.unlockedAt - a.unlockedAt;
    if (a.unlockedAt !== null) return -1;
    if (b.unlockedAt !== null) return 1;
    return share(b) - share(a);
  });
}

// The rows of the achievements list, in the order of steamOrder. `isNew` marks the unlocks of this visit.
export function achievementItems(progress: readonly AchievementProgress[], rarity: AchievementRarity | null, isNew: (id: AchievementId) => boolean): HTMLLIElement[] {
  return steamOrder(progress).map((entry) => achievementItem(entry, rarity, isNew(entry.id)));
}

// Fades an edge of the sideways scroll row `row` while more badges hide past it (.unlock-row in src/style.css).
export function fadeHiddenEdges(row: HTMLElement): void {
  const update = () => {
    const end = row.scrollWidth - row.clientWidth;
    // A pixel of slack: the scroll position of a zoomed page is fractional.
    row.classList.toggle('more-start', row.scrollLeft > 1);
    row.classList.toggle('more-end', row.scrollLeft < end - 1);
  };
  row.addEventListener('scroll', update, { passive: true });
  new ResizeObserver(update).observe(row);
}
