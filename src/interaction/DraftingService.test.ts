import { describe, expect, it } from 'vitest';
import { defaultDraftingSettings } from '../core/settings';
import { constrainDraftingPoint, resolveDraftingPoint } from './DraftingService';

describe('DraftingService', () => {
  it('constrains Ortho to the dominant axis', () => {
    const settings = defaultDraftingSettings();
    settings.orthoEnabled = true;
    expect(constrainDraftingPoint({ x: 8, y: 2 }, { x: 0, y: 0 }, settings).point.y).toBeCloseTo(0);
    expect(constrainDraftingPoint({ x: 2, y: -8 }, { x: 0, y: 0 }, settings).angle).toBe(270);
  });

  it('tracks configured polar angles only inside the angular tolerance', () => {
    const settings = defaultDraftingSettings();
    settings.polarEnabled = true;
    const near45 = constrainDraftingPoint({ x: 10, y: 9.5 }, { x: 0, y: 0 }, settings);
    const free = constrainDraftingPoint({ x: 10, y: 3.6 }, { x: 0, y: 0 }, settings);
    expect(near45.tracked).toBe(true);
    expect(near45.angle).toBe(45);
    expect(free.tracked).toBe(false);
  });
});

describe('resolveDraftingPoint', () => {
  const ortho = () => { const s = defaultDraftingSettings(); s.orthoEnabled = true; return s; };
  const free = () => defaultDraftingSettings();
  const base = { x: 0, y: 0 };
  const anchor = { x: 5, y: 40 };

  const isOrthogonal = (from: { x: number; y: number }, to: { x: number; y: number }) =>
    Math.abs(to.x - from.x) < 1e-9 || Math.abs(to.y - from.y) < 1e-9;

  it('gives an object snap the exact point, over everything else', () => {
    const resolved = resolveDraftingPoint({
      cursor: { x: 9, y: 9 }, base, anchor, snap: { x: 3.3, y: 7.7 }, settings: ortho(), captureDistance: 1,
    });
    expect(resolved.point).toMatchObject({ x: 3.3, y: 7.7 });
    expect(resolved.guide).toBeNull();
  });

  describe('with Ortho on, the direction is never broken', () => {
    // The invariant: whatever tracking does, the line from the base must stay
    // on an axis. A point on the anchor's path that is not 0/90/180/270 from
    // the base is not Ortho any more, so Ortho refuses it.
    it.each([
      ['away from any path', { x: 20, y: 3 }],
      ['near the anchor horizontal', { x: 20, y: 40.4 }],
      ['near the anchor vertical', { x: 5.4, y: 90 }],
      ['right at the anchor', { x: 5, y: 40 }],
      ['beyond the anchor', { x: 60, y: 39.5 }],
    ])('holds an axis %s', (_label, cursor) => {
      const resolved = resolveDraftingPoint({ cursor, base, anchor, snap: null, settings: ortho(), captureDistance: 1 });
      expect(isOrthogonal(base, resolved.point), `${JSON.stringify(resolved.point)} is off-axis`).toBe(true);
    });

    it('runs along the ray while the crossing is out of reach', () => {
      const far = resolveDraftingPoint({ cursor: { x: 20, y: 3 }, base, anchor, snap: null, settings: ortho(), captureDistance: 1 });
      const further = resolveDraftingPoint({ cursor: { x: 35, y: 3 }, base, anchor, snap: null, settings: ortho(), captureDistance: 1 });
      // The cursor still drags the point — it is not pinned to the crossing.
      expect(far.point).toMatchObject({ x: 20, y: 0 });
      expect(further.point).toMatchObject({ x: 35, y: 0 });
    });

    it('extends onto the crossing when the ray meets the path', () => {
      // Cursor mostly vertical, so Ortho gives the vertical ray x=0; the
      // anchor's horizontal y=40 crosses it at (0, 40).
      const resolved = resolveDraftingPoint({
        cursor: { x: 3, y: 40.4 }, base, anchor, snap: null, settings: ortho(), captureDistance: 1,
      });
      expect(resolved.point.x).toBeCloseTo(0);
      expect(resolved.point.y).toBeCloseTo(40);
      expect(resolved.guide?.start).toMatchObject(anchor);
    });
  });

  describe('with no direction constraint, the path is the constraint', () => {
    it('captures the point onto the path and slides it along', () => {
      for (const cursor of [{ x: 20, y: 40.3 }, { x: 35, y: 39.8 }]) {
        const resolved = resolveDraftingPoint({ cursor, base, anchor, snap: null, settings: free(), captureDistance: 1 });
        expect(resolved.point.y).toBeCloseTo(anchor.y);
        expect(resolved.point.x).toBeCloseTo(cursor.x);
      }
    });

    it('will not let the point off the path once captured', () => {
      const resolved = resolveDraftingPoint({ cursor: { x: 20, y: 40.6 }, base, anchor, snap: null, settings: free(), captureDistance: 1 });
      expect(resolved.point.y).toBeCloseTo(anchor.y);
      expect(resolved.point.y).not.toBeCloseTo(40.6);
    });

    it('releases the point when the cursor leaves the path', () => {
      const resolved = resolveDraftingPoint({ cursor: { x: 20, y: 30 }, base, anchor, snap: null, settings: free(), captureDistance: 1 });
      expect(resolved.point).toMatchObject({ x: 20, y: 30 });
      expect(resolved.guide).toBeNull();
    });
  });
});
