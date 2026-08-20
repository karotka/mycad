import { beforeEach, describe, expect, it } from 'vitest';
import { Document } from '../core/Document';
import { clipboardSize, readClipboard, setClipboard } from './clipboard';

describe('object clipboard', () => {
  beforeEach(() => setClipboard([], [])); // reset the shared buffer between tests

  it('starts empty', () => {
    expect(clipboardSize()).toBe(0);
    expect(readClipboard()).toEqual({ entities: [], solids: [] });
  });

  it('holds clones and pastes fresh, deselected ids each read', () => {
    const doc = new Document();
    const line = doc.createLine({ x: 0, y: 0 }, { x: 10, y: 0 });
    const circle = doc.createCircle({ x: 5, y: 5 }, 2);
    line.selected = true;

    expect(setClipboard([line, circle], [])).toBe(2);
    expect(clipboardSize()).toBe(2);

    const first = readClipboard();
    expect(first.entities).toHaveLength(2);
    // New ids, nothing left selected, geometry preserved at original coordinates.
    expect(first.entities[0].id).not.toBe(line.id);
    expect(first.entities.every((entity) => entity.selected === false)).toBe(true);
    expect(first.entities[0].type).toBe('line');

    // A second paste is independent: different ids again.
    const second = readClipboard();
    expect(second.entities[0].id).not.toBe(first.entities[0].id);
  });

  it('freezes the copied objects: later edits to the buffer do not change pastes', () => {
    const doc = new Document();
    const line = doc.createLine({ x: 0, y: 0 }, { x: 10, y: 0 });
    setClipboard([line], []);
    // Mutating the original after the copy must not leak into the buffer.
    line.start.x = 999;
    const pasted = readClipboard().entities[0];
    expect(pasted.type === 'line' && pasted.start.x).toBe(0);
  });
});
