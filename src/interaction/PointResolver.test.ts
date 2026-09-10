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
    } as unknown as PointResolverContext['renderer2d'],
    renderer3d: {
      workPlanePoint: overrides.workPlanePoint ?? vi.fn(() => null),
      viewPlanePoint: overrides.viewPlanePoint ?? vi.fn(() => ({ x: 3, y: 4 })),
      renderer: { domElement: {} as HTMLCanvasElement },
    } as unknown as PointResolverContext['renderer3d'],
    viewport: { getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }) } as unknown as HTMLElement,
    trackingLine: {} as unknown as HTMLElement,
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
    line.workPlane = {
      origin: { x: 0, y: 0, z: 5 },
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
});
