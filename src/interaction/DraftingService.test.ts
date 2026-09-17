import { describe, expect, it } from 'vitest';
import type { DraftingSettings } from '../core/settings';
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
  // These cases name the setting outright rather than lean on the default.
  const tracked = (settings: ReturnType<typeof defaultDraftingSettings>) => { settings.objectSnapTrackingEnabled = true; return settings; };
  const ortho = () => tracked((() => { const s = defaultDraftingSettings(); s.orthoEnabled = true; return s; })());
  const free = () => tracked(defaultDraftingSettings());
  const base = { x: 0, y: 0 };
  const anchor = { x: 5, y: 40 };

  const isOrthogonal = (from: { x: number; y: number }, to: { x: number; y: number }) =>
    Math.abs(to.x - from.x) < 1e-9 || Math.abs(to.y - from.y) < 1e-9;

  it('gives an object snap the exact point, over everything else', () => {
    const resolved = resolveDraftingPoint({
      cursor: { x: 9, y: 9 }, base, anchors: [anchor], snap: { x: 3.3, y: 7.7 }, settings: ortho(), captureDistance: 1,
    });
    expect(resolved.point).toMatchObject({ x: 3.3, y: 7.7 });
    expect(resolved.guides[0] ?? null).toBeNull();
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
      const resolved = resolveDraftingPoint({ cursor, base, anchors: [anchor], snap: null, settings: ortho(), captureDistance: 1 });
      expect(isOrthogonal(base, resolved.point), `${JSON.stringify(resolved.point)} is off-axis`).toBe(true);
    });

    it('runs along the ray while the crossing is out of reach', () => {
      const far = resolveDraftingPoint({ cursor: { x: 20, y: 3 }, base, anchors: [anchor], snap: null, settings: ortho(), captureDistance: 1 });
      const further = resolveDraftingPoint({ cursor: { x: 35, y: 3 }, base, anchors: [anchor], snap: null, settings: ortho(), captureDistance: 1 });
      // The cursor still drags the point — it is not pinned to the crossing.
      expect(far.point).toMatchObject({ x: 20, y: 0 });
      expect(further.point).toMatchObject({ x: 35, y: 0 });
    });

    it('extends onto the crossing when the ray meets the path', () => {
      // Cursor mostly vertical, so Ortho gives the vertical ray x=0; the
      // anchor's horizontal y=40 crosses it at (0, 40).
      const resolved = resolveDraftingPoint({
        cursor: { x: 3, y: 40.4 }, base, anchors: [anchor], snap: null, settings: ortho(), captureDistance: 1,
      });
      expect(resolved.point.x).toBeCloseTo(0);
      expect(resolved.point.y).toBeCloseTo(40);
      expect(resolved.guides[0]?.start).toMatchObject(anchor);
    });
  });

  describe('with no direction constraint, the path is the constraint', () => {
    it('captures the point onto the path and slides it along', () => {
      for (const cursor of [{ x: 20, y: 40.3 }, { x: 35, y: 39.8 }]) {
        const resolved = resolveDraftingPoint({ cursor, base, anchors: [anchor], snap: null, settings: free(), captureDistance: 1 });
        expect(resolved.point.y).toBeCloseTo(anchor.y);
        expect(resolved.point.x).toBeCloseTo(cursor.x);
      }
    });

    it('will not let the point off the path once captured', () => {
      const resolved = resolveDraftingPoint({ cursor: { x: 20, y: 40.6 }, base, anchors: [anchor], snap: null, settings: free(), captureDistance: 1 });
      expect(resolved.point.y).toBeCloseTo(anchor.y);
      expect(resolved.point.y).not.toBeCloseTo(40.6);
    });

    it('releases the point when the cursor leaves the path', () => {
      const resolved = resolveDraftingPoint({ cursor: { x: 20, y: 30 }, base, anchors: [anchor], snap: null, settings: free(), captureDistance: 1 });
      expect(resolved.point).toMatchObject({ x: 20, y: 30 });
      expect(resolved.guides[0] ?? null).toBeNull();
    });
  });
});

describe('object snap tracking can be switched off (F11)', () => {
  const base = { x: 0, y: 0 };
  const anchor = { x: 5, y: 40 };
  const withTracking = (on: boolean) => {
    const settings = defaultDraftingSettings();
    settings.objectSnapTrackingEnabled = on;
    return settings;
  };

  it('lays an acquired point\'s path out of the box, as AutoCAD ships it', () => {
    // Off by default, acquiring a point did nothing at all — which is how the
    // whole feature came to look missing rather than merely switched off.
    expect(defaultDraftingSettings().objectSnapTrackingEnabled).toBe(true);
    const resolved = resolveDraftingPoint({
      cursor: { x: 20, y: 40.3 }, base, anchors: [anchor], snap: null, settings: defaultDraftingSettings(), captureDistance: 1,
    });
    expect(resolved.point.y).toBeCloseTo(anchor.y);
  });

  it('lays an acquired point\'s path when tracking is turned on', () => {
    const resolved = resolveDraftingPoint({
      cursor: { x: 20, y: 40.3 }, base, anchors: [anchor], snap: null, settings: withTracking(true), captureDistance: 1,
    });
    expect(resolved.point.y).toBeCloseTo(anchor.y);
    expect(resolved.guides[0] ?? null).not.toBeNull();
  });

  it('leaves the cursor alone once it is off, even right on the path', () => {
    const resolved = resolveDraftingPoint({
      cursor: { x: 20, y: 40 }, base, anchors: [anchor], snap: null, settings: withTracking(false), captureDistance: 1,
    });
    expect(resolved.point).toMatchObject({ x: 20, y: 40 });
    expect(resolved.guides[0] ?? null).toBeNull();
  });

  // With Ortho on the path is what the ray extends to, so switching tracking off
  // has to stop that crossing too, not just the free case.
  it('stops the ortho ray catching the crossing as well', () => {
    const settings = withTracking(false);
    settings.orthoEnabled = true;
    const resolved = resolveDraftingPoint({
      cursor: { x: 3, y: 40.4 }, base, anchors: [anchor], snap: null, settings, captureDistance: 1,
    });
    // Ortho still holds the axis; it just runs on past the anchor's path.
    expect(resolved.point.x).toBeCloseTo(0);
    expect(resolved.point.y).toBeCloseTo(40.4);
  });

  it('keeps Ortho itself working with tracking off', () => {
    const settings = withTracking(false);
    settings.orthoEnabled = true;
    const resolved = resolveDraftingPoint({
      cursor: { x: 20, y: 3 }, base, anchors: [anchor], snap: null, settings, captureDistance: 1,
    });
    expect(resolved.point).toMatchObject({ x: 20, y: 0 });
  });
});

describe('two acquired points, caught where their paths cross', () => {
  const tracking = (): DraftingSettings => ({
    orthoEnabled: false, polarEnabled: false, polarAngles: [30, 45, 90],
    objectSnapEnabled: true, objectSnapTrackingEnabled: true, objectSnapModes: ['middle'],
    linetypeScale: 1,
  });

  /** A 100 x 60 rectangle's bottom and left edge midpoints: the two points one
   *  hovers to reach a centre that has nothing drawn at it. */
  const bottomMid = { x: 50, y: 0 };
  const leftMid = { x: 0, y: 30 };

  it('lands on the crossing — the rectangle\'s own centre — when the cursor comes near it', () => {
    const resolved = resolveDraftingPoint({
      cursor: { x: 51, y: 31 }, base: null, anchors: [leftMid, bottomMid], snap: null,
      settings: tracking(), captureDistance: 5,
    });

    expect(resolved.point).toEqual({ x: 50, y: 30 });
    // And it says so with a path from each acquired point.
    expect(resolved.guides).toHaveLength(2);
    expect(resolved.guides.map((guide) => guide.start)).toEqual(expect.arrayContaining([leftMid, bottomMid]));
    for (const guide of resolved.guides) expect(guide.end).toEqual({ x: 50, y: 30 });
  });

  it('leaves the cursor alone while it is nowhere near a crossing', () => {
    const resolved = resolveDraftingPoint({
      cursor: { x: 80, y: 12 }, base: null, anchors: [leftMid, bottomMid], snap: null,
      settings: tracking(), captureDistance: 5,
    });

    expect(resolved.point).toEqual({ x: 80, y: 12 });
  });

  it('needs two: one acquired point still only offers its own path', () => {
    const resolved = resolveDraftingPoint({
      cursor: { x: 51, y: 31 }, base: null, anchors: [bottomMid], snap: null,
      settings: tracking(), captureDistance: 5,
    });

    expect(resolved.point).not.toEqual({ x: 50, y: 30 });
  });

  it('holds the crossing even with Ortho on, which would otherwise overrule tracking', () => {
    // The crossing IS the point being aimed at; an axis from the base has
    // nothing to say about a point that no base was measured from.
    const resolved = resolveDraftingPoint({
      cursor: { x: 51, y: 31 }, base: { x: 0, y: 0 }, anchors: [leftMid, bottomMid], snap: null,
      settings: { ...tracking(), orthoEnabled: true }, captureDistance: 5,
    });

    expect(resolved.point).toEqual({ x: 50, y: 30 });
  });

  it('is silent while object snap tracking is off (F11)', () => {
    const resolved = resolveDraftingPoint({
      cursor: { x: 51, y: 31 }, base: null, anchors: [leftMid, bottomMid], snap: null,
      settings: { ...tracking(), objectSnapTrackingEnabled: false }, captureDistance: 5,
    });

    expect(resolved.point).toEqual({ x: 51, y: 31 });
    expect(resolved.guides).toEqual([]);
  });

  it('an exact object snap still wins outright', () => {
    const resolved = resolveDraftingPoint({
      cursor: { x: 51, y: 31 }, base: null, anchors: [leftMid, bottomMid], snap: { x: 7, y: 7 },
      settings: tracking(), captureDistance: 5,
    });

    expect(resolved.point).toEqual({ x: 7, y: 7 });
  });

  it('crosses on a polar angle too, once polar tracking is on', () => {
    // A path at 45° from the origin meets the vertical through (50, 0) at
    // (50, 50) — a point neither anchor could have named alone.
    const resolved = resolveDraftingPoint({
      cursor: { x: 49, y: 49 }, base: null, anchors: [{ x: 0, y: 0 }, bottomMid], snap: null,
      settings: { ...tracking(), polarEnabled: true }, captureDistance: 5,
    });

    expect(resolved.point.x).toBeCloseTo(50, 9);
    expect(resolved.point.y).toBeCloseTo(50, 9);
  });
});

/**
 * A point the cursor was caught at by an acquired point's path has nothing
 * drawn at it — the dotted path runs on into open space. So the resolution has
 * to say it happened, or there is no mark to put there and no way to tell a
 * click will land on anything in particular.
 */
describe('saying when an acquired path is what caught the point', () => {
  const settings = () => defaultDraftingSettings();
  const base = { x: 0, y: 0 };
  const anchor = { x: 5, y: 40 };

  it('says so when the cursor slid onto the path', () => {
    const resolved = resolveDraftingPoint({
      cursor: { x: 20, y: 40.3 }, base, anchors: [anchor], snap: null, settings: settings(), captureDistance: 1,
    });
    expect(resolved.anchored).toBe(true);
  });

  it('says so when the Ortho ray met the path', () => {
    const withOrtho = settings();
    withOrtho.orthoEnabled = true;
    const resolved = resolveDraftingPoint({
      cursor: { x: 3, y: 40.4 }, base, anchors: [anchor], snap: null, settings: withOrtho, captureDistance: 1,
    });
    // Ortho holds the vertical from the base; the catch is where that ray
    // meets the anchor's own horizontal.
    expect(resolved.point.x).toBeCloseTo(0, 9);
    expect(resolved.point.y).toBeCloseTo(anchor.y, 9);
    expect(resolved.anchored).toBe(true);
  });

  it('says so at the crossing of two acquired paths', () => {
    const resolved = resolveDraftingPoint({
      cursor: { x: 5.2, y: 9.8 }, base, anchors: [{ x: 5, y: 40 }, { x: 60, y: 10 }],
      snap: null, settings: settings(), captureDistance: 1,
    });
    expect(resolved.point.x).toBeCloseTo(5, 9);
    expect(resolved.point.y).toBeCloseTo(10, 9);
    expect(resolved.anchored).toBe(true);
  });

  it('does not say so for a plain Ortho direction, which draws its own guide', () => {
    const withOrtho = settings();
    withOrtho.orthoEnabled = true;
    const resolved = resolveDraftingPoint({
      cursor: { x: 20, y: 3 }, base, anchors: [], snap: null, settings: withOrtho, captureDistance: 1,
    });
    expect(resolved.guides).toHaveLength(1);
    expect(resolved.anchored).toBeFalsy();
  });

  it('does not say so for an object snap, which has its own mark already', () => {
    const resolved = resolveDraftingPoint({
      cursor: { x: 20, y: 40.3 }, base, anchors: [anchor], snap: { x: 3, y: 3 }, settings: settings(), captureDistance: 1,
    });
    expect(resolved.anchored).toBeFalsy();
  });
});
