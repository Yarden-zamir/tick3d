import { describe, expect, it } from 'vitest';
import { parsePreviews } from '../src/protocol.ts';
import { PREVIEWS_CACHE_MS } from './api-docs.ts';
import { MAX_COMMITS, MAX_CONTRIBUTORS, MAX_PULLS, commitPeople, createPreviews, mergeContributors, parsePull, previewsConfigFromEnv, summaryOf } from './previews.ts';

const config = { repo: 'octo/game', domain: 'game.example.com' };
const avatar = (id: number) => `https://avatars.githubusercontent.com/u/${id}?v=4`;
const user = (login: string, id: number, type = 'User') => ({ login, avatar_url: avatar(id), type });

const pull = (number: number, fields: Record<string, unknown> = {}) => ({
  number,
  title: `Pull ${number}`,
  body: `Body of ${number}.`,
  html_url: `https://github.com/octo/game/pull/${number}`,
  updated_at: '2026-10-05T10:00:00Z',
  draft: false,
  user: user('alice', 1),
  head: { sha: `sha-${number}` },
  ...fields,
});

const commit = (author: unknown, message = 'fix: a thing') => ({ author, commit: { message } });

type Answer = { status?: number; body: unknown; headers?: Record<string, string> };

// A fake GitHub and fake previews. `routes` maps a URL to its answer; a missing URL fails like a network error.
function fakeFetch(routes: Record<string, Answer | (() => Answer)>) {
  const calls: string[] = [];
  const impl = (async (url: string) => {
    calls.push(url);
    const route = routes[url];
    if (route === undefined) throw new TypeError('fetch failed');
    const answer = typeof route === 'function' ? route() : route;
    return new Response(JSON.stringify(answer.body), { status: answer.status ?? 200, headers: answer.headers ?? {} });
  }) as typeof fetch;
  const githubCalls = () => calls.filter((url) => url.startsWith('https://api.github.com/'));
  return { impl, calls, githubCalls };
}

const PULLS_URL = `https://api.github.com/repos/octo/game/pulls?state=open&sort=updated&direction=desc&per_page=${MAX_PULLS}`;
const commitsUrl = (n: number) => `https://api.github.com/repos/octo/game/pulls/${n}/commits?per_page=${MAX_COMMITS}`;
const healthUrl = (n: number) => `https://pr.${n}.game.example.com/api/health`;
const LIVE: Answer = { body: { ok: true, lan: null } };

describe('previews settings', () => {
  it('is off without settings and stops on half the settings or a bad repo name', () => {
    expect(previewsConfigFromEnv({})).toBeUndefined();
    expect(previewsConfigFromEnv({ PREVIEWS_REPO: 'octo/game', PREVIEWS_DOMAIN: 'game.example.com' })).toEqual(config);
    expect(() => previewsConfigFromEnv({ PREVIEWS_REPO: 'octo/game' })).toThrow();
    expect(() => previewsConfigFromEnv({ PREVIEWS_REPO: 'octo', PREVIEWS_DOMAIN: 'x' })).toThrow();
    expect(() => previewsConfigFromEnv({ PREVIEWS_REPO: 'octo/../x', PREVIEWS_DOMAIN: 'x' })).toThrow();
  });
});

describe('reading the GitHub answers', () => {
  it('reads a pull request and refuses an entry that is not as documented', () => {
    expect(parsePull(pull(3, { body: null, draft: true }))).toMatchObject({ number: 3, body: '', draft: true, head: 'sha-3', author: { login: 'alice' } });
    expect(parsePull(pull(3, { number: '3' }))).toBeUndefined();
    expect(parsePull(pull(3, { html_url: 'https://evil.example.org/pull/3' }))).toBeUndefined();
    expect(parsePull(pull(3, { updated_at: 'yesterday' }))).toBeUndefined();
    expect(parsePull(pull(3, { head: null }))).toBeUndefined();
    expect(parsePull(null)).toBeUndefined();
  });

  it('leaves out bots and accounts with an avatar from elsewhere', () => {
    expect(commitPeople(commit(user('dependabot[bot]', 2, 'Bot')))).toEqual([]);
    expect(commitPeople(commit(user('renovate', 2, 'Bot')))).toEqual([]);
    expect(commitPeople(commit({ login: 'eve', avatar_url: 'https://evil.example.org/a.png', type: 'User' }))).toEqual([]);
    // A commit by an e-mail address without a GitHub account has a null author.
    expect(commitPeople(commit(null))).toEqual([]);
    expect(parsePull(pull(3, { user: user('dependabot[bot]', 2, 'Bot') }))?.author).toBeUndefined();
  });

  it('reads co-authors from GitHub noreply addresses only', () => {
    const message = [
      'feat: a thing',
      '',
      'Co-authored-by: Bob <2+bob@users.noreply.github.com>',
      'co-authored-by: Carol <carol@example.com>',
      'Co-Authored-By: Claude <noreply@anthropic.com>',
      'Co-authored-by: Old <old@users.noreply.github.com>',
      'Co-authored-by: Bot <3+helper[bot]@users.noreply.github.com>',
    ].join('\n');
    expect(commitPeople(commit(user('alice', 1), message))).toEqual([
      { login: 'alice', avatar: avatar(1) },
      { login: 'bob', avatar: avatar(2) },
    ]);
  });

  it('merges the author and the commit authors once each, most commits first, author first on a tie', () => {
    const alice = { login: 'alice', avatar: avatar(1) };
    const bob = { login: 'bob', avatar: avatar(2) };
    const carol = { login: 'carol', avatar: avatar(3) };
    expect(mergeContributors(alice, [[bob], [carol, bob], [alice], [{ ...bob, login: 'BOB' }, bob]]).map((c) => c.login)).toEqual(['bob', 'alice', 'carol']);
    expect(mergeContributors(alice, [[bob]]).map((c) => c.login)).toEqual(['bob', 'alice']);
    expect(mergeContributors(alice, [[alice], [bob]])).toEqual([
      { login: 'alice', avatar: avatar(1), url: 'https://github.com/alice' },
      { login: 'bob', avatar: avatar(2), url: 'https://github.com/bob' },
    ]);
    expect(mergeContributors(undefined, [])).toEqual([]);
  });
});

describe('the description', () => {
  it('takes the first paragraph as plain text', () => {
    const body = [
      '<!-- Describe the change -->',
      '## Summary',
      '',
      'Adds a **sound** menu with [eleven sets](https://example.com) and `cells` as the default.',
      'It stays the same.',
      '',
      '## Details',
      'More text.',
    ].join('\r\n');
    expect(summaryOf(body)).toBe('Adds a sound menu with eleven sets and cells as the default. It stays the same.');
  });

  it('removes list marks, skips code fences and gives an empty text for an empty body', () => {
    expect(summaryOf('```\ncode\n```\n- [x] one\n- two\n1. three\n> four')).toBe('one two three four');
    expect(summaryOf('')).toBe('');
    expect(summaryOf('## Only a heading')).toBe('');
  });

  it('cuts a long text at a word, within the limit', () => {
    const text = summaryOf('word '.repeat(200));
    expect(text.length).toBeLessThanOrEqual(280);
    expect(text.endsWith('word…')).toBe(true);
  });
});

describe('the previews list', () => {
  function setup(routes: Record<string, Answer | (() => Answer)>) {
    let time = 1_000_000;
    const github = fakeFetch(routes);
    const previews = createPreviews(config, github.impl, () => time);
    return { previews, github, advance: (ms: number) => (time += ms), at: (ms: number) => (time = ms) };
  }

  it('lists only the live previews, with their contributors, in the page shape', async () => {
    const { previews } = setup({
      [PULLS_URL]: { body: [pull(5, { draft: true }), pull(6), pull(7), { broken: true }] },
      [commitsUrl(5)]: { body: [commit(user('bob', 2)), commit(user('bob', 2)), commit(user('alice', 1))] },
      [commitsUrl(6)]: { body: [] },
      [healthUrl(5)]: LIVE,
      // 6 answers, but not as the API does: a catch-all page is not a live preview.
      [healthUrl(6)]: { body: '<html>' },
      // 7 has no preview at all (a network error).
    });
    const list = await previews.list();
    expect(list.error).toBeNull();
    expect(list.previews).toEqual([
      {
        number: 5,
        title: 'Pull 5',
        description: 'Body of 5.',
        url: 'https://github.com/octo/game/pull/5',
        previewUrl: 'https://pr.5.game.example.com',
        updatedAt: Date.parse('2026-10-05T10:00:00Z'),
        draft: true,
        contributors: [
          { login: 'bob', avatar: avatar(2), url: 'https://github.com/bob' },
          { login: 'alice', avatar: avatar(1), url: 'https://github.com/alice' },
        ],
      },
    ]);
    // The page parser takes what the server sends.
    expect(parsePreviews(list)).toEqual(list);
  });

  it('asks GitHub once per cache period, also for requests at the same time', async () => {
    const { previews, github, advance } = setup({ [PULLS_URL]: { body: [pull(5)] }, [commitsUrl(5)]: { body: [] }, [healthUrl(5)]: LIVE });
    await Promise.all([previews.list(), previews.list(), previews.list()]);
    advance(PREVIEWS_CACHE_MS - 1);
    await previews.list();
    expect(github.githubCalls()).toEqual([PULLS_URL, commitsUrl(5)]);
    advance(1);
    await previews.list();
    // The head commit did not change, so the commits are not read again.
    expect(github.githubCalls()).toEqual([PULLS_URL, commitsUrl(5), PULLS_URL]);
  });

  it('reads the commits again when the head commit changes', async () => {
    let head = 'a';
    const { previews, github, advance } = setup({
      [PULLS_URL]: () => ({ body: [pull(5, { head: { sha: head } })] }),
      [commitsUrl(5)]: { body: [] },
      [healthUrl(5)]: LIVE,
    });
    await previews.list();
    head = 'b';
    advance(PREVIEWS_CACHE_MS);
    await previews.list();
    expect(github.githubCalls().filter((url) => url === commitsUrl(5))).toHaveLength(2);
  });

  it('keeps the last list when GitHub fails, and waits a cache period before it asks again', async () => {
    let up = true;
    const { previews, github, advance } = setup({
      [PULLS_URL]: () => (up ? { body: [pull(5)] } : { status: 502, body: { message: 'Bad gateway' } }),
      [commitsUrl(5)]: { body: [] },
      [healthUrl(5)]: LIVE,
    });
    expect((await previews.list()).previews).toHaveLength(1);
    up = false;
    advance(PREVIEWS_CACHE_MS);
    const stale = await previews.list();
    expect(stale.previews).toHaveLength(1);
    expect(stale.error).toContain('old');
    const calls = github.githubCalls().length;
    await previews.list();
    expect(github.githubCalls()).toHaveLength(calls);
  });

  it('answers an empty list with a note when GitHub fails the first time', async () => {
    const { previews } = setup({ [PULLS_URL]: { body: { message: 'Not Found' } } });
    const list = await previews.list();
    expect(list.previews).toEqual([]);
    expect(list.error).not.toBeNull();
  });

  it('shows the author alone when the commits fail, and tries the commits again later', async () => {
    let commitsUp = false;
    const { previews, github, advance } = setup({
      [PULLS_URL]: { body: [pull(5)] },
      [commitsUrl(5)]: () => (commitsUp ? { body: [commit(user('bob', 2))] } : { status: 500, body: {} }),
      [healthUrl(5)]: LIVE,
    });
    expect((await previews.list()).previews[0]?.contributors.map((c) => c.login)).toEqual(['alice']);
    commitsUp = true;
    advance(PREVIEWS_CACHE_MS);
    expect((await previews.list()).previews[0]?.contributors.map((c) => c.login)).toEqual(['bob', 'alice']);
    expect(github.githubCalls().filter((url) => url === commitsUrl(5))).toHaveLength(2);
  });

  it('stops asking GitHub until the reset when the hourly limit is nearly used up', async () => {
    const resetSeconds = 2_000;
    const { previews, github, at } = setup({
      [PULLS_URL]: { body: [pull(5)], headers: { 'x-ratelimit-remaining': '3', 'x-ratelimit-reset': String(resetSeconds) } },
      [healthUrl(5)]: LIVE,
    });
    // The commits call comes after the pull list in the same refresh, so the pause already blocks it.
    expect((await previews.list()).previews[0]?.contributors.map((c) => c.login)).toEqual(['alice']);
    expect(github.githubCalls()).toEqual([PULLS_URL]);
    at(resetSeconds * 1000 - 1);
    expect((await previews.list()).error).toContain('old');
    expect(github.githubCalls()).toEqual([PULLS_URL]);
    at(resetSeconds * 1000 + PREVIEWS_CACHE_MS);
    await previews.list();
    // The new answer says that a new hour started long ago, so the commits call goes out too.
    expect(github.githubCalls()).toEqual([PULLS_URL, PULLS_URL, commitsUrl(5)]);
  });

  it('reads at most MAX_PULLS pull requests and MAX_COMMITS commits each', async () => {
    const many = Array.from({ length: MAX_PULLS + 5 }, (_, i) => pull(i + 1));
    const commits = Array.from({ length: MAX_COMMITS + 5 }, (_, i) => commit(user(`dev${i}`, i + 10)));
    const routes: Record<string, Answer> = { [PULLS_URL]: { body: many } };
    for (let n = 1; n <= MAX_PULLS + 5; n++) {
      routes[commitsUrl(n)] = { body: commits };
      routes[healthUrl(n)] = LIVE;
    }
    const { previews, github } = setup(routes);
    const list = await previews.list();
    expect(list.previews).toHaveLength(MAX_PULLS);
    expect(github.calls).not.toContain(healthUrl(MAX_PULLS + 1));
    expect(list.previews[0]?.contributors).toHaveLength(MAX_CONTRIBUTORS);
  });
});
