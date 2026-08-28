/**
 * The Settings panel (Drafting, Dimensions, Hatch, G-code) edits values that
 * belong to the open project file — but a brand new document, or a saved file
 * that never touched a given section, has nothing of its own to fall back on
 * beyond the hardcoded factory defaults. That made a change here feel like it
 * never stuck: pick a pen delay, start a new drawing, and it is gone.
 *
 * This keeps one persisted copy of each section outside any project, in
 * localStorage next to the toolbar's other "last used" memory. A project
 * file's own saved values always win — this only supplies what a field would
 * otherwise have used anyway.
 */
export const SETTINGS_DEFAULT_KEYS = {
  gcode: 'mycad.defaults.gcode',
  drafting: 'mycad.defaults.drafting',
  dimensionStyle: 'mycad.defaults.dimensionStyle',
  hatch: 'mycad.defaults.hatch',
} as const;

export function loadStoredDefault<T extends object>(key: string, factory: () => T): T {
  const fallback = factory();
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    const stored = JSON.parse(raw) as Partial<T>;
    if (!stored || typeof stored !== 'object') return fallback;
    return { ...fallback, ...stored };
  } catch {
    return fallback;
  }
}

export function storeDefault<T>(key: string, value: T): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* best effort — a full or disabled store just means it is not remembered */
  }
}
