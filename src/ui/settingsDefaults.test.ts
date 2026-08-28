import { beforeEach, describe, expect, it, vi } from 'vitest';
import { loadStoredDefault, storeDefault } from './settingsDefaults';

function stubLocalStorage() {
  const store = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => store.set(key, value),
  });
  return store;
}

describe('settingsDefaults', () => {
  beforeEach(() => stubLocalStorage());

  it('falls back to the factory when nothing was ever stored', () => {
    expect(loadStoredDefault('k', () => ({ a: 1, b: 2 }))).toEqual({ a: 1, b: 2 });
  });

  it('round-trips whatever was stored', () => {
    storeDefault('k', { a: 5, b: 6 });
    expect(loadStoredDefault('k', () => ({ a: 1, b: 2 }))).toEqual({ a: 5, b: 6 });
  });

  it('fills in a field the factory has but the stored value predates, instead of dropping it', () => {
    storeDefault('k', { a: 5 });
    // A field added to the shape after this was saved should still show up,
    // rather than the old save silently deleting it.
    expect(loadStoredDefault('k', () => ({ a: 1, b: 2 }))).toEqual({ a: 5, b: 2 });
  });

  it('falls back to the factory on corrupt stored JSON instead of throwing', () => {
    vi.stubGlobal('localStorage', { getItem: () => '{not json', setItem: vi.fn() });
    expect(loadStoredDefault('k', () => ({ a: 1 }))).toEqual({ a: 1 });
  });

  it('falls back to the factory when localStorage itself is unavailable', () => {
    vi.stubGlobal('localStorage', undefined);
    expect(loadStoredDefault('k', () => ({ a: 1 }))).toEqual({ a: 1 });
    expect(() => storeDefault('k', { a: 1 })).not.toThrow();
  });
});
