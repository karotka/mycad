import { describe, expect, it } from 'vitest';
import { Document } from '../core/Document';
import { applyWindowSelection } from './PickingService';

describe('window selection', () => {
  it('distinguishes contained and crossing objects and ignores hidden layers', () => {
    const doc = new Document();
    const inside = doc.createLine({ x: 2, y: 2 }, { x: 4, y: 4 });
    const crossing = doc.createLine({ x: 8, y: 8 }, { x: 14, y: 14 });
    const hidden = doc.createLine({ x: 3, y: 3 }, { x: 5, y: 5 });
    hidden.layer = 'Hidden';
    doc.layers.push('Hidden');
    doc.hiddenLayers.add('Hidden');
    doc.entities.push(inside, crossing, hidden);
    const box = { minX: 0, minY: 0, maxX: 10, maxY: 10 };

    applyWindowSelection(doc, box, false, false);
    expect([...doc.selectedEntityIds]).toEqual([inside.id]);

    applyWindowSelection(doc, box, true, false);
    expect([...doc.selectedEntityIds]).toEqual([inside.id, crossing.id]);
  });
});
