// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OnlineError, api } from '../online.ts';
import { page } from './state.ts';
import { reportAppOpen } from './app-copy.ts';

vi.mock('../online.ts', async (importOriginal) => {
  const original = await importOriginal<typeof import('../online.ts')>();
  return { ...original, api: { ...original.api, reportAppOpen: vi.fn() } };
});
vi.mock('./state.ts', () => ({ page: { account: {} } }));
vi.mock('./play-open.ts', () => ({ receivePlayOpen: () => undefined }));
vi.mock('./render.ts', () => ({ render: vi.fn() }));

beforeEach(() => {
  localStorage.clear();
  history.replaceState(null, '', '/?playProof=signed-proof');
  vi.mocked(api.reportAppOpen).mockReset();
  page.account = { loginAvailable: false, user: null, name: null, googleLogin: false, googleOneTapClient: null, githubLogin: null, googleConnected: false, person: null, hasCopy: true };
});

describe('app open purchase errors', () => {
  it.each([undefined, 403, 503])('keeps the current copy state without surfacing an OnlineError (%s)', async (status) => {
    vi.mocked(api.reportAppOpen).mockRejectedValue(new OnlineError('Purchase check failed', status));
    for (const hasCopy of [true, false]) {
      page.account = { ...page.account, hasCopy };
      const previous = page.account;
      history.replaceState(null, '', '/?playProof=signed-proof');
      await expect(reportAppOpen()).resolves.toBeUndefined();
      expect(page.account).toBe(previous);
      expect(page.account.hasCopy).toBe(hasCopy);
    }
    expect(api.reportAppOpen).toHaveBeenCalledWith({ by: null, proof: 'signed-proof', store: 'play' });
  });
  it('still surfaces an unexpected programming error', async () => {
    const error = new Error('invalid purchase answer');
    vi.mocked(api.reportAppOpen).mockRejectedValue(error);
    await expect(reportAppOpen()).rejects.toBe(error);
  });
  it('uses a successful negative answer to update the copy state', async () => {
    vi.mocked(api.reportAppOpen).mockResolvedValue(false);
    await reportAppOpen();
    expect(page.account.hasCopy).toBe(false);
  });
});
