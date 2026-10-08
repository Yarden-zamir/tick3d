import { describe, expect, it } from 'vitest';
import { toEpochMs as ms } from './epoch.ts';
import { DELETED_NAME, parseDeletedPeople, scrubDoc, scrubUpload, scrubView } from './deletions.ts';
import { nameOf } from './names.ts';
import { type Code, type PersonId, type PlayerToken, parseSessionView, personId } from './protocol.ts';
import * as core from './session/core.ts';

const host = 'aaaaaaaa-0000-4000-8000-000000000001' as PlayerToken;
const guest = 'bbbbbbbb-0000-4000-8000-000000000002' as PlayerToken;

// A Nearby session of the host with a guest, and one chat line from each.
async function nearbyDoc() {
  const doc = core.createDoc({ name: 'Nearby', mode: 'nearby', seats: { X: host, O: guest } });
  const said = core.chat(doc, new Set([host]), 'hello', ms(1), await personId(host));
  return core.chat(said, new Set([guest]), 'hi', ms(2), await personId(guest));
}

async function cachedView() {
  const doc = await nearbyDoc();
  const view = core.viewOf(doc, {
    code: 'ABCD' as Code,
    version: 1,
    identity: new Set([host]),
    now: ms(3),
    audience: { presence: { X: true, O: true }, watchers: [], name: nameOf, person: () => null },
    players: { X: null, O: { login: 'guesty', avatar: 'https://avatars.githubusercontent.com/u/2?v=4' } },
  });
  return { ...view, people: { X: await personId(host), O: await personId(guest) } };
}

describe('deletion notices', () => {
  it('removes a deleted person from a cached view: name, account, person id and chat lines', async () => {
    const view = await cachedView();
    const deleted = new Set([await personId(guest)]);
    const scrubbed = scrubView(view, deleted);
    expect(scrubbed).toMatchObject({ names: { X: nameOf(host), O: DELETED_NAME }, players: { X: null, O: null }, people: { X: view.people.X, O: null } });
    expect(scrubbed?.chat.map((message) => message.text)).toEqual(['hello']);
    // The scrubbed copy still reads back as a view, so the cache keeps it.
    expect(parseSessionView(JSON.parse(JSON.stringify(scrubbed)))).toEqual(scrubbed);
    expect(JSON.stringify(scrubbed)).not.toContain('guesty');
    expect(scrubView(view, new Set(['0123456789abcdef' as PersonId]))).toBeUndefined();
  });

  it('frees the seat of a deleted guest in a session of a Nearby host and drops their lines', async () => {
    const doc = await nearbyDoc();
    const scrubbed = await scrubDoc(doc, new Set([await personId(guest)]));
    expect(scrubbed?.seats).toEqual({ X: host, O: null });
    expect(scrubbed?.chat.map((message) => message.text)).toEqual(['hello']);
    expect(await scrubDoc(doc, new Set())).toBeUndefined();
  });

  it('drops the token of a deleted guest from a result of the host', async () => {
    const upload = { guest } as Parameters<typeof scrubUpload>[0];
    expect(await scrubUpload(upload, new Set([await personId(guest)]))).toMatchObject({ guest: null });
    expect(await scrubUpload(upload, new Set([await personId(host)]))).toBeUndefined();
  });

  it('reads the answer of the server and refuses a bad one', () => {
    expect(parseDeletedPeople({ people: ['0123456789abcdef'], until: 5 })).toEqual({ people: ['0123456789abcdef'], until: 5 });
    expect(() => parseDeletedPeople({ people: ['not a person'], until: 5 })).toThrow();
    expect(() => parseDeletedPeople({ people: [], until: -1 })).toThrow();
  });
});
