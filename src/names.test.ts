import { describe, expect, it } from 'vitest';
import { nameOf } from './names.ts';

describe('generated player names', () => {
  it('gives one player the same name every time, as an adjective and an animal in camelCase', () => {
    const name = nameOf('player-1234567890abcdef');
    expect(nameOf('player-1234567890abcdef')).toBe(name);
    expect(name).toMatch(/^[a-z]+[A-Z][a-z]+$/);
  });

  it('spreads similar ids over many names', () => {
    const names = new Set(Array.from({ length: 1000 }, (_, i) => nameOf(`player-${i.toString().padStart(16, '0')}`)));
    expect(names.size).toBeGreaterThan(950);
  });

  it('refuses an empty id', () => {
    expect(() => nameOf('')).toThrow();
  });
});
