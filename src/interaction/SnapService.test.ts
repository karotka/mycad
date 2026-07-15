import { describe, expect, it } from 'vitest';
import { Document } from '../core/Document';
import { nearestCandidate2d, objectSnapCandidates } from './SnapService';

describe('SnapService', () => {
  it('collects End, Middle and Center candidates while excluding the dragged object', () => {
    const doc = new Document();
    const line = doc.createLine({ x: 0, y: 0 }, { x: 10, y: 0 });
    const circle = doc.createCircle({ x: 20, y: 5 }, 3);
    doc.entities.push(line, circle);

    expect(objectSnapCandidates(doc, 'end')).toEqual(expect.arrayContaining([
      { x: 0, y: 0, z: 0 }, { x: 10, y: 0, z: 0 },
    ]));
    expect(objectSnapCandidates(doc, 'middle')).toContainEqual({ x: 5, y: 0, z: 0 });
    expect(objectSnapCandidates(doc, 'center')).toContainEqual({ x: 20, y: 5, z: 0 });
    expect(objectSnapCandidates(doc, 'end', line.id)).not.toContainEqual({ x: 0, y: 0, z: 0 });
  });

  it('does not expose hidden-layer points and picks the nearest candidate in the active plane', () => {
    const doc = new Document();
    const visible = doc.createLine({ x: 2, y: 3 }, { x: 8, y: 3 });
    const hidden = doc.createLine({ x: 2.1, y: 3 }, { x: 9, y: 3 });
    hidden.layer = 'Hidden';
    doc.hiddenLayers.add('Hidden');
    doc.entities.push(visible, hidden);
    const candidates = objectSnapCandidates(doc, 'end');

    expect(candidates).not.toContainEqual({ x: 2.1, y: 3, z: 0 });
    expect(nearestCandidate2d(candidates, { x: 2.2, y: 3 }, doc.activeWorkPlane, 1)?.world)
      .toEqual({ x: 2, y: 3, z: 0 });
  });
});
