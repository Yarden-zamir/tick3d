// The Console panel: scenario steps, cron schedules and API traffic, with Unity's Clear, Collapse,
// search and per-category toggles. A click on a line selects what it names.

import { EDGES, KINDS, ZONES, ZONE_ORDER } from '../lore.ts';
import { KIND_ICONS, type Selection, el } from '../model.ts';
import { BELT_COLORS } from '../world/belts.ts';

export type Category = 'scenario' | 'schedule' | 'traffic';

interface Entry {
  category: Category;
  text: string;
  time: string;
  select?: Selection;
  count: number;
  row?: HTMLElement;
}

const ICONS: Record<Category, string> = { scenario: '🛈', schedule: '⏰', traffic: '⇄' };
const LIMIT = 400;

export interface ConsolePanel {
  log(category: Category, text: string, time: string, select?: Selection): void;
}

export function createConsole(root: HTMLElement, onSelect: (selection: Selection) => void): ConsolePanel {
  const list = root.querySelector<HTMLElement>('#console');
  const legend = root.querySelector<HTMLElement>('#legend');
  const bar = root.querySelector<HTMLElement>('#console-bar');
  const search = root.querySelector<HTMLInputElement>('#console-search');
  const collapse = root.querySelector<HTMLInputElement>('#console-collapse');
  if (!list || !legend || !bar || !search || !collapse) throw new Error('console markup missing');
  const entries: Entry[] = [];
  const shown: Record<Category, boolean> = { scenario: true, schedule: true, traffic: false };
  const counts: Record<Category, number> = { scenario: 0, schedule: 0, traffic: 0 };

  const message = (text: string): (Node | string)[] =>
    text.split(/(`[^`]+`)/).map((part) => (part.startsWith('`') && part.endsWith('`') ? el('code', { text: part.slice(1, -1) }) : part));

  const visible = (entry: Entry): boolean => shown[entry.category] && (!search.value || entry.text.toLowerCase().includes(search.value.toLowerCase()));

  function rowOf(entry: Entry): HTMLElement {
    const row = el(
      'div',
      { className: `log ${entry.category}` },
      el('span', { className: 'i', text: ICONS[entry.category] }),
      el('span', { className: 't', text: entry.time }),
      el('span', { className: 'm' }, ...message(entry.text)),
      entry.count > 1 ? el('span', { className: 'n', text: String(entry.count) }) : null,
    );
    if (entry.select) {
      row.style.cursor = 'pointer';
      row.addEventListener('click', () => onSelect(entry.select ?? null));
    }
    return row;
  }

  function renderAll(): void {
    list?.replaceChildren(...entries.filter(visible).map((entry) => (entry.row = rowOf(entry))));
    if (list) list.scrollTop = list.scrollHeight;
  }

  function updateCounts(): void {
    for (const button of bar?.querySelectorAll<HTMLButtonElement>('.count') ?? []) {
      const category = button.dataset.cat as Category;
      const span = button.querySelector('span');
      if (span) span.textContent = counts[category] > 999 ? '999+' : String(counts[category]);
    }
  }

  for (const button of bar.querySelectorAll<HTMLButtonElement>('.count')) {
    button.addEventListener('click', () => {
      const category = button.dataset.cat as Category;
      shown[category] = !shown[category];
      button.classList.toggle('on', shown[category]);
      renderAll();
    });
  }
  search.addEventListener('input', renderAll);
  collapse.addEventListener('change', renderAll);
  root.querySelector('#console-clear')?.addEventListener('click', () => {
    entries.length = 0;
    for (const key of Object.keys(counts) as Category[]) counts[key] = 0;
    updateCounts();
    renderAll();
  });

  // The Legend tab: what every zone, machine and belt color means.
  legend.append(
    el('h4', { text: 'Zones' }),
    ...ZONE_ORDER.map((zone) => el('div', { className: 'item' }, el('span', { className: 'swatch', style: { background: ZONES[zone].color } }), el('b', { text: ZONES[zone].title }), el('span', { text: ZONES[zone].holds }))),
    el('h4', { text: 'Machines' }),
    ...Object.entries(KINDS)
      .filter(([kind]) => kind !== 'hub')
      .map(([kind, info]) => el('div', { className: 'item' }, el('span', { text: KIND_ICONS[kind as keyof typeof KIND_ICONS] }), el('b', { text: `${info.machine}` }), el('span', { text: `${info.name}. ${info.meaning}` }))),
    el('h4', { text: 'Belts' }),
    el('div', { className: 'item' }, el('span', { className: 'swatch', style: { background: BELT_COLORS.normal } }), el('b', { text: 'Belt' }), el('span', { text: 'Belts keep right, so each aisle or road has one lane per direction. The arrows show which way the items flow.' })),
    el('div', { className: 'item' }, el('span', { className: 'swatch', style: { background: BELT_COLORS.out } }), el('b', { text: 'Outgoing' }), el('span', { text: 'With a machine selected: the belts that carry its output to the machines that import it.' })),
    el('div', { className: 'item' }, el('span', { className: 'swatch', style: { background: BELT_COLORS.in } }), el('b', { text: 'Incoming' }), el('span', { text: 'With a machine selected: the belts that bring in what it imports.' })),
    el('div', { className: 'item' }, el('span', { className: 'swatch', style: { background: BELT_COLORS.type } }), el('b', { text: 'Blueprint' }), el('span', { text: 'A type-only import: it shapes the code but carries no runtime item.' })),
    el('div', { className: 'item' }, el('span', { className: 'swatch', style: { background: '#c9c5b9' } }), el('b', { text: 'Road' }), el('span', { text: 'Paved roads carry the belts between zone hubs, through the gaps between the plots.' })),
    el('h4', { text: 'Items on the belts' }),
    ...Object.values(EDGES).map((info) => el('div', { className: 'item' }, el('span', { className: 'swatch', style: { background: info.color } }), el('b', { text: info.name }), el('span', { text: info.meaning }))),
    el('h4', { text: 'Dock doors and runners' }),
    el('div', { className: 'item' }, el('b', { text: 'Doors' }), el('span', { text: 'GET green · POST blue · PUT/PATCH amber · DELETE red. A white plate: accepts Idempotency-Key.' })),
    el('div', { className: 'item' }, el('b', { text: 'Press columns' }), el('span', { text: 'ubuntu orange · macos silver · reusable workflow purple.' })),
    el('div', { className: 'item' }, el('b', { text: 'Signal lights' }), el('span', { text: 'push yellow · pull_request purple · schedule cyan · dispatch white · deployment green.' })),
  );
  for (const tab of root.querySelectorAll<HTMLButtonElement>('[data-btab]')) {
    tab.addEventListener('click', () => {
      const isLegend = tab.dataset.btab === 'legend';
      for (const other of root.querySelectorAll<HTMLButtonElement>('[data-btab]')) other.classList.toggle('active', other === tab);
      list.hidden = isLegend;
      legend.hidden = !isLegend;
      bar.hidden = isLegend;
    });
  }

  return {
    log(category, text, time, select) {
      counts[category] += 1;
      updateCounts();
      const last = entries[entries.length - 1];
      if (collapse.checked && last && last.text === text && last.category === category) {
        last.count += 1;
        if (last.row && visible(last)) {
          const replacement = rowOf(last);
          last.row.replaceWith(replacement);
          last.row = replacement;
        }
        return;
      }
      const entry: Entry = { category, text, time, count: 1, ...(select ? { select } : {}) };
      entries.push(entry);
      if (entries.length > LIMIT) {
        const removed = entries.shift();
        removed?.row?.remove();
      }
      if (!visible(entry)) return;
      const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 40;
      entry.row = rowOf(entry);
      list.append(entry.row);
      if (nearBottom) list.scrollTop = list.scrollHeight;
    },
  };
}
