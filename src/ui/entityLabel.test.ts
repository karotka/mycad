import { describe, expect, it } from 'vitest';
import { Document } from '../core/Document';
import { entityTypeLabel } from './entityLabel';

describe('entityTypeLabel', () => {
  const doc = new Document();

  it('calls a bezier what the drawing calls it — a Spline, the name both SPLINE commands draw under', () => {
    expect(entityTypeLabel(doc.createSpline({ x: 0, y: 0 }, [{ control1: { x: 1, y: 1 }, control2: { x: 2, y: 1 }, end: { x: 3, y: 0 } }]))).toBe('Spline');
  });

  it('tells an open polyline from a closed one, since only one of them is an outline', () => {
    expect(entityTypeLabel(doc.createPolyline([{ x: 0, y: 0 }, { x: 1, y: 0 }], false))).toBe('Polyline');
    expect(entityTypeLabel(doc.createPolyline([{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }], true))).toBe('Closed polyline');
  });

  it('names the plain shapes as themselves', () => {
    expect(entityTypeLabel(doc.createLine({ x: 0, y: 0 }, { x: 1, y: 1 }))).toBe('Line');
    expect(entityTypeLabel(doc.createCircle({ x: 0, y: 0 }, 5))).toBe('Circle');
    expect(entityTypeLabel(doc.createRectangle({ x: 0, y: 0 }, { x: 4, y: 3 }))).toBe('Rectangle');
  });
});
