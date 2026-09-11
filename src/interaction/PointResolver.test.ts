import { describe, expect, it, vi } from 'vitest';
import { Document } from '../core/Document';
import { createPointResolver, type PointResolverContext } from './PointResolver';

/**
 * A minimal fake covering only what `interactionPoint`'s generic 3D tail
 * touches, following this codebase's `as unknown as X` partial-mock
 * convention for the other interaction controllers.
 */
function makeCtx(overrides: {
  workPlanePoint?: ReturnType<typeof vi.fn>;
  viewPlanePoint?: ReturnType<typeof vi.fn>;
  doc?: Document;
  screenToWorld?: (sx: number, sy: number, width: number, height: number) => { x: number; y: number };
} = {}): PointResolverContext {
  const doc = overrides.doc ?? new Document();
  if (!overrides.doc) doc.viewMode = '3d';
  return {
    doc,
    commands: { active: undefined } as unknown as PointResolverContext['commands'],
    gripController: { isDragging: false, draggingObjectId: null, dragReferencePoint: () => null } as unknown as PointResolverContext['gripController'],
    gripInteraction: { targetSnapMode: null } as unknown as PointResolverContext['gripInteraction'],
    drawingInteraction: { targetSnapMode: null } as unknown as PointResolverContext['drawingInteraction'],
    renderer2d: {
      screenToWorld: overrides.screenToWorld ?? (() => ({ x: 0, y: 0 })),
      zoom: 1,
      pan: { x: 0, y: 0 },
    } as unknown as PointResolverContext['renderer2d'],
    renderer3d: {
      workPlanePoint: overrides.workPlanePoint ?? vi.fn(() => null),
      viewPlanePoint: overrides.viewPlanePoint ?? vi.fn(() => ({ x: 3, y: 4 })),
      renderer: { domElement: {} as HTMLCanvasElement },
    } as unknown as PointResolverContext['renderer3d'],
    viewport: { getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }) } as unknown as HTMLElement,
    trackingLine: {} as unknown as HTMLElement,
    centerGuideA: { style: {} } as unknown as HTMLElement,
    centerGuideB: { style: {} } as unknown as HTMLElement,
    size: () => ({ width: 800, height: 600 }),
    state: { activeTracking: null, activeEndpointAnchor: null },
  };
}

describe('interactionPoint (3D, no active command)', () => {
  it('falls back to the view plane when the active UCS plane is edge-on to the camera', () => {
    // A UCS rotated to stand up out of the screen (UCS X/Y/Z) can sit
    // near-parallel to every ray the camera casts — the work-plane
    // intersection then misses everywhere, same as the transform-objects
    // branch already guards against.
    const workPlanePoint = vi.fn(() => null);
    const viewPlanePoint = vi.fn(() => ({ x: 3, y: 4 }));
    const ctx = makeCtx({ workPlanePoint, viewPlanePoint });
    const resolver = createPointResolver(ctx);

    const result = resolver.interactionPoint({ clientX: 100, clientY: 100 });

    expect(workPlanePoint).toHaveBeenCalled();
    expect(viewPlanePoint).toHaveBeenCalledWith(ctx.renderer3d.renderer.domElement, 100, 100);
    expect(result).toEqual({ x: 3, y: 4 });
  });

  it('uses the UCS-plane point directly when the ray does hit it', () => {
    const workPlanePoint = vi.fn(() => ({ x: 7, y: 9 }));
    const viewPlanePoint = vi.fn(() => ({ x: -1, y: -1 }));
    const ctx = makeCtx({ workPlanePoint, viewPlanePoint });
    const resolver = createPointResolver(ctx);

    const result = resolver.interactionPoint({ clientX: 50, clientY: 50 });

    expect(viewPlanePoint).not.toHaveBeenCalled();
    expect(result).toEqual({ x: 7, y: 9 });
  });
});

describe('nearestPersistentSnap', () => {
  it('finds the "Nearest" point on an edge in 2D view too, not only in 3D', () => {
    // "Nearest" used to be resolved only for the 3D branch (via a camera ray);
    // 2D view fell straight through to nothing, so a curve that only lived on
    // the 2D canvas could never be snapped to at all.
    const doc = new Document();
    doc.viewMode = '2d';
    doc.drafting.objectSnapEnabled = true;
    doc.drafting.objectSnapModes = ['nearest'];
    doc.addEntity(doc.createLine({ x: 0, y: 0 }, { x: 10, y: 0 }));
    // The cursor at screen (100,100) resolves to world (5, 3) on the 2D canvas —
    // near, but not on, the line.
    const ctx = makeCtx({ doc, screenToWorld: () => ({ x: 5, y: 3 }) });
    const resolver = createPointResolver(ctx);

    const result = resolver.nearestPersistentSnap({ clientX: 100, clientY: 100 });

    expect(result).not.toBeNull();
    expect(result!.mode).toBe('nearest');
    expect(result!.world).toEqual({ x: 5, y: 0, z: 0 });
  });
});

describe('nearestPersistentSnap: a rectangle\'s derived centre, earned by grazing two of its edge midpoints', () => {
  // A big rectangle (0,0)->(100,60) so the default 10-unit snap aperture
  // cannot accidentally reach a neighbouring edge midpoint from the centre —
  // this is about which candidates exist, not about aperture tuning. Edge
  // midpoints at (50,0), (100,30), (50,60), (0,30); true centre at (50,30) —
  // not itself a drawn point, so only reachable this way or via the ambient
  // Center object snap (deliberately left off below, to prove this path does
  // not depend on it).
  function setupRectangle() {
    const doc = new Document();
    doc.viewMode = '2d';
    doc.drafting.objectSnapEnabled = true;
    doc.drafting.objectSnapModes = ['middle'];
    doc.addEntity(doc.createRectangle({ x: 0, y: 0 }, { x: 100, y: 60 }));
    return doc;
  }
  // Keyed by clientX alone (rect.left is 0 in the mock, and sy is unused by
  // any of these points) so each call in a test can ask for a specific world
  // point just by picking which clientX it passes.
  function screenToWorldAt(points: Record<number, { x: number; y: number }>) {
    return (sx: number) => points[sx] ?? { x: 999, y: 999 };
  }

  it('offers the true centre once two different edge midpoints have been hovered', () => {
    const doc = setupRectangle();
    const ctx = makeCtx({ doc, screenToWorld: screenToWorldAt({ 10: { x: 50, y: 0 }, 20: { x: 0, y: 30 }, 30: { x: 50, y: 30 } }) });
    const resolver = createPointResolver(ctx);

    const first = resolver.nearestPersistentSnap({ clientX: 10, clientY: 0 });
    expect(first?.mode).toBe('middle');
    const second = resolver.nearestPersistentSnap({ clientX: 20, clientY: 0 });
    expect(second?.mode).toBe('middle');

    const atCenter = resolver.nearestPersistentSnap({ clientX: 30, clientY: 0 });
    expect(atCenter?.mode).toBe('center');
    expect(atCenter?.world).toEqual({ x: 50, y: 30, z: 0 });
  });

  it('shows the two symmetry guide lines once primed and the cursor is near the rectangle, and hides them when it wanders off', () => {
    const doc = setupRectangle();
    const ctx = makeCtx({ doc, screenToWorld: screenToWorldAt({
      10: { x: 50, y: 0 }, 20: { x: 0, y: 30 }, 30: { x: 50, y: 30 }, 40: { x: 1000, y: 1000 },
    }) });
    const resolver = createPointResolver(ctx);

    resolver.nearestPersistentSnap({ clientX: 10, clientY: 0 }); // prime edge 0
    resolver.nearestPersistentSnap({ clientX: 20, clientY: 0 }); // prime edge 3 — two different edges now

    resolver.updateCenterGuideLines({ clientX: 30, clientY: 0 }); // cursor near the centre
    expect((ctx.centerGuideA as unknown as { hidden: boolean }).hidden).toBe(false);
    expect((ctx.centerGuideB as unknown as { hidden: boolean }).hidden).toBe(false);
    // Vertical symmetry line: bottom-edge midpoint (50,0) <-> top-edge (50,60),
    // canvas 800x600, no pan/zoom — screen (450,300) <-> (450,240).
    expect(ctx.centerGuideA.style.left).toBe('450px');
    expect(ctx.centerGuideA.style.top).toBe('300px');
    expect(ctx.centerGuideA.style.width).toBe('60px');
    // Horizontal symmetry line: right-edge midpoint (100,30) <-> left-edge (0,30)
    // — screen (500,270) <-> (400,270).
    expect(ctx.centerGuideB.style.left).toBe('500px');
    expect(ctx.centerGuideB.style.top).toBe('270px');
    expect(ctx.centerGuideB.style.width).toBe('100px');

    resolver.updateCenterGuideLines({ clientX: 40, clientY: 0 }); // cursor far away now
    expect((ctx.centerGuideA as unknown as { hidden: boolean }).hidden).toBe(true);
    expect((ctx.centerGuideB as unknown as { hidden: boolean }).hidden).toBe(true);
  });

  it('offers nothing at the centre after only one edge midpoint has been hovered', () => {
    const doc = setupRectangle();
    const ctx = makeCtx({ doc, screenToWorld: screenToWorldAt({ 10: { x: 50, y: 0 }, 30: { x: 50, y: 30 } }) });
    const resolver = createPointResolver(ctx);

    resolver.nearestPersistentSnap({ clientX: 10, clientY: 0 });
    const atCenter = resolver.nearestPersistentSnap({ clientX: 30, clientY: 0 });
    expect(atCenter).toBeNull();
  });

  it('offers nothing at the centre after hovering the same edge midpoint twice (not two different edges)', () => {
    const doc = setupRectangle();
    const ctx = makeCtx({ doc, screenToWorld: screenToWorldAt({ 10: { x: 50, y: 0 }, 30: { x: 50, y: 30 } }) });
    const resolver = createPointResolver(ctx);

    resolver.nearestPersistentSnap({ clientX: 10, clientY: 0 });
    resolver.nearestPersistentSnap({ clientX: 10, clientY: 0 });
    const atCenter = resolver.nearestPersistentSnap({ clientX: 30, clientY: 0 });
    expect(atCenter).toBeNull();
  });
});

describe('nearestGripTargetSnap (forced one-shot override)', () => {
  it('resolves a forced "Nearest" override even where a competing Endpoint would otherwise win', () => {
    // objectSnapCandidates returns nothing at all for 'nearest' — it has no
    // discrete points — so a forced override needs its own resolution path,
    // the same edge-lookup nearestPersistentSnap's own tail uses.
    const doc = new Document();
    doc.viewMode = '2d';
    doc.addEntity(doc.createLine({ x: 0, y: 0 }, { x: 10, y: 0 }));
    const ctx = makeCtx({ doc, screenToWorld: () => ({ x: 5, y: 3 }) });
    const resolver = createPointResolver(ctx);

    const result = resolver.nearestGripTargetSnap({ clientX: 100, clientY: 100 }, 'nearest');

    expect(result).not.toBeNull();
    expect(result!.mode).toBe('nearest');
    expect(result!.world).toEqual({ x: 5, y: 0, z: 0 });
  });
});

describe('interactionPoint (drawing branch): drawingPlane only latches on a real click', () => {
  it('does not commit a new drawingPlane from a mere hover preview, only from an actual click', () => {
    // interactionPoint serves both the pointermove preview (called on every
    // frame the cursor moves) and the real click that follows — merely
    // grazing an off-UCS endpoint on the way to clicking somewhere else must
    // not silently lock the rest of the command onto that plane. Confirmed
    // directly: it made the drawing-plane marker appear to float free of the
    // cursor, latched onto a past hover position instead of the current one.
    const doc = new Document();
    doc.viewMode = '3d';
    doc.drafting.objectSnapEnabled = true;
    doc.drafting.objectSnapModes = ['end'];
    const line = doc.createLine({ x: 0, y: 0 }, { x: 10, y: 0 });
    // Off the world UCS both in elevation AND in x/y, so a marker drawn at
    // plane.origin (the UCS origin merely shifted in z) lands somewhere
    // else entirely from a marker drawn at the real snapped point.
    line.workPlane = {
      origin: { x: 30, y: 20, z: 5 },
      xAxis: { x: 1, y: 0, z: 0 },
      yAxis: { x: 0, y: 1, z: 0 },
      zAxis: { x: 0, y: 0, z: 1 },
    };
    doc.addEntity(line);
    const active = {
      name: 'LINE',
      stepIndex: 0,
      steps: [{ kind: 'point', label: 'Start point:' }],
      data: {} as Record<string, unknown>,
    };
    const ctx = makeCtx({ doc });
    ctx.commands = { active } as unknown as typeof ctx.commands;
    ctx.renderer3d = {
      ...ctx.renderer3d,
      // Every candidate "projects" right onto the cursor — the only thing
      // this test needs is that the endpoint snap resolves at all.
      projectCadPoint: vi.fn(() => ({ x: 50, y: 50 })),
    } as unknown as typeof ctx.renderer3d;
    const resolver = createPointResolver(ctx);

    resolver.interactionPoint({ clientX: 50, clientY: 50 }); // preview — no commit arg
    expect(active.data.drawingPlane).toBeUndefined();

    const committed = resolver.interactionPoint({ clientX: 50, clientY: 50 }, true);
    expect(committed).not.toBeNull();
    expect(active.data.drawingPlane).toBeDefined();
  });

  it('stores the real snapped point as drawingPlaneAnchor, not the plane\'s own (UCS-origin-derived) origin', () => {
    // plane.origin only ever shares the snapped point's elevation along the
    // UCS normal — its own x/y stay at the UCS origin's, since only
    // orientation matters for the plane-fitting math. A marker drawn there
    // instead of at the real point lands nowhere near where the user clicked.
    const doc = new Document();
    doc.viewMode = '3d';
    doc.drafting.objectSnapEnabled = true;
    doc.drafting.objectSnapModes = ['end'];
    const line = doc.createLine({ x: 0, y: 0 }, { x: 10, y: 0 });
    line.workPlane = {
      origin: { x: 30, y: 20, z: 5 },
      xAxis: { x: 1, y: 0, z: 0 },
      yAxis: { x: 0, y: 1, z: 0 },
      zAxis: { x: 0, y: 0, z: 1 },
    };
    doc.addEntity(line);
    const active = {
      name: 'LINE',
      stepIndex: 0,
      steps: [{ kind: 'point', label: 'Start point:' }],
      data: {} as Record<string, unknown>,
    };
    const ctx = makeCtx({ doc });
    ctx.commands = { active } as unknown as typeof ctx.commands;
    ctx.renderer3d = {
      ...ctx.renderer3d,
      projectCadPoint: vi.fn(() => ({ x: 50, y: 50 })),
    } as unknown as typeof ctx.renderer3d;
    const resolver = createPointResolver(ctx);

    resolver.interactionPoint({ clientX: 50, clientY: 50 }, true);

    expect(active.data.drawingPlaneAnchor).toEqual({ x: 30, y: 20, z: 5 });
    const plane = active.data.drawingPlane as { origin: { x: number; y: number; z: number } };
    expect(plane.origin).toEqual({ x: 0, y: 0, z: 5 });
  });
});

describe('interactionPoint (drawing branch): BEZIER/SPLINE ignore a frozen drawingPlane, every other command honors it', () => {
  // Real regression, reported directly: drawing a spline by hovering a
  // different box face for each point stayed flat — the FIRST point that
  // ever triggered the (unrelated) off-plane-snap heuristic froze
  // active.data.drawingPlane, and every later point silently got flattened
  // back onto that one plane instead of whatever Dynamic UCS had since
  // moved doc.activeWorkPlane to.
  const frozenPlane = {
    origin: { x: 100, y: 0, z: 0 },
    xAxis: { x: 1, y: 0, z: 0 }, yAxis: { x: 0, y: 1, z: 0 }, zAxis: { x: 0, y: 0, z: 1 },
  };

  it('BEZIER reads the CURRENT doc.activeWorkPlane for each point, not a drawingPlane an earlier point froze', () => {
    // Distinguishes by WHICH plane object arrives, not merely whether one
    // did — both branches now pass an explicit plane, but a per-point
    // command must pass doc.activeWorkPlane (the live one), never the
    // stale frozen one.
    const workPlanePoint = vi.fn((_canvas: unknown, _x: number, _y: number, plane?: unknown) => (plane === frozenPlane ? { x: 99, y: 99 } : { x: 7, y: 8 }));
    const doc = new Document();
    doc.viewMode = '3d';
    const active = {
      name: 'BEZIER', stepIndex: 1, steps: [{ kind: 'point', label: '' }, { kind: 'point', label: '' }],
      data: { drawingPlane: frozenPlane } as Record<string, unknown>,
    };
    const ctx = makeCtx({ doc, workPlanePoint });
    ctx.commands = { active } as unknown as typeof ctx.commands;
    const resolver = createPointResolver(ctx);

    const result = resolver.interactionPoint({ clientX: 50, clientY: 50 });

    expect(workPlanePoint).toHaveBeenCalledWith(ctx.renderer3d.renderer.domElement, 50, 50, doc.activeWorkPlane);
    // Also carries the point's true world position along, so drawBezier can
    // place it in real 3D rather than flattening it through x/y alone.
    expect(result).toMatchObject({ x: 7, y: 8, world: expect.anything() });
  });

  it('an ordinary command (LINE) still honors a frozen drawingPlane for every point after the first', () => {
    const workPlanePoint = vi.fn((_canvas: unknown, _x: number, _y: number, plane?: unknown) => (plane ? { x: 99, y: 99 } : { x: 7, y: 8 }));
    const doc = new Document();
    doc.viewMode = '3d';
    const active = {
      name: 'LINE', stepIndex: 1, steps: [{ kind: 'point', label: '' }, { kind: 'point', label: '' }],
      data: { drawingPlane: frozenPlane } as Record<string, unknown>,
    };
    const ctx = makeCtx({ doc, workPlanePoint });
    ctx.commands = { active } as unknown as typeof ctx.commands;
    const resolver = createPointResolver(ctx);

    const result = resolver.interactionPoint({ clientX: 50, clientY: 50 });

    expect(workPlanePoint).toHaveBeenCalledWith(ctx.renderer3d.renderer.domElement, 50, 50, frozenPlane);
    expect(result).toEqual({ x: 99, y: 99 });
  });
});
