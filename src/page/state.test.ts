// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import type { PublicGame, SessionView } from '../protocol.ts';
import { type Session, clearScreen, page, setReview, setThinking, showGame, showSession, updateSession } from './state.ts';

// Only the fields that the screen functions read. The screen keeps the object as it is.
const session = (code: string) => ({ code }) as unknown as Session;
const shown = { id: 'ABCDEFGH' } as unknown as PublicGame;

describe('the screen of the page', () => {
  it('ends the review and the computer search of a session when it leaves', () => {
    showSession(session('AB3K'));
    setReview({ game: 0, move: 2 });
    setThinking(true);
    clearScreen();
    expect([page.session, page.review, page.thinking, page.viewing]).toEqual([undefined, undefined, false, undefined]);
  });

  it('keeps the review and the search through a newer view of the same session', () => {
    showSession(session('AB3K'));
    setReview({ game: 0, move: 1 });
    setThinking(true);
    const newer = { code: 'AB3K', version: 2 } as unknown as SessionView & Session;
    updateSession(newer);
    expect([page.session, page.review, page.thinking]).toEqual([newer, { game: 0, move: 1 }, true]);
    expect(() => updateSession(session('ZZZZ'))).toThrow();
  });

  it('shows a game from a link without a session, and a session without that game', () => {
    showSession(session('AB3K'));
    setThinking(true);
    showGame(shown, { game: 0, move: 7 });
    expect([page.session, page.viewing, page.review, page.thinking]).toEqual([undefined, shown, { game: 0, move: 7 }, false]);
    showSession(session('AB3K'));
    expect([page.viewing, page.review]).toEqual([undefined, undefined]);
  });

  it('refuses a review or a search without anything on the board, and lets them be cleared', () => {
    clearScreen();
    expect(() => setReview({ game: 0, move: 0 })).toThrow();
    expect(() => setThinking(true)).toThrow();
    setReview(undefined);
    setThinking(false);
    expect(page.review).toBeUndefined();
  });
});
