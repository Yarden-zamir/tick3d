import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseClaimRequest, parseTesterCodeEntries, parseTesterCodes } from '../src/testing/codes.ts';
import { type Store, openStore } from './store.ts';
import { gravatarOf, testerCodesFromEnv } from './tester-codes.ts';

// DuckDB writes for each statement. A busy CI machine needs more than the default 5 s (as in server/store.test.ts).
vi.setConfig({ testTimeout: 20_000 });

const FREE_A = 'AAAAAAAAAAAAAAAAAAAAAA1';
const FREE_B = 'BBBBBBBBBBBBBBBBBBBBBB2';
const GIVEN = 'CCCCCCCCCCCCCCCCCCCCCC3';
const DANA = { email: 'Dana@Example.com', name: 'Dana' };

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
    expect(parseClaimRequest({ email: ' dana@example.com ', name: '  Dana   Levi ' })).toEqual({ email: 'dana@example.com', name: 'Dana Levi' });
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
    await store.claimTesterCode(first.id, DANA);
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
    expect(await store.claimTesterCode(free.id, DANA)).toEqual({ code: FREE_A });
    await expect(store.claimTesterCode(free.id, { email: 'eve@example.com', name: 'Eve' })).rejects.toMatchObject({ status: 409 });
    await expect(store.claimTesterCode(given.id, DANA)).rejects.toMatchObject({ status: 409 });
    await expect(store.claimTesterCode(999, DANA)).rejects.toMatchObject({ status: 404 });
    // The second claimer did not replace the first.
    expect((await store.testerClaims()).claims).toEqual([
      { hint: 'CCC', name: 'Tom', email: null, claimedAt: expect.any(Number) },
      { hint: 'AAA', name: 'Dana', email: DANA.email, claimedAt: expect.any(Number) },
    ]);
  });

  it('keeps every code in its slot: the order of the first secret, claimed codes in place, new codes at the end', async () => {
    const codes = ['A', 'B', 'C', 'D'].map((letter) => letter.repeat(23));
    await store.addTesterCodes(parseTesterCodeEntries(codes.join(',')));
    const before = (await store.testerCodes()).codes;
    for (const index of [3, 1]) {
      const code = before[index];
      if (code === undefined) throw new Error('no code');
      await store.claimTesterCode(code.id, DANA);
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
    await store.claimTesterCode(free.id, DANA);
    const list = await store.testerCodes();
    expect(parseTesterCodes(list)).toEqual(list);
    const text = JSON.stringify(list);
    for (const secret of [FREE_A, FREE_B, GIVEN, DANA.email, DANA.email.toLowerCase()]) expect(text).not.toContain(secret);
  });
});
