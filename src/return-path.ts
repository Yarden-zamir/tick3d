// The `return` parameter: a link to another page of the site carries the page to come back to. My games
// (header/my-games-link.ts) and the Voice room (sound-input/main.ts) read it.

export const RETURN = 'return';

// The page to return to, from the `return` parameter of `url`: a full URL on the origin of `url`.
// undefined when `url` holds no return, or a return that is not a path on the same origin.
export function readReturn(url: URL): string | undefined {
  const value = url.searchParams.get(RETURN);
  if (value === null || !value.startsWith('/')) return undefined;
  const target = new URL(value, url.origin);
  // A value such as "//example.com" is a path to another site.
  return target.origin === url.origin ? target.href : undefined;
}

// `href` (a path, with or without a query) with `returnPath` as its return.
export function withReturn(href: string, returnPath: string): string {
  // The base only parses the path. The result keeps no origin.
  const url = new URL(href, 'http://path.invalid');
  url.searchParams.set(RETURN, returnPath);
  return `${url.pathname}${url.search}${url.hash}`;
}
