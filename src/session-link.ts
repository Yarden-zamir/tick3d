// The link of an online session: `/?code=<code>` takes a free seat, and `&watch=1` only watches.
import type { Code } from './protocol.ts';

const CODE = 'code';
const WATCH = 'watch';

export type LinkIntent = 'play' | 'watch';

export const sessionLink = (origin: string, code: Code, intent: LinkIntent): string =>
  `${origin}/?${new URLSearchParams(intent === 'watch' ? { [CODE]: code, [WATCH]: '1' } : { [CODE]: code })}`;

// The intent of a link. Only one `watch=1` is valid. Any other `watch` value is 'invalid'.
export function readLinkIntent(params: URLSearchParams): LinkIntent | 'invalid' {
  const values = params.getAll(WATCH);
  if (values.length === 0) return 'play';
  return values.length === 1 && values[0] === '1' ? 'watch' : 'invalid';
}

// `url` with `watch=1` when `watch` is true, else without any `watch` value.
export function withWatch(url: URL, watch: boolean): URL {
  const next = new URL(url);
  next.searchParams.delete(WATCH);
  if (watch) next.searchParams.set(WATCH, '1');
  return next;
}
