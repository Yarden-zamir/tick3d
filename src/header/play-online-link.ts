// "Play online with a friend" in the Share menu of a page other than the game links to the game page with a
// request. The game page then starts an online game and shares its play link (src/page/share-menu.ts).
import { OPEN } from './my-games-link.ts';

const PLAY_ONLINE = 'play-online';

export const PLAY_ONLINE_HREF = `/?${new URLSearchParams({ [OPEN]: PLAY_ONLINE })}`;

// `url` without the request, or undefined when `url` holds none. The page shows this address, so a reload
// does not start a second game.
export function takePlayOnlineRequest(url: URL): URL | undefined {
  if (url.searchParams.get(OPEN) !== PLAY_ONLINE) return undefined;
  const clean = new URL(url);
  clean.searchParams.delete(OPEN);
  return clean;
}
