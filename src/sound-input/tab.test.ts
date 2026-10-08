import { describe, expect, it } from 'vitest';
import { readTab, withTab } from './tab.ts';

const read = (query: string) => readTab(new URLSearchParams(query));

describe('the tab in the address', () => {
  it('opens each known tab', () => {
    for (const tab of ['free', 'targets', 'echo', 'playoff'] as const) expect(read(`tab=${tab}`)).toBe(tab);
  });

  it('opens Free play for no value, an unknown value or two values', () => {
    for (const query of ['', 'tab=', 'tab=Echo', 'tab=echo%20', 'tab=mode', 'mode=echo', 'tab=echo&tab=targets']) expect(read(query)).toBe('free');
  });

  it('writes the tab and keeps the other parameters', () => {
    const url = withTab('https://tick3d.example.com/sound-input?code=ABCD&return=%2F&tab=targets', 'echo');
    expect(url.searchParams.get('tab')).toBe('echo');
    expect(url.searchParams.get('code')).toBe('ABCD');
    expect(url.searchParams.get('return')).toBe('/');
    expect(withTab(url.href, 'free').searchParams.has('tab')).toBe(false);
  });
});
