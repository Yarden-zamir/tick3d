// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from './online.ts';
import { RESULTS_PER_UPLOAD, type ResultUpload } from './protocol.ts';

const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
// uploadResults reads only the id of a result; the server checks the rest.
const results = Array.from({ length: RESULTS_PER_UPLOAD + 1 }, (_, n) => ({ id: `result-${n}` }) as unknown as ResultUpload);

describe('the upload of finished games', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('names each refused result by its id, in every batch', async () => {
    let batch = 0;
    vi.stubGlobal('fetch', async () => {
      batch++;
      return batch === 1
        ? json({ stored: 99, renamed: { 'result-5': 'ABCD2345' }, refused: [{ index: 2, error: 'A result is not a valid finished game.' }] })
        : json({ stored: 0, renamed: {}, refused: [{ index: 0, error: 'The guest of a Nearby game needs its own player token.' }] });
    });
    const { renamed, refused } = await api.uploadResults(results);
    expect(batch).toBe(2);
    expect(renamed).toEqual(new Map([['result-5', 'ABCD2345']]));
    expect(refused).toEqual(
      new Map([
        ['result-2', 'A result is not a valid finished game.'],
        [`result-${RESULTS_PER_UPLOAD}`, 'The guest of a Nearby game needs its own player token.'],
      ]),
    );
  });

  it('fails on a refusal that names no result of the batch', async () => {
    vi.stubGlobal('fetch', async () => json({ stored: 0, renamed: {}, refused: [{ index: 500, error: 'x' }] }));
    await expect(api.uploadResults(results.slice(0, 3))).rejects.toThrow('invalid refusal');
  });
});
