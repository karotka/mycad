import path from 'path';

/**
 * Reduces whatever the renderer proposed to a bare file name.
 *
 * A quick save writes without a dialog, joining the proposed name to the
 * documents folder — so the renderer must be able to propose a *name*, never a
 * *path*. `../../../.zshrc` would otherwise escape the folder entirely.
 *
 * Only the last segment survives, and only if it names a file: `.`, `..` and an
 * empty segment all name a directory, and joining one on would either step out
 * of the folder or try to write over the folder itself.
 */
export function safeFileName(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  const name = path.basename(value.trim());
  if (!name || name === '.' || name === '..') return fallback;
  return name;
}
