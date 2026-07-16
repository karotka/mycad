import { describe, expect, it } from 'vitest';
import { Document } from '../core/Document';
import { applyWindowSelection, pickEntityAt } from './PickingService';
import { snapPoint2 } from '../math/geometry';

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

describe('picking a line along its length', () => {
  // Picking used to be fed the grid-snapped cursor instead of the real one. On a
  // diagonal line the snapped point sits up to ~0.35mm away, which exceeds the
  // tolerance at working zoom levels — so a line could only be picked where it
  // happened to pass through a grid dot, i.e. at its snapped endpoints.
  const diagonal = () => {
    const doc = new Document();
    const line = doc.createLine({ x: 0, y: 0 }, { x: 10, y: 7 });
    doc.entities.push(line);
    return { doc, line };
  };

  it('hits the line anywhere along it, not only at the endpoints', () => {
    const { doc, line } = diagonal();
    const tolerance = 0.2;
    for (const t of [0.1, 0.25, 0.5, 0.75, 0.9]) {
      const cursor = { x: 10 * t, y: 7 * t };
      expect(pickEntityAt(doc, cursor, tolerance), `missed at t=${t}`).toMatchObject({ id: line.id });
    }
  });

  it('still misses when the cursor is genuinely off the line', () => {
    const { doc } = diagonal();
    expect(pickEntityAt(doc, { x: 5, y: 0 }, 0.2)).toBeNull();
  });

  it('would have missed most of the span had the cursor been snapped to the grid', () => {
    const { doc } = diagonal();
    const tolerance = 0.1;
    let snappedMisses = 0;
    let samples = 0;
    for (let t = 0.05; t < 0.95; t += 0.01) {
      const cursor = { x: 10 * t, y: 7 * t };
      samples++;
      expect(pickEntityAt(doc, cursor, tolerance), `real cursor missed at t=${t}`).not.toBeNull();
      if (!pickEntityAt(doc, snapPoint2(cursor, 0.5), tolerance)) snappedMisses++;
    }
    // The real cursor hits everywhere; the snapped one only lands on the line
    // where it happens to cross a grid dot — roughly half the span is dead.
    expect(snappedMisses / samples).toBeGreaterThan(0.4);
  });
});

describe('picking strokes, not just vertices', () => {
  // A polyline used to be hit-tested against its vertices only, so it could be
  // picked at its corners and nowhere else — "only at the endpoints".
  it('picks a polyline along its segments, far from any vertex', () => {
    const doc = new Document();
    const polyline = doc.createPolyline([{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 10 }], false);
    doc.entities.push(polyline);

    // Midpoints of both segments, as far from a vertex as it gets.
    expect(pickEntityAt(doc, { x: 10, y: 0 }, 0.2)).toMatchObject({ id: polyline.id });
    expect(pickEntityAt(doc, { x: 20, y: 5 }, 0.2)).toMatchObject({ id: polyline.id });
    // And still nothing where the polyline is not.
    expect(pickEntityAt(doc, { x: 10, y: 5 }, 0.2)).toBeNull();
  });

  it('picks the closing segment of a closed polyline', () => {
    const doc = new Document();
    const triangle = doc.createPolyline([{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 10, y: 10 }], true);
    doc.entities.push(triangle);
    // Midpoint of the segment from the last vertex back to the first.
    expect(pickEntityAt(doc, { x: 5, y: 5 }, 0.2)).toMatchObject({ id: triangle.id });
  });

  it('picks an octagon on its edges', () => {
    const doc = new Document();
    const octagon = doc.createOctagon({ x: 0, y: 0 }, 10);
    doc.entities.push(octagon);
    const [a, b] = octagon.type === 'octagon' ? octagon.vertices : [];
    const edgeMidpoint = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    expect(pickEntityAt(doc, edgeMidpoint, 0.2)).toMatchObject({ id: octagon.id });
  });

  it('picks an arc away from its endpoints', () => {
    const doc = new Document();
    const arc = doc.createArc({ x: 0, y: 0 }, 10, 0, Math.PI / 2);
    doc.entities.push(arc);
    const mid = { x: Math.cos(Math.PI / 4) * 10, y: Math.sin(Math.PI / 4) * 10 };
    expect(pickEntityAt(doc, mid, 0.2)).toMatchObject({ id: arc.id });
  });

  // Every stroked entity must be pickable along its length, not just at its ends.
  it('picks every stroked entity at its midpoint', () => {
    const doc = new Document();
    const cases: Array<[string, { x: number; y: number }]> = [
      ['line', { x: 5, y: 0 }],
      ['polyline', { x: 5, y: 20 }],
    ];
    doc.entities.push(doc.createLine({ x: 0, y: 0 }, { x: 10, y: 0 }));
    doc.entities.push(doc.createPolyline([{ x: 0, y: 20 }, { x: 10, y: 20 }], false));
    for (const [label, point] of cases) {
      expect(pickEntityAt(doc, point, 0.2), `${label} not picked mid-span`).not.toBeNull();
    }
  });
});
