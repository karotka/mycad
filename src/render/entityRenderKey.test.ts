import { describe, expect, it } from 'vitest';
import { Document } from '../core/Document';
import { entityRenderKey } from './entityRenderKey';

describe('entityRenderKey', () => {
  it('is stable until geometry or visual state changes', () => {
    const doc = new Document();
    const line = doc.createLine({ x: 0, y: 0 }, { x: 10, y: 0 });
    const initial = entityRenderKey(line);
    expect(entityRenderKey(line)).toBe(initial);

    line.end.x = 12;
    expect(entityRenderKey(line)).not.toBe(initial);
    const changedGeometry = entityRenderKey(line);

    line.selected = true;
    expect(entityRenderKey(line)).not.toBe(changedGeometry);
  });
});
