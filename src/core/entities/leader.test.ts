import { describe, expect, it } from 'vitest';
import { Document } from '../Document';
import { entityBounds, leaderGeometry } from './types';

describe('a leader', () => {
  const doc = new Document();

  it('runs its shelf on the way the line arrived, with the text beyond it', () => {
    // Arrow at the part, up and to the right to clear it.
    const leader = doc.createLeader([{ x: 0, y: 0 }, { x: 20, y: 15 }], '2 HOLES');
    const geometry = leaderGeometry(leader);

    // Arrow point, the corner, then the shelf running on to the right.
    expect(geometry.path).toHaveLength(3);
    expect(geometry.path[2].y).toBe(15);
    expect(geometry.path[2].x).toBeGreaterThan(20);
    // The note reads away from the arrow, so it starts at the shelf's far end.
    expect(geometry.textAnchor).toBe('start');
    expect(geometry.textPoint.x).toBeGreaterThan(geometry.path[2].x);
  });

  it('puts the note on the other side when the line comes in from the right', () => {
    const leader = doc.createLeader([{ x: 50, y: 0 }, { x: 20, y: 15 }], 'BREAK EDGES');
    const geometry = leaderGeometry(leader);
    expect(geometry.path[2].x).toBeLessThan(20);
    expect(geometry.textAnchor).toBe('end');
    expect(geometry.textPoint.x).toBeLessThan(geometry.path[2].x);
  });

  it('points its arrowhead along the first stroke, at the thing itself', () => {
    const leader = doc.createLeader([{ x: 0, y: 0 }, { x: 30, y: 0 }], 'HERE');
    const geometry = leaderGeometry(leader);
    expect(geometry.arrow).toHaveLength(3);
    // The tip is the point being indicated, and the head lies along the line.
    expect(geometry.arrow[0]).toMatchObject({ x: 0, y: 0 });
    for (const corner of geometry.arrow.slice(1)) {
      expect(corner.x).toBeCloseTo(leader.arrowSize * leader.scale, 9);
    }
  });

  it('draws no head at all when asked for none', () => {
    const leader = doc.createLeader([{ x: 0, y: 0 }, { x: 30, y: 0 }], 'HERE');
    leader.arrowType = 'none';
    expect(leaderGeometry(leader).arrow).toHaveLength(0);
  });

  it('bends round as many corners as it is given', () => {
    const leader = doc.createLeader([{ x: 0, y: 0 }, { x: 10, y: 10 }, { x: 10, y: 30 }, { x: 25, y: 30 }], 'ROUND THE BACK');
    // Every corner, plus the shelf.
    expect(leaderGeometry(leader).path).toHaveLength(5);
  });

  it('counts the room the note takes into its own bounds', () => {
    const leader = doc.createLeader([{ x: 0, y: 0 }, { x: 20, y: 0 }], 'A VERY LONG NOTE INDEED');
    const bounds = entityBounds(leader);
    // The box reaches past the shelf, or the note hangs outside everything
    // that reads the bounds — zoom extents, window selection, the lot.
    expect(bounds.max.x).toBeGreaterThan(leaderGeometry(leader).textPoint.x + 10);
    expect(bounds.min.x).toBeCloseTo(0, 6);
  });
});
