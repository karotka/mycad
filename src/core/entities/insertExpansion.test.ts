import { describe, expect, it } from 'vitest';
import { Document } from '../Document';
import { clearInsertExpansionCache, expandedInsertEntities, type BlockDefinition } from './types';

function definition(): BlockDefinition {
  return { name: 'sym', basePoint: { x: 0, y: 0 }, entities: [{ id: 'child', type: 'line', layer: '0', aci: 256, color: 0xffffff, selected: false, start: { x: 0, y: 0 }, end: { x: 1, y: 0 } }] };
}

describe('expandedInsertEntities caching', () => {
  it('reuses the expansion until the insert changes', () => {
    const doc = new Document();
    const insert = doc.createInsert(definition(), { x: 0, y: 0 });
    const first = expandedInsertEntities(insert);
    const second = expandedInsertEntities(insert);
    expect(second).toBe(first); // same array instance: no recomputation happened

    insert.position.x = 5;
    const third = expandedInsertEntities(insert);
    expect(third).not.toBe(first);
    expect((third[0] as { start: { x: number } }).start.x).toBe(5);
  });

  it('picks up a block redefinition even though the transform fields are unchanged', () => {
    const doc = new Document();
    const insert = doc.createInsert(definition(), { x: 0, y: 0 });
    const before = expandedInsertEntities(insert);

    // BlockController.rename swaps in a whole new definition object rather
    // than mutating the old one in place — the cache keys on that identity.
    insert.definition = { ...definition(), name: 'renamed' };
    const after = expandedInsertEntities(insert);
    expect(after).not.toBe(before);
  });

  it('clearInsertExpansionCache forces every insert to recompute', () => {
    const doc = new Document();
    const insert = doc.createInsert(definition(), { x: 0, y: 0 });
    const before = expandedInsertEntities(insert);
    clearInsertExpansionCache();
    const after = expandedInsertEntities(insert);
    expect(after).not.toBe(before);
    expect(after).toEqual(before);
  });
});
