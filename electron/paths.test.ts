import { describe, expect, it } from 'vitest';
import path from 'path';
import { safeFileName } from './paths';

const DOCUMENTS = '/Users/someone/Documents';
const inDocuments = (name: string) => path.join(DOCUMENTS, safeFileName(name, 'model.mycad'));

describe('safeFileName', () => {
  it('keeps an ordinary name as it is', () => {
    expect(safeFileName('model.mycad', 'fallback')).toBe('model.mycad');
    expect(safeFileName('  drawing 2.mycad  ', 'fallback')).toBe('drawing 2.mycad');
  });

  // The renderer proposes a name; a quick save joins it to the documents folder
  // and writes with no dialog, so a path must never survive.
  it.each([
    '../../../.zshrc',
    '../../.ssh/authorized_keys',
    '/etc/passwd',
    'a/b/../../../../evil.sh',
    './../../evil',
  ])('strips the path out of %s', (proposed) => {
    const resolved = inDocuments(proposed);
    expect(path.dirname(resolved)).toBe(DOCUMENTS);
    expect(resolved.startsWith(`${DOCUMENTS}/`)).toBe(true);
  });

  it('never lets the name step out of the folder, whatever is thrown at it', () => {
    const attempts = [
      '../../../.zshrc', '..', '.', '/', '', '   ', '/////', '../', 'x/../..',
      '/absolute/path/file.txt', './.', '..//..//x',
    ];
    for (const attempt of attempts) {
      const resolved = path.resolve(inDocuments(attempt));
      expect(path.dirname(resolved), `escaped with ${JSON.stringify(attempt)}`).toBe(DOCUMENTS);
    }
  });

  // These name a directory, not a file: joining one on would write over the
  // folder rather than into it.
  it.each(['..', '.', '/', '', '   ', './'])('falls back for %s, which names no file', (proposed) => {
    expect(safeFileName(proposed, 'model.mycad')).toBe('model.mycad');
  });

  it('falls back for anything that is not a string', () => {
    for (const value of [undefined, null, 42, {}, [], true]) {
      expect(safeFileName(value, 'model.mycad')).toBe('model.mycad');
    }
  });

  it('keeps a dotfile that is a real name', () => {
    expect(safeFileName('.hidden.mycad', 'fallback')).toBe('.hidden.mycad');
  });
});
