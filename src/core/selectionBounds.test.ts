import { describe, expect, it } from 'vitest';
import { Document } from './Document';
import { centerOfWorldBounds, worldBoundsOf } from './selectionBounds';

/**
 * The point a view turns about. It used to be wherever the view had last left
 * it — a default box near the origin for a drawing never framed — so orbiting
 * around something just selected swung it off the screen.
 */
describe('where a selection sits in the drawing', () => {
  it('has nothing to say about an empty selection', () => {
    expect(worldBoundsOf([], [], [])).toBeNull();
  });

  it('takes the middle of what is selected', () => {
    const doc = new Document();
    const line = doc.createLine({ x: 0, y: 0 }, { x: 10, y: 4 });
    const bounds = worldBoundsOf([line], [], [])!;
    expect(centerOfWorldBounds(bounds)).toMatchObject({ x: 5, y: 2, z: 0 });
  });

  it('carries an entity out of its own work plane into world', () => {
    const doc = new Document();
    const line = doc.createLine({ x: 0, y: 0 }, { x: 10, y: 0 });
    // Drawn on a plane standing up out of world, shifted along it.
    line.workPlane = {
      origin: { x: 100, y: 0, z: 50 },
      xAxis: { x: 1, y: 0, z: 0 }, yAxis: { x: 0, y: 0, z: 1 }, zAxis: { x: 0, y: -1, z: 0 },
    };
    const centre = centerOfWorldBounds(worldBoundsOf([line], [], [])!);
    expect(centre.x).toBeCloseTo(105, 9);
    expect(centre.y).toBeCloseTo(0, 9);
    expect(centre.z).toBeCloseTo(50, 9);
  });

  it('describes a box turned in its own plane by all four of its corners', () => {
    const doc = new Document();
    const rectangle = doc.createRectangle({ x: 0, y: 0 }, { x: 10, y: 2 });
    // Turned 90° about world Z: its local x now runs along world y.
    rectangle.workPlane = {
      origin: { x: 0, y: 0, z: 0 },
      xAxis: { x: 0, y: 1, z: 0 }, yAxis: { x: -1, y: 0, z: 0 }, zAxis: { x: 0, y: 0, z: 1 },
    };
    const bounds = worldBoundsOf([rectangle], [], [])!;
    // Two opposite corners alone would have described a box 10 by 2 the wrong
    // way round; all four give the turned extent.
    expect(bounds.min.x).toBeCloseTo(-2, 9);
    expect(bounds.max.x).toBeCloseTo(0, 9);
    expect(bounds.min.y).toBeCloseTo(0, 9);
    expect(bounds.max.y).toBeCloseTo(10, 9);
  });

  it('reaches a solid where it actually stands, mesh and all', () => {
    const doc = new Document();
    const solid = doc.createSolid(
      {
        positions: new Float32Array([10, 20, 30, 12, 24, 36, 11, 22, 33]),
        indices: new Uint32Array([0, 1, 2]),
      },
      'Body', 0, [],
    );
    const centre = centerOfWorldBounds(worldBoundsOf([], [solid], [])!);
    expect(centre).toMatchObject({ x: 11, y: 22, z: 33 });
  });
});
