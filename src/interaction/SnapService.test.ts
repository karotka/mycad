import { describe, expect, it } from 'vitest';
import { Document } from '../core/Document';
import { nearestCandidate2d, objectSnapCandidates, type ObjectSnapMode } from './SnapService';
import type { Document as CadDocument } from '../core/Document';

/** Candidates carry the snap that found them; these tests care about the points. */
const points = (doc: CadDocument, mode: ObjectSnapMode, excluded?: string | null, reference?: { x: number; y: number; z: number } | null) =>
  objectSnapCandidates(doc, mode, excluded, reference).map((candidate) => candidate.world);

describe('SnapService', () => {
  it('collects End, Middle and Center candidates while excluding the dragged object', () => {
    const doc = new Document();
    const line = doc.createLine({ x: 0, y: 0 }, { x: 10, y: 0 });
    const circle = doc.createCircle({ x: 20, y: 5 }, 3);
    doc.entities.push(line, circle);

    expect(points(doc, 'end')).toEqual(expect.arrayContaining([
      { x: 0, y: 0, z: 0 }, { x: 10, y: 0, z: 0 },
    ]));
    expect(points(doc, 'middle')).toContainEqual({ x: 5, y: 0, z: 0 });
    expect(points(doc, 'center')).toContainEqual({ x: 20, y: 5, z: 0 });
    expect(points(doc, 'end', line.id)).not.toContainEqual({ x: 0, y: 0, z: 0 });
  });

  it('does not expose hidden-layer points and picks the nearest candidate in the active plane', () => {
    const doc = new Document();
    const visible = doc.createLine({ x: 2, y: 3 }, { x: 8, y: 3 });
    const hidden = doc.createLine({ x: 2.1, y: 3 }, { x: 9, y: 3 });
    hidden.layer = 'Hidden';
    doc.hiddenLayers.add('Hidden');
    doc.entities.push(visible, hidden);
    const candidates = objectSnapCandidates(doc, 'end');

    expect(candidates.map((candidate) => candidate.world)).not.toContainEqual({ x: 2.1, y: 3, z: 0 });
    expect(nearestCandidate2d(candidates, { x: 2.2, y: 3 }, doc.activeWorkPlane, 1)?.world)
      .toEqual({ x: 2, y: 3, z: 0 });
  });

  it('calculates intersections and perpendicular feet', () => {
    const doc = new Document();
    doc.entities.push(
      doc.createLine({ x: 0, y: 0 }, { x: 10, y: 10 }),
      doc.createLine({ x: 0, y: 10 }, { x: 10, y: 0 }),
      doc.createLine({ x: 20, y: 0 }, { x: 30, y: 0 }),
    );

    expect(points(doc, 'intersection')).toContainEqual({ x: 5, y: 5, z: 0 });
    expect(points(doc, 'perpendicular', null, { x: 25, y: 8, z: 0 })).toContainEqual({ x: 25, y: 0, z: 0 });
  });
});

describe('snap candidates carry the snap that found them', () => {
  // The marker draws a different symbol per mode, so the mode has to survive
  // the trip from the candidate to the snap target.
  it('tags every candidate with its mode', () => {
    const doc = new Document();
    doc.entities.push(doc.createLine({ x: 0, y: 0 }, { x: 10, y: 0 }), doc.createCircle({ x: 20, y: 5 }, 3));
    for (const mode of ['end', 'middle', 'center'] as const) {
      const candidates = objectSnapCandidates(doc, mode);
      expect(candidates.length, mode).toBeGreaterThan(0);
      expect(candidates.every((candidate) => candidate.mode === mode), mode).toBe(true);
    }
  });

  it('reports the mode on the resolved snap target', () => {
    const doc = new Document();
    doc.entities.push(
      doc.createLine({ x: 0, y: 0 }, { x: 10, y: 10 }),
      doc.createLine({ x: 0, y: 10 }, { x: 10, y: 0 }),
    );
    const hit = nearestCandidate2d(objectSnapCandidates(doc, 'intersection'), { x: 5, y: 5 }, doc.activeWorkPlane, 1);
    expect(hit?.mode).toBe('intersection');
  });

  it('reports perpendicular so the marker can draw the right angle', () => {
    const doc = new Document();
    doc.entities.push(doc.createLine({ x: 20, y: 0 }, { x: 30, y: 0 }));
    const candidates = objectSnapCandidates(doc, 'perpendicular', null, { x: 25, y: 8, z: 0 });
    const hit = nearestCandidate2d(candidates, { x: 25, y: 0 }, doc.activeWorkPlane, 1);
    expect(hit?.mode).toBe('perpendicular');
    expect(hit?.point).toMatchObject({ x: 25, y: 0 });
  });
});
