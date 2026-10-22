// The player card on top of a person view of the stats page: the picture, the name, the unlocked
// achievements in a row that scrolls, and Report or block (the Apple and Google Play rules for user content).
import { badge } from '../achievement-list.ts';
import { type AchievementId, achievementOf } from '../achievements.ts';
import { avatarImage, hiddenLogin } from '../avatar.ts';
import { changeBlock, isBlocked } from '../blocks.ts';
import { api } from '../online.ts';
import type { PersonId, StatsCard } from '../protocol.ts';
import { FLAG_ICON } from '../icons.ts';
import { openSafetyDialog } from '../safety-dialog.ts';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

// The unlocked achievements, newest first. Each badge names its achievement in a tooltip.
function achievementRow(unlocked: readonly AchievementId[]): HTMLElement {
  if (unlocked.length === 0) return el('p', 'player-card-none', 'No achievements yet.');
  const row = el('ul', 'player-card-achievements');
  row.setAttribute('aria-label', `${unlocked.length} achievements`);
  for (const id of unlocked) {
    const { name, description } = achievementOf(id);
    const item = el('li');
    const tile = badge('span', id);
    tile.tabIndex = 0;
    tile.setAttribute('role', 'img');
    tile.setAttribute('aria-label', name);
    tile.dataset.tip = `${name}: ${description}`;
    item.append(tile);
    row.append(item);
  }
  return row;
}

// The shape of the card while it loads: a picture, a name and a row of badges.
export function playerCardPlaceholder(box: HTMLElement): void {
  const head = el('div', 'player-card-head');
  head.append(el('span', 'stats-skeleton stats-skeleton-avatar'), el('span', 'stats-skeleton stats-skeleton-title'));
  const row = el('div', 'player-card-achievements');
  row.append(...Array.from({ length: 5 }, () => el('span', 'stats-skeleton stats-skeleton-badge')));
  box.setAttribute('aria-busy', 'true');
  box.replaceChildren(head, row);
}

// Fills `box` with the card of `id`, the person of the view.
export function playerCard(box: HTMLElement, id: PersonId, { person, unlocked }: StatsCard): void {
  box.removeAttribute('aria-busy');
  const head = el('div', 'player-card-head');
  const title = el('h2', 'player-card-name', `Stats of ${person.name}`);
  const login = hiddenLogin(person);
  if (login !== null) title.append(' ', el('small', 'player-card-login', `GitHub: ${login}`));
  head.append(avatarImage(person, 48), title);
  const status = el('p', 'player-card-status');
  status.setAttribute('role', 'status');
  box.replaceChildren(head, achievementRow(unlocked), status);
  // Nobody reports or blocks themselves.
  if (person.you) return;

  const showBlocked = () => {
    status.textContent = isBlocked(id) ? 'You blocked this player. Their name stays hidden in your games, and they are off your leaderboard.' : '';
  };
  // An icon, so the name keeps the width of the card.
  const button = el('button', 'btn btn-small btn-icon player-card-safety');
  button.type = 'button';
  button.innerHTML = FLAG_ICON;
  button.setAttribute('aria-label', 'Report or block');
  button.dataset.tip = 'Report or block';
  button.addEventListener('click', () =>
    openSafetyDialog({
      title: person.name,
      canReport: true,
      blocked: isBlocked(id),
      toggleBlock: () => {
        changeBlock(id, person.name, !isBlocked(id)).then(
          (done) => {
            status.textContent = done;
          },
          (error: unknown) => {
            status.textContent = error instanceof Error ? error.message : String(error);
          },
        );
      },
      report: async (reason, note) => {
        try {
          await api.report({ person: id, reason, note });
        } catch (error) {
          status.textContent = `The report did not go out. ${error instanceof Error ? error.message : String(error)}`;
          return true;
        }
        status.textContent = 'Thanks. The report went to the maintainers.';
        return true;
      },
    }),
  );
  head.append(button);
  showBlocked();
}
