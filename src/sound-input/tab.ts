// The tab of the Voice room. The address holds it (?tab=echo), so a reload keeps the tab.
import { PRACTICE_MODES } from '../practice/practice.ts';

const TABS = ['free', ...PRACTICE_MODES, 'playoff'] as const;
export type Tab = (typeof TABS)[number];

export const isTab = (value: string | undefined): value is Tab => TABS.some((tab) => tab === value);

// Exactly one known value opens its tab. No value, an unknown value or two values open Free play.
export function readTab(params: URLSearchParams): Tab {
  const values = params.getAll('tab');
  const [value] = values;
  return values.length === 1 && isTab(value) ? value : 'free';
}

// The address with `tab`, and with the other parameters as they are. Free play needs no parameter.
export function withTab(href: string, tab: Tab): URL {
  const url = new URL(href);
  if (tab === 'free') url.searchParams.delete('tab');
  else url.searchParams.set('tab', tab);
  return url;
}
