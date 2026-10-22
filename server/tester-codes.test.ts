import { mkdtemp } from 'node:fs/promises';
import { DuckDBInstance } from '@duckdb/node-api';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { toEpochMs as ms } from '../src/epoch.ts';
import { replay } from '../src/game.ts';
import { parseClaimRequest, parseTesterCodeEntries, parseTesterCodes } from '../src/share/codes.ts';
import { type Store, openStore } from './store.ts';
import { ACCOUNT_TOKEN_PREFIX, type PlayerToken, personId, toRecord } from '../src/protocol.ts';
import { gravatarOf, testerCodesFromEnv } from './tester-codes.ts';

// DuckDB writes for each statement. A busy CI machine needs more than the default 5 s (as in server/store.test.ts).
vi.setConfig({ testTimeout: 20_000 });

const FREE_A = 'AAAAAAAAAAAAAAAAAAAAAA1';
const FREE_B = 'BBBBBBBBBBBBBBBBBBBBBB2';
const GIVEN = 'CCCCCCCCCCCCCCCCCCCCCC3';
const DANA = { email: 'Dana@Example.com', name: 'Dana', by: null };
const player = 'aaaaaaaa-0000-4000-8000-000000000001' as PlayerToken;

describe('the TESTER_CODES setting', () => {
  it('reads free codes and codes given out by hand, split by commas and new lines', () => {
    expect(parseTesterCodeEntries(` ${FREE_A},\n${GIVEN} = Tom Cohen \n\n${FREE_B}, `)).toEqual([
      { code: FREE_A, name: null },
      { code: GIVEN, name: 'Tom Cohen' },
      { code: FREE_B, name: null },
    ]);
    expect(parseTesterCodeEntries('')).toEqual([]);
  });

  it.each(['abcdefghijkl', 'SHORT', 'A'.repeat(31), `${FREE_A}=`, `${FREE_A}=<b>`, `${FREE_A},${FREE_A}`])('stops at a bad entry: %s', (text) => {
    expect(() => parseTesterCodeEntries(text)).toThrow(/TESTER_CODES entry/);
  });

  it('never names a full code in an error, because the API log keeps it', () => {
    expect(() => parseTesterCodeEntries(`${FREE_A},${FREE_A}`)).toThrow(/AAA…/);
    expect(() => parseTesterCodeEntries(`${FREE_A},${FREE_A}`)).not.toThrow(FREE_A);
  });

  it('seeds in production and on a local server, and never in a preview', () => {
    const codes = `${FREE_A},${GIVEN}=Tom`;
    expect(testerCodesFromEnv({ TESTER_CODES: codes, KITSHN_ENVIRONMENT: 'prod' })).toHaveLength(2);
    expect(testerCodesFromEnv({ TESTER_CODES: codes })).toHaveLength(2);
    expect(testerCodesFromEnv({ TESTER_CODES: codes, KITSHN_ENVIRONMENT: 'pr-17' })).toEqual([]);
    // A preview ignores the setting, even a bad one.
    expect(testerCodesFromEnv({ TESTER_CODES: 'bad', KITSHN_ENVIRONMENT: 'pr-17' })).toEqual([]);
    expect(testerCodesFromEnv({})).toEqual([]);
  });
});

describe('a claim request', () => {
  it('takes a trimmed email and name', () => {
    expect(parseClaimRequest({ email: ' dana@example.com ', name: '  Dana   Levi ' })).toEqual({ email: 'dana@example.com', name: 'Dana Levi', by: null });
    expect(parseClaimRequest({ email: 'dana@example.com', name: 'Dana', by: '0123456789abcdef' })?.by).toBe('0123456789abcdef');
    expect(parseClaimRequest({ email: 'dana@example.com', name: 'Dana', by: null })?.by).toBeNull();
    expect(parseClaimRequest({ email: 'o.brien@mail.co.uk', name: "Seán O'Brien" })).toBeDefined();
  });

  it.each([
    { email: 'dana', name: 'Dana' },
    { email: 'dana@example', name: 'Dana' },
    { email: 'da na@example.com', name: 'Dana' },
    { email: 'a@b@example.com', name: 'Dana' },
    { email: `${'a'.repeat(250)}@example.com`, name: 'Dana' },
    { email: 'dana@example.com', name: '' },
    { email: 'dana@example.com', name: 'x'.repeat(41) },
    { email: 'dana@example.com', name: '<script>' },
    { email: 'dana@example.com' },
    { email: 'dana@example.com', name: 'Dana', by: 'not a person' },
    { email: 'dana@example.com', name: 'Dana', by: 7 },
  ])('refuses %o', (body) => {
    expect(parseClaimRequest(body)).toBeUndefined();
  });
});

describe('the tester codes table', () => {
  let store: Store;
  beforeEach(async () => {
    store = await openStore(':memory:');
  });
  afterEach(async () => {
    await store.close();
  });

  it('adds new codes only, and keeps every claim when it seeds again', async () => {
    expect(await store.addTesterCodes(parseTesterCodeEntries(`${FREE_A},${GIVEN}=Tom`))).toBe(2);
    const [first] = (await store.testerCodes()).codes;
    if (first === undefined) throw new Error('no code');
    await store.claimTesterCode(first.id, DANA, player);
    // The secret now lists the claimed code as free, and the hand-given code with another name: the rows stay.
    expect(await store.addTesterCodes(parseTesterCodeEntries(`${FREE_A},${GIVEN}=Someone,${FREE_B}`))).toBe(1);
    expect((await store.testerCodes()).codes).toEqual([
      { id: first.id, hint: 'AAA', claimed: true, name: 'Dana', gravatar: gravatarOf('dana@example.com') },
      { id: expect.any(Number), hint: 'CCC', claimed: true, name: 'Tom', gravatar: null },
      { id: expect.any(Number), hint: 'BBB', claimed: false, name: null, gravatar: null },
    ]);
  });

  it('gives a code once, then answers 409, and 404 for an unknown id', async () => {
    await store.addTesterCodes(parseTesterCodeEntries(`${FREE_A},${GIVEN}=Tom`));
    const [free, given] = (await store.testerCodes()).codes;
    if (free === undefined || given === undefined) throw new Error('no codes');
    expect(await store.claimTesterCode(free.id, DANA, player)).toEqual({ code: FREE_A });
    await expect(store.claimTesterCode(free.id, { email: 'eve@example.com', name: 'Eve', by: null }, player)).rejects.toMatchObject({ status: 409 });
    await expect(store.claimTesterCode(given.id, DANA, player)).rejects.toMatchObject({ status: 409 });
    await expect(store.claimTesterCode(999, DANA, player)).rejects.toMatchObject({ status: 404 });
    // The second claimer did not replace the first.
    expect((await store.testerClaims()).claims).toEqual([
      { hint: 'CCC', name: 'Tom', email: null, claimedAt: expect.any(Number), invitedBy: null },
      { hint: 'AAA', name: 'Dana', email: DANA.email, claimedAt: expect.any(Number), invitedBy: null },
    ]);
  });

  it('keeps every code in its slot: the order of the first secret, claimed codes in place, new codes at the end', async () => {
    const codes = ['A', 'B', 'C', 'D'].map((letter) => letter.repeat(23));
    await store.addTesterCodes(parseTesterCodeEntries(codes.join(',')));
    const before = (await store.testerCodes()).codes;
    for (const index of [3, 1]) {
      const code = before[index];
      if (code === undefined) throw new Error('no code');
      await store.claimTesterCode(code.id, DANA, player);
    }
    // A new secret value in another order adds its new code after the others.
    await store.addTesterCodes(parseTesterCodeEntries(['E'.repeat(23), ...codes.toReversed()].join(',')));
    const after = (await store.testerCodes()).codes;
    expect(after.map((code) => code.hint)).toEqual(['AAA', 'BBB', 'CCC', 'DDD', 'EEE']);
    expect(after.map((code) => code.claimed)).toEqual([false, true, false, true, false]);
    expect(after.slice(0, 4).map((code) => code.id)).toEqual(before.map((code) => code.id));
  });

  it('never puts a full code or an email in the public list', async () => {
    await store.addTesterCodes(parseTesterCodeEntries(`${FREE_A},${FREE_B},${GIVEN}=Tom`));
    const [free] = (await store.testerCodes()).codes;
    if (free === undefined) throw new Error('no code');
    await store.claimTesterCode(free.id, DANA, player);
    const list = await store.testerCodes();
    expect(parseTesterCodes(list)).toEqual(list);
    const text = JSON.stringify(list);
    for (const secret of [FREE_A, FREE_B, GIVEN, DANA.email, DANA.email.toLowerCase()]) expect(text).not.toContain(secret);
  });
});

describe('invites', () => {
  const inviter = 'bbbbbbbb-0000-4000-8000-000000000002' as PlayerToken;
  const inviterLaptop = 'cccccccc-0000-4000-8000-000000000003' as PlayerToken;
  const GITHUB = { id: 202, login: 'bob', avatar: 'https://avatars.githubusercontent.com/u/202?v=4' };
  const codes = (count: number) => Array.from({ length: count }, (_, i) => `CODE${String(i).padStart(19, '0')}`).join(',');
  const tester = (i: number) => ({ email: `tester${i}@example.com`, name: `Tester ${i}` });
  // The browser of tester i.
  const browser = (i: number) => `eeeeeeee-0000-4000-8000-${String(i).padStart(12, '0')}` as PlayerToken;
  let store: Store;
  afterEach(async () => {
    await store.close();
  });

  const unlocked = async (token: PlayerToken) =>
    (await store.achievements(token)).achievements.filter((entry) => entry.id.startsWith('invite-')).map(({ id, count, unlockedAt }) => ({ id, count, unlocked: unlockedAt !== null }));

  it('count each person who claimed through the link once, on every device of the account', async () => {
    store = await openStore(':memory:');
    await store.addTesterCodes(parseTesterCodeEntries(codes(7)));
    // The inviter shares before the login, and later logs in on a second device too.
    const before = await store.person(inviter);
    for (let i = 1; i <= 4; i++) await store.claimTesterCode(i, { ...tester(i), by: before }, browser(i));
    await store.linkToken(inviter, GITHUB);
    await store.linkToken(inviterLaptop, GITHUB);
    const account = await store.person(inviterLaptop);
    expect(account).not.toBe(before);
    // A second code of one person counts once, also with another email.
    await store.claimTesterCode(5, { email: 'second@example.com', name: 'Tester 1', by: account }, browser(1));
    expect(await unlocked(inviterLaptop)).toEqual([
      { id: 'invite-1', count: 1, unlocked: true },
      { id: 'invite-5', count: 4, unlocked: false },
      { id: 'invite-25', count: 4, unlocked: false },
    ]);
    await store.claimTesterCode(6, { ...tester(6), by: account }, browser(6));
    expect(await unlocked(inviter)).toMatchObject([{ count: 1 }, { count: 5, unlocked: true }, { count: 5, unlocked: false }]);
    expect((await store.testerClaims()).claims.map((claim) => claim.invitedBy)).toEqual([before, before, before, before, account, account]);
    // Nobody invited the claimer: nothing counts for them.
    expect(await unlocked(player)).toMatchObject([{ count: 0 }, { count: 0 }, { count: 0 }]);
  });

  it('count no self-invite, also from another device of the same account', async () => {
    store = await openStore(':memory:');
    await store.addTesterCodes(parseTesterCodeEntries(codes(2)));
    await store.linkToken(inviter, GITHUB);
    await store.linkToken(inviterLaptop, GITHUB);
    await store.claimTesterCode(1, { ...tester(1), by: await store.person(inviter) }, inviterLaptop);
    await store.claimTesterCode(2, { ...tester(2), by: await personId(inviterLaptop) }, inviter);
    expect((await store.testerClaims()).claims.map((claim) => claim.invitedBy)).toEqual([null, null]);
    expect(await unlocked(inviter)).toMatchObject([{ count: 0 }, { count: 0 }, { count: 0 }]);
  });

  it('count an app open once per device, for the first inviter, and no self-invite', async () => {
    store = await openStore(':memory:');
    const by = await store.person(inviter);
    expect(await store.reportAppOpen(player, by)).toBe(true);
    expect(await store.reportAppOpen(player, by)).toBe(true);
    // A later link of another inviter does not move the copy.
    await store.reportAppOpen(player, await personId(inviterLaptop));
    // The inviter's own app open is a copy, but no invite.
    expect(await store.reportAppOpen(inviter, by)).toBe(true);
    expect(await unlocked(inviter)).toMatchObject([{ count: 1, unlocked: true }, { count: 1 }, { count: 1 }]);
    expect(await unlocked(inviterLaptop)).toMatchObject([{ count: 0 }, { count: 0 }, { count: 0 }]);
  });

  it('count a person once when they claimed a code and opened the app', async () => {
    store = await openStore(':memory:');
    await store.addTesterCodes(parseTesterCodeEntries(codes(2)));
    const by = await store.person(inviter);
    await store.claimTesterCode(1, { ...tester(1), by }, player);
    await store.reportAppOpen(player, by);
    // Another person opened the app without a code claim.
    await store.reportAppOpen(inviterLaptop, by);
    expect(await unlocked(inviter)).toMatchObject([{ count: 1 }, { count: 2 }, { count: 2 }]);
  });

  const ALICE = { id: 301, login: 'alice', avatar: 'https://avatars.githubusercontent.com/u/301?v=4' };
  const CAROL = { id: 302, login: 'carol', avatar: 'https://avatars.githubusercontent.com/u/302?v=4' };
  const count = async () => (await unlocked(inviter))[1]?.count;

  it('R1: a claim in the browser before a login and an app open after it count once', async () => {
    store = await openStore(':memory:');
    await store.addTesterCodes(parseTesterCodeEntries(codes(1)));
    const by = await store.person(inviter);
    const phone = browser(1);
    await store.claimTesterCode(1, { ...tester(1), by }, phone);
    await store.linkToken(phone, ALICE);
    // The app on the same phone shares the storage of Chrome, so the same device token reports.
    await store.reportAppOpen(phone, by);
    expect(await count()).toBe(1);
  });

  it('R2: a device with an invite event never adds a second person, also after a login with another account', async () => {
    store = await openStore(':memory:');
    await store.addTesterCodes(parseTesterCodeEntries(codes(1)));
    const by = await store.person(inviter);
    const phone = browser(1);
    await store.linkToken(phone, ALICE);
    await store.reportAppOpen(phone, by);
    await store.unlinkToken(phone);
    await store.linkToken(phone, CAROL);
    await store.reportAppOpen(phone, by);
    // A code claim on that device as Carol still names the same device.
    await store.claimTesterCode(1, { ...tester(2), by }, phone);
    expect(await count()).toBe(1);
  });

  it('R3: the owner of the device at its first event keeps the game, not a later account', async () => {
    const path = `${await mkdtemp('/tmp/tick3d-invites-')}/owner.duckdb`;
    store = await openStore(path);
    const by = await store.person(inviter);
    const phone = browser(1);
    await store.linkToken(phone, ALICE);
    await store.reportAppOpen(phone, by);
    await store.unlinkToken(phone);
    await store.linkToken(phone, CAROL);
    await store.reportAppOpen(phone, by);
    await store.close();
    const instance = await DuckDBInstance.create(path);
    const db = await instance.connect();
    const owners = (await db.runAndReadAll('FROM app_copies SELECT owner')).getRowObjectsJS().map((row) => row.owner);
    db.closeSync();
    instance.closeSync();
    expect(owners).toEqual([`${ACCOUNT_TOKEN_PREFIX}${String(ALICE.id).padStart(16, '0')}`]);
    store = await openStore(path);
  });

  it('R5: a claim on a laptop and an app open on a phone count once when the laptop logs in to the account later', async () => {
    store = await openStore(':memory:');
    await store.addTesterCodes(parseTesterCodeEntries(codes(1)));
    const by = await store.person(inviter);
    await store.claimTesterCode(1, { ...tester(1), by }, browser(1));
    await store.linkToken(browser(2), ALICE);
    await store.reportAppOpen(browser(2), by);
    expect(await count()).toBe(2);
    await store.linkToken(browser(1), ALICE);
    expect(await count()).toBe(1);
  });

  it('R4: two devices of one account count once', async () => {
    store = await openStore(':memory:');
    await store.addTesterCodes(parseTesterCodeEntries(codes(1)));
    const by = await store.person(inviter);
    await store.linkToken(browser(1), ALICE);
    await store.linkToken(browser(2), ALICE);
    await store.claimTesterCode(1, { ...tester(1), by }, browser(1));
    await store.reportAppOpen(browser(2), by);
    expect(await count()).toBe(1);
  });

  it('count an inviter without games in the rarity, so an unlock never shows 0% of players', async () => {
    store = await openStore(':memory:');
    await store.reportAppOpen(player, await store.person(inviter));
    const { rarity } = await store.achievements(inviter);
    expect(rarity.players).toBe(1);
    expect(rarity.unlocked['invite-1']).toBe(1);
  });

  it('count in the rarity of the players with a game', async () => {
    store = await openStore(':memory:');
    await store.addTesterCodes(parseTesterCodeEntries(codes(1)));
    const game = toRecord(replay([0, 1, 16, 2, 32, 3, 48], { times: [1, 2, 3, 4, 5, 6, 7].map((t) => ms(1_000 + t)) }));
    const options = { hideBoard: false, hideHistory: false, hideCoordinates: false };
    await store.addResults(inviter, [{ id: 'eeeeeeee-1111-4000-8000-000000000001', mode: 'computer', game, you: 'X', difficulty: 'easy', finishedAt: ms(2_000), publicId: null, options, tuned: false, metrics: null, guest: null }]);
    expect((await store.achievements(inviter)).rarity.unlocked['invite-1']).toBe(0);
    await store.claimTesterCode(1, { ...tester(1), by: await store.person(inviter) }, player);
    const { rarity } = await store.achievements(inviter);
    expect(rarity).toMatchObject({ players: 1, unlocked: { 'invite-1': 1, 'invite-5': 0 } });
  });
});

describe('the claims from before the invite links', () => {
  const YARDEN = `${ACCOUNT_TOKEN_PREFIX}${'8178413'.padStart(16, '0')}`;

  it('count as invites of Yarden once per database, so a later claim without an invite stays without one', async () => {
    const path = `${await mkdtemp('/tmp/tick3d-invites-')}/old.duckdb`;
    // A database from before this release: the tester_codes table without invited_by, one code claimed.
    const instance = await DuckDBInstance.create(path, { storage_compatibility_version: 'v1.5.0' });
    const db = await instance.connect();
    await db.run("CREATE SEQUENCE tester_code_order");
    await db.run(`CREATE TABLE tester_codes (
      id INTEGER PRIMARY KEY DEFAULT nextval('tester_code_order'), code VARCHAR NOT NULL UNIQUE, name VARCHAR, email VARCHAR,
      claimed_at TIMESTAMPTZ, added_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CHECK ((claimed_at IS NULL) = (name IS NULL) AND (email IS NULL OR name IS NOT NULL)))`);
    // GIVEN: the code that Yarden gave to himself by hand. It is no invite.
    await db.run(
      `INSERT INTO tester_codes (code, name, email, claimed_at) VALUES ('${FREE_A}', 'Dana', 'dana@example.com', now()), ('${FREE_B}', NULL, NULL, NULL), ('${GIVEN}', 'Yarden', NULL, now())`,
    );
    db.closeSync();
    instance.closeSync();

    let store = await openStore(path);
    const yarden = await personId(YARDEN);
    expect((await store.testerClaims()).claims.map((claim) => ({ name: claim.name, invitedBy: claim.invitedBy }))).toEqual([
      { name: 'Dana', invitedBy: yarden },
      { name: 'Yarden', invitedBy: null },
    ]);
    await store.claimTesterCode(2, { email: 'eve@example.com', name: 'Eve', by: null }, player);
    await store.close();

    store = await openStore(path);
    expect((await store.testerClaims()).claims.map((claim) => claim.invitedBy)).toEqual([yarden, null, null]);
    await store.close();
  });
});

describe('copies of the Android app', () => {
  const phone = 'dddddddd-0000-4000-8000-000000000001' as PlayerToken;
  const phone2 = 'dddddddd-0000-4000-8000-000000000002' as PlayerToken;
  const ALICE = { id: 401, login: 'alice', avatar: 'https://avatars.githubusercontent.com/u/401?v=4' };
  const CAROL = { id: 402, login: 'carol', avatar: 'https://avatars.githubusercontent.com/u/402?v=4' };
  let store: Store;
  beforeEach(async () => {
    store = await openStore(':memory:');
  });
  afterEach(async () => {
    await store.close();
  });

  it('belong to the account that is logged in on the device now, or to the device', async () => {
    expect(await store.hasCopy(phone)).toBe(false);
    expect(await store.reportAppOpen(phone, null)).toBe(true);
    await store.linkToken(phone, ALICE);
    expect(await store.hasCopy(phone)).toBe(true);
    // Carol logs in on the phone of Alice and holds the copy. Alice holds it again after her next login there.
    await store.unlinkToken(phone);
    await store.linkToken(phone, CAROL);
    const aliceWeb = 'dddddddd-0000-4000-8000-000000000003' as PlayerToken;
    await store.linkToken(aliceWeb, ALICE);
    expect(await store.hasCopy(phone)).toBe(true);
    expect(await store.hasCopy(aliceWeb)).toBe(false);
    await store.unlinkToken(phone);
    await store.linkToken(phone, ALICE);
    expect(await store.hasCopy(aliceWeb)).toBe(true);
    // After a logout, the device holds the copy, and the account does not.
    await store.unlinkToken(phone);
    expect(await store.hasCopy(phone)).toBe(true);
    expect(await store.hasCopy(aliceWeb)).toBe(false);
  });

  it('count for every device of the account', async () => {
    const web = 'dddddddd-0000-4000-8000-000000000003' as PlayerToken;
    await store.linkToken(web, ALICE);
    expect(await store.hasCopy(web)).toBe(false);
    await store.linkToken(phone, ALICE);
    await store.reportAppOpen(phone, null);
    expect(await store.hasCopy(web)).toBe(true);
    // Another device without a login holds no copy.
    expect(await store.hasCopy(phone2)).toBe(false);
  });

  it('of one account count as one invited person, also on two phones', async () => {
    const inviter = 'bbbbbbbb-0000-4000-8000-000000000002' as PlayerToken;
    const by = await store.person(inviter);
    // The first phone opened before the login.
    await store.reportAppOpen(phone, by);
    await store.linkToken(phone, ALICE);
    // The second phone opened while logged in to the same account.
    await store.linkToken(phone2, ALICE);
    await store.reportAppOpen(phone2, by);
    expect((await store.achievements(inviter)).achievements.find((entry) => entry.id === 'invite-5')?.count).toBe(1);
  });
});

describe('the invite pair and Family tree', () => {
  const alice = 'aaaaaaaa-1111-4000-8000-000000000001' as PlayerToken;
  const aliceLaptop = 'aaaaaaaa-1111-4000-8000-000000000002' as PlayerToken;
  const bob = 'bbbbbbbb-1111-4000-8000-000000000001' as PlayerToken;
  const bobPhone = 'bbbbbbbb-1111-4000-8000-000000000002' as PlayerToken;
  const carol = 'cccccccc-1111-4000-8000-000000000001' as PlayerToken;
  const ALICE = { id: 301, login: 'alice', avatar: 'https://avatars.githubusercontent.com/u/301?v=4' };
  const BOB = { id: 302, login: 'bob', avatar: 'https://avatars.githubusercontent.com/u/302?v=4' };
  const X_WINS = [0, 1, 16, 2, 32, 3, 48];
  const O_WINS = [4, 0, 5, 1, 6, 2, 32, 3];
  const options = { hideBoard: false, hideHistory: false, hideCoordinates: false };
  // A Nearby game that `host` (on X) uploads against `guest`. The invites happen now, so `finished` 2 s is before them.
  const nearby = (host: PlayerToken, guest: PlayerToken, moves: number[], finished: number, id: string) =>
    store.addResults(host, [
      {
        id,
        mode: 'nearby',
        game: toRecord(replay(moves, { times: moves.map((_, i) => ms(1_000 + i)) })),
        you: 'X',
        difficulty: null,
        finishedAt: ms(finished),
        publicId: null,
        options,
        tuned: false,
        metrics: null,
        guest,
      },
    ]);
  const PAIR = ['beaten-by-invitee', 'beat-inviter', 'family-tree'] as const;
  const pairOf = async (token: PlayerToken) =>
    Object.fromEntries((await store.achievements(token)).achievements.filter((entry) => PAIR.some((id) => id === entry.id)).map(({ id, unlockedAt }) => [id, unlockedAt !== null]));
  let store: Store;
  beforeEach(async () => {
    store = await openStore(':memory:');
    await store.addTesterCodes(parseTesterCodeEntries(Array.from({ length: 4 }, (_, i) => `PAIR${String(i).padStart(19, '0')}`).join(',')));
  });
  afterEach(async () => {
    await store.close();
  });

  it('unlock for the inviter who loses to the invited person, and for that person, with all their devices as one person', async () => {
    // Bob claims on his browser through Alice's link, and later plays on his phone: both devices log in to one account.
    await store.claimTesterCode(1, { email: 'bob@example.com', name: 'Bob', by: await store.person(alice) }, bob);
    await store.linkToken(bob, BOB);
    await store.linkToken(bobPhone, BOB);
    // Bob, on O, beats Alice.
    await nearby(alice, bobPhone, O_WINS, Date.now() + 1_000, 'f1f1f1f1-1111-4000-8000-000000000001');
    expect(await pairOf(alice)).toEqual({ 'beaten-by-invitee': true, 'beat-inviter': false, 'family-tree': false });
    expect(await pairOf(bobPhone)).toEqual({ 'beaten-by-invitee': false, 'beat-inviter': true, 'family-tree': false });
    // The rarity and the leaderboard read the stored rows, which count the pair too.
    const { rarity } = await store.achievements(alice);
    expect(rarity.unlocked).toMatchObject({ 'beaten-by-invitee': 1, 'beat-inviter': 1 });
  });

  it('count no game before the invite, and no win of the inviter', async () => {
    await nearby(alice, bob, O_WINS, 2_000, 'f2f2f2f2-1111-4000-8000-000000000001');
    await store.claimTesterCode(1, { email: 'bob@example.com', name: 'Bob', by: await store.person(alice) }, bob);
    await nearby(alice, bob, X_WINS, Date.now() + 1_000, 'f2f2f2f2-1111-4000-8000-000000000002');
    expect(await pairOf(alice)).toMatchObject({ 'beaten-by-invitee': false });
    expect(await pairOf(bob)).toMatchObject({ 'beat-inviter': false });
  });

  it('count no invite from yourself, also between two devices that later log in to one account', async () => {
    await store.claimTesterCode(1, { email: 'alice@example.com', name: 'Alice', by: await store.person(alice) }, aliceLaptop);
    await store.linkToken(alice, ALICE);
    await store.linkToken(aliceLaptop, ALICE);
    await nearby(alice, aliceLaptop, O_WINS, Date.now() + 1_000, 'f3f3f3f3-1111-4000-8000-000000000001');
    expect(await pairOf(alice)).toEqual({ 'beaten-by-invitee': false, 'beat-inviter': false, 'family-tree': false });
  });

  it('unlock Family tree when a person you invited brings a new person, and not when they bring you back', async () => {
    await store.claimTesterCode(1, { email: 'bob@example.com', name: 'Bob', by: await store.person(alice) }, bob);
    // Bob's link brings Alice's other device: that is Alice, no new person.
    await store.linkToken(alice, ALICE);
    await store.linkToken(aliceLaptop, ALICE);
    await store.reportAppOpen(aliceLaptop, await store.person(bob));
    expect(await pairOf(alice)).toMatchObject({ 'family-tree': false });
    await store.reportAppOpen(carol, await store.person(bob));
    expect(await pairOf(alice)).toMatchObject({ 'family-tree': true });
    // Bob brought Carol himself: that is his Plus one, not his Family tree.
    expect(await pairOf(bob)).toMatchObject({ 'family-tree': false });
    expect((await store.achievements(alice)).rarity.unlocked['family-tree']).toBe(1);
  });
});
