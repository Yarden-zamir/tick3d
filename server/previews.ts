// The previews list (GET /api/previews): the open pull requests of the repository that have a live preview.
//
// The data comes from the public GitHub REST API without a token. GitHub allows 60 such calls per hour
// per address, and production and every preview share the address of the VPS. So:
// - the whole answer is cached for PREVIEWS_CACHE_MS, and one refresh serves every request that waits for it;
// - the commits of a pull request are read again only when its head commit changes;
// - when GitHub says that few calls are left, the server makes no call until the limit resets;
// - on any GitHub failure, the server keeps the last good list and adds a note.
// "Live" means that https://pr.<n>.<domain>/api/health answers { ok: true } now. That costs no GitHub call.
import { PREVIEWS_CACHE_MS } from './api-docs.ts';
import { type Contributor, type PlayerInfo, type Preview, type Previews, PREVIEW_DESCRIPTION_LENGTH, parsePlayerInfo } from '../src/protocol.ts';

// GitHub returns at most this many pull requests in one page, the most recently updated first.
export const MAX_PULLS = 30;
// GitHub returns at most 100 commits in one page. A pull request with more shows the first 100 only.
export const MAX_COMMITS = 100;
export const MAX_CONTRIBUTORS = 20;
// The server keeps this many GitHub calls of the hour for other uses (the login does not count: it uses a user token).
const RATE_RESERVE = 5;
const HEALTH_TIMEOUT_MS = 3_000;
const GITHUB_TIMEOUT_MS = 10_000;

export type PreviewsConfig = {
  // owner/name of the GitHub repository, for example Yarden-zamir/tick3d.
  repo: string;
  // The previews live at https://pr.<n>.<domain>.
  domain: string;
};

const REPO_CHARS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_.';

export function previewsConfigFromEnv(env: NodeJS.ProcessEnv): PreviewsConfig | undefined {
  const { PREVIEWS_REPO, PREVIEWS_DOMAIN } = env;
  // A local or LAN host has no previews, so it sets neither value.
  if (!PREVIEWS_REPO && !PREVIEWS_DOMAIN) return undefined;
  if (!PREVIEWS_REPO || !PREVIEWS_DOMAIN) throw new Error('The previews list needs both PREVIEWS_REPO and PREVIEWS_DOMAIN');
  const parts = PREVIEWS_REPO.split('/');
  if (parts.length !== 2 || !parts.every((part) => part.length > 0 && [...part].every((char) => REPO_CHARS.includes(char)))) {
    throw new Error('PREVIEWS_REPO must be owner/name');
  }
  return { repo: PREVIEWS_REPO, domain: PREVIEWS_DOMAIN };
}

// ---- Reading the GitHub answers ----

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

// A GitHub account that is a person. parsePlayerInfo refuses the "[bot]" logins and avatars from other hosts.
function accountOf(value: unknown): PlayerInfo | undefined {
  if (!isRecord(value) || value.type === 'Bot') return undefined;
  return parsePlayerInfo({ login: value.login, avatar: value.avatar_url });
}

type Pull = { number: number; title: string; body: string; url: string; updatedAt: number; draft: boolean; head: string; author: PlayerInfo | undefined };

// One pull request from GET /repos/{repo}/pulls. Returns undefined for an entry that is not as documented.
export function parsePull(value: unknown): Pull | undefined {
  if (!isRecord(value) || !isRecord(value.head)) return undefined;
  const { number, title, body, html_url: url, updated_at: updated, draft } = value;
  const head = value.head.sha;
  if (typeof number !== 'number' || !Number.isInteger(number) || number < 1) return undefined;
  if (typeof title !== 'string' || typeof url !== 'string' || !url.startsWith('https://github.com/')) return undefined;
  if (typeof head !== 'string' || typeof updated !== 'string') return undefined;
  const updatedAt = Date.parse(updated);
  if (Number.isNaN(updatedAt)) return undefined;
  return {
    number,
    title,
    body: typeof body === 'string' ? body : '',
    url,
    updatedAt,
    draft: draft === true,
    head,
    author: accountOf(value.user),
  };
}

// The noreply address of a GitHub account: <id>+<login>@users.noreply.github.com.
// Limit: the older form without the id has no avatar address, so it is left out. Other addresses
// have no known account. Revisit when contributors without the id form show up.
function coAuthorOf(line: string): PlayerInfo | undefined {
  const start = line.indexOf('<');
  const end = line.indexOf('@users.noreply.github.com>');
  if (start === -1 || end <= start) return undefined;
  const [id, login, ...rest] = line.slice(start + 1, end).split('+');
  if (id === undefined || login === undefined || rest.length > 0 || id === '' || ![...id].every(isDigit)) return undefined;
  return parsePlayerInfo({ login, avatar: `https://avatars.githubusercontent.com/u/${id}?v=4` });
}

const isDigit = (char: string) => char >= '0' && char <= '9';
const CO_AUTHOR = 'co-authored-by:';

// The people behind one commit from GET /repos/{repo}/pulls/{n}/commits: its GitHub author and its co-authors.
export function commitPeople(value: unknown): PlayerInfo[] {
  if (!isRecord(value)) return [];
  const people: PlayerInfo[] = [];
  const author = accountOf(value.author);
  if (author !== undefined) people.push(author);
  const message = isRecord(value.commit) ? value.commit.message : undefined;
  if (typeof message !== 'string') return people;
  for (const line of message.split('\n')) {
    if (!line.trim().toLowerCase().startsWith(CO_AUTHOR)) continue;
    const coAuthor = coAuthorOf(line);
    if (coAuthor !== undefined) people.push(coAuthor);
  }
  return people;
}

// The author of the pull request and the people behind its commits, once each, most commits first.
// A tie keeps the first seen order, so the author of the pull request comes first.
export function mergeContributors(author: PlayerInfo | undefined, commits: readonly PlayerInfo[][]): Contributor[] {
  const byLogin = new Map<string, PlayerInfo & { commits: number }>();
  if (author !== undefined) byLogin.set(author.login.toLowerCase(), { ...author, commits: 0 });
  for (const people of commits) {
    // A commit counts once for each person, also when a trailer names its author again.
    const seen = new Set<string>();
    for (const person of people) {
      const key = person.login.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      const entry = byLogin.get(key) ?? { ...person, commits: 0 };
      entry.commits++;
      byLogin.set(key, entry);
    }
  }
  return [...byLogin.values()]
    .sort((a, b) => b.commits - a.commits)
    .slice(0, MAX_CONTRIBUTORS)
    .map(({ login, avatar }) => ({ login, avatar, url: `https://github.com/${login}` }));
}

// The first paragraph of a pull request body as plain text, at most PREVIEW_DESCRIPTION_LENGTH characters.
// Limit: it removes the common Markdown only (headings, lists, quotes, code fences, links, bold and code marks).
// Revisit when a description shows raw Markdown that matters.
export function summaryOf(body: string): string {
  let text = body.replaceAll('\r', '');
  // HTML comments, such as the hints of a pull request template.
  for (let start = text.indexOf('<!--'); start !== -1; start = text.indexOf('<!--')) {
    const end = text.indexOf('-->', start);
    text = text.slice(0, start) + (end === -1 ? '' : text.slice(end + 3));
  }
  const lines: string[] = [];
  let fence = false;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('```')) {
      fence = !fence;
      continue;
    }
    if (fence || line.startsWith('#')) {
      if (lines.length > 0) break;
      continue;
    }
    if (line === '') {
      if (lines.length > 0) break;
      continue;
    }
    lines.push(stripLineMarks(line));
  }
  const plain = lines
    .join(' ')
    // Links and images keep their text only. A string method cannot match the nested brackets simply.
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replaceAll('**', '')
    .replaceAll('__', '')
    .replaceAll('~~', '')
    .replaceAll('`', '')
    .replaceAll('\t', ' ')
    .split(' ')
    .filter(Boolean)
    .join(' ');
  if (plain.length <= PREVIEW_DESCRIPTION_LENGTH) return plain;
  const cut = plain.slice(0, PREVIEW_DESCRIPTION_LENGTH - 1);
  const space = cut.lastIndexOf(' ');
  return `${space > PREVIEW_DESCRIPTION_LENGTH / 2 ? cut.slice(0, space) : cut}…`;
}

function stripLineMarks(line: string): string {
  for (const mark of ['- [ ] ', '- [x] ', '> ', '- ', '* ', '+ ']) if (line.startsWith(mark)) return stripLineMarks(line.slice(mark.length));
  const dot = line.indexOf('. ');
  if (dot > 0 && dot <= 3 && line.slice(0, dot).split('').every(isDigit)) return line.slice(dot + 2);
  return line;
}

// ---- The list ----

class GitHubError extends Error {}

export function createPreviews(config: PreviewsConfig, fetchImpl: typeof fetch = fetch, now: () => number = Date.now) {
  const api = `https://api.github.com/repos/${config.repo}`;
  // The contributors of each pull request, by number, with the head commit that they belong to.
  let contributorCache = new Map<number, { head: string; contributors: Contributor[] }>();
  let last: Preview[] | undefined;
  let freshUntil = 0;
  // No GitHub call before this time: the hourly limit is (nearly) used up.
  let pausedUntil = 0;
  let refreshing: Promise<Previews> | undefined;

  async function github(path: string): Promise<unknown> {
    if (now() < pausedUntil) throw new GitHubError('the GitHub limit is used up');
    let response: Response;
    try {
      response = await fetchImpl(`${api}${path}`, {
        headers: { accept: 'application/vnd.github+json', 'user-agent': 'tick3d', 'x-github-api-version': '2022-11-28' },
        signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
      });
    } catch (error) {
      throw new GitHubError(`GitHub is out of reach: ${error instanceof Error ? error.message : String(error)}`);
    }
    const remaining = Number(response.headers.get('x-ratelimit-remaining'));
    const reset = Number(response.headers.get('x-ratelimit-reset'));
    // The reset time is in epoch seconds. Without a usable value, wait one cache period.
    if (response.headers.has('x-ratelimit-remaining') && remaining <= RATE_RESERVE) {
      pausedUntil = Number.isFinite(reset) && reset > 0 ? reset * 1000 : now() + PREVIEWS_CACHE_MS;
    }
    if (!response.ok) throw new GitHubError(`GitHub answered ${response.status} for ${path}`);
    try {
      return await response.json();
    } catch {
      throw new GitHubError(`GitHub sent no JSON for ${path}`);
    }
  }

  async function contributorsOf(pull: Pull, fresh: Map<number, { head: string; contributors: Contributor[] }>): Promise<Contributor[]> {
    const cached = contributorCache.get(pull.number);
    if (cached?.head === pull.head) {
      fresh.set(pull.number, cached);
      return cached.contributors;
    }
    try {
      const commits = await github(`/pulls/${pull.number}/commits?per_page=${MAX_COMMITS}`);
      if (!Array.isArray(commits)) throw new GitHubError(`GitHub sent no commit list for #${pull.number}`);
      const contributors = mergeContributors(pull.author, commits.slice(0, MAX_COMMITS).map(commitPeople));
      fresh.set(pull.number, { head: pull.head, contributors });
      return contributors;
    } catch (error) {
      if (!(error instanceof GitHubError)) throw error;
      // The author alone, and no cache entry, so the next refresh tries the commits again.
      console.error('previews:', error.message);
      return mergeContributors(pull.author, []);
    }
  }

  async function isLive(number: number): Promise<boolean> {
    try {
      const response = await fetchImpl(`${previewUrl(number)}/api/health`, { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) });
      const body: unknown = response.ok ? await response.json() : undefined;
      return isRecord(body) && body.ok === true;
    } catch {
      return false;
    }
  }

  const previewUrl = (number: number) => `https://pr.${number}.${config.domain}`;

  async function refresh(): Promise<Preview[]> {
    const answer = await github(`/pulls?state=open&sort=updated&direction=desc&per_page=${MAX_PULLS}`);
    if (!Array.isArray(answer)) throw new GitHubError('GitHub sent no pull request list');
    const pulls = answer
      .slice(0, MAX_PULLS)
      .map(parsePull)
      .filter((pull) => pull !== undefined);
    const fresh = new Map<number, { head: string; contributors: Contributor[] }>();
    const previews = await Promise.all(
      pulls.map(async (pull): Promise<Preview | undefined> => {
        if (!(await isLive(pull.number))) return undefined;
        return {
          number: pull.number,
          title: pull.title,
          description: summaryOf(pull.body),
          url: pull.url,
          previewUrl: previewUrl(pull.number),
          updatedAt: pull.updatedAt,
          draft: pull.draft,
          contributors: await contributorsOf(pull, fresh),
        };
      }),
    );
    // Closed pull requests drop out of the cache here.
    contributorCache = fresh;
    return previews.filter((preview) => preview !== undefined);
  }

  const main = `https://${config.domain}`;

  async function load(): Promise<Previews> {
    try {
      last = await refresh();
      return { main, previews: last, error: null };
    } catch (error) {
      if (!(error instanceof GitHubError)) throw error;
      console.error('previews:', error.message);
      return { main, previews: last ?? [], error: last === undefined ? 'GitHub did not answer. Try again later.' : 'GitHub did not answer. The list can be old.' };
    }
  }

  let current: Previews = { main, previews: [], error: null };

  return {
    // The list, at most PREVIEWS_CACHE_MS old. Requests during a refresh wait for that one refresh.
    async list(): Promise<Previews> {
      if (now() < freshUntil) return current;
      refreshing ??= load()
        .then((result) => (current = result))
        .finally(() => {
          // A failure also waits one cache period, so a GitHub outage does not cost a call per request.
          freshUntil = now() + PREVIEWS_CACHE_MS;
          refreshing = undefined;
        });
      return refreshing;
    },
  };
}

export type PreviewList = ReturnType<typeof createPreviews>;
