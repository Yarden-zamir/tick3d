// The account button of a page other than the game links to the game page with a request to open
// My games. The request carries the page to return to after a GitHub login.
import { RETURN, readReturn } from '../return-path.ts';

const OPEN = 'open';
const MY_GAMES = 'my-games';

// `returnTo` is a full URL on the origin of the game page. Without it, the login returns to the game page.
type MyGamesRequest = { returnTo: string | undefined };

// The address of the game page that opens My games. `returnPath` is the path of the page that links to it.
export function myGamesHref(returnPath: string): string {
  return `/?${new URLSearchParams({ [OPEN]: MY_GAMES, [RETURN]: returnPath })}`;
}

// The My games request in `url`, or undefined when `url` holds none.
export function readMyGamesRequest(url: URL): MyGamesRequest | undefined {
  if (url.searchParams.get(OPEN) !== MY_GAMES) return undefined;
  return { returnTo: readReturn(url) };
}

// `url` without the My games request, so a reload does not open the dialog again.
export function withoutMyGamesRequest(url: URL): URL {
  const clean = new URL(url);
  clean.searchParams.delete(OPEN);
  clean.searchParams.delete(RETURN);
  return clean;
}
