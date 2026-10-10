// The leaderboard card of the stats page: the common stats of each player, sorted by any column.
// It loads when it scrolls into view, so a visit that never reaches it costs the server nothing.
import { avatarImage } from '../avatar.ts';
import { api } from '../online.ts';
import { type Leaderboard, type LeaderboardRow, type PersonId, type StatsFilter, statsQuery } from '../protocol.ts';
import { COLUMNS, SHOWN_ROWS, type Sort, defaultSort, sortRows } from './leaderboard-sort.ts';

// The sort lasts while the page is open, also through a change of the filters.
let sort: Sort = defaultSort('won');

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

// Fills `box` with the leaderboard of `filter` when the box scrolls into view.
// `open` shows the stats of one person, with the same filters.
export function leaderboardCard(box: HTMLElement, filter: StatsFilter, open: (person: PersonId) => void): void {
  const status = el('p', 'stats-empty', 'The leaderboard loads when you scroll to it.');
  box.append(status);
  const load = async () => {
    status.textContent = 'Loading…';
    try {
      const board = await api.leaderboard(filter);
      // A newer view replaced this card while it loaded.
      if (!box.isConnected) return;
      status.remove();
      render(box, board, filter, open, false);
    } catch (error) {
      status.textContent = `The leaderboard did not load. ${error instanceof Error ? error.message : String(error)}`;
    }
  };
  if (typeof IntersectionObserver === 'undefined') return void load();
  const observer = new IntersectionObserver((entries) => {
    if (!entries.some((entry) => entry.isIntersecting)) return;
    observer.disconnect();
    void load();
  });
  observer.observe(box);
}

function render(box: HTMLElement, board: Leaderboard, filter: StatsFilter, open: (person: PersonId) => void, all: boolean): void {
  box.querySelector('.leaderboard')?.remove();
  const wrap = el('div', 'stats-table leaderboard');
  box.append(wrap);
  if (board.rows.length === 0) {
    wrap.append(el('p', 'stats-empty', 'No players yet.'));
    return;
  }
  const rerender = (showAll = all) => render(box, board, filter, open, showAll);

  const table = el('table');
  const head = el('tr');
  head.append(el('th', 'leaderboard-rank', '#'), el('th', 'leaderboard-player', 'Player'));
  for (const column of COLUMNS) {
    const th = el('th');
    const active = sort.key === column.key;
    if (active) th.setAttribute('aria-sort', sort.lowFirst ? 'ascending' : 'descending');
    const button = el('button', 'leaderboard-sort', column.label);
    button.type = 'button';
    button.dataset.tip = column.tip;
    button.dataset.sort = column.key;
    if (active) button.append(el('span', 'leaderboard-arrow', sort.lowFirst ? ' ▲' : ' ▼'));
    // A first tap sorts best first. A tap on the sorted column turns the order around.
    button.addEventListener('click', () => {
      sort = active ? { key: column.key, lowFirst: !sort.lowFirst } : defaultSort(column.key);
      rerender();
      // The table is new, so the focus goes to the same button in it.
      box.querySelector<HTMLButtonElement>(`[data-sort="${column.key}"]`)?.focus();
    });
    th.append(button);
    head.append(th);
  }
  table.append(el('thead'));
  table.tHead?.append(head);

  const sorted = sortRows(board.rows, sort);
  const body = el('tbody');
  const line = (row: LeaderboardRow, rank: number) => {
    const tr = el('tr');
    if (row.person === board.you) tr.className = 'leaderboard-you';
    const link = el('a', 'leaderboard-name');
    link.href = `${location.pathname}${statsQuery({ ...filter, person: row.person })}`;
    link.append(avatarImage(row, 24), el('span', '', row.name));
    link.addEventListener('click', (event) => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      open(row.person);
    });
    const player = el('td', 'leaderboard-player');
    player.append(link);
    tr.append(el('td', 'leaderboard-rank', String(rank)), player);
    for (const column of COLUMNS) tr.append(el('td', sort.key === column.key ? 'leaderboard-sorted' : '', column.show(row)));
    body.append(tr);
  };
  const shown = all ? sorted : sorted.slice(0, SHOWN_ROWS);
  shown.forEach((row, index) => line(row, index + 1));
  // Your own row shows also when it is below the shown rows.
  const yourIndex = sorted.findIndex((row) => row.person === board.you);
  if (yourIndex >= shown.length) {
    const gap = el('tr', 'leaderboard-gap');
    gap.append(el('td', '', '…'));
    body.append(gap);
    const you = sorted[yourIndex];
    if (you === undefined) throw new Error('your leaderboard row is missing');
    line(you, yourIndex + 1);
  }
  table.append(body);
  wrap.append(table);

  if (sorted.length > SHOWN_ROWS) {
    const more = el('button', 'btn btn-small leaderboard-more', all ? 'Show fewer' : `Show all ${sorted.length} players`);
    more.type = 'button';
    more.addEventListener('click', () => rerender(!all));
    wrap.append(more);
  }
}
