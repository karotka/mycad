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
} = {}): PointResolverContext {
  const doc = new Document();
  doc.viewMode = '3d';
  return {
    doc,
    commands: { active: undefined } as unknown as PointResolverContext['commands'],
    gripController: { isDragging: false } as unknown as PointResolverContext['gripController'],
    gripInteraction: { targetSnapMode: null } as unknown as PointResolverContext['gripInteraction'],
    drawingInteraction: { targetSnapMode: null } as unknown as PointResolverContext['drawingInteraction'],
    renderer2d: {} as unknown as PointResolverContext['renderer2d'],
    renderer3d: {
      workPlanePoint: overrides.workPlanePoint ?? vi.fn(() => null),
      viewPlanePoint: overrides.viewPlanePoint ?? vi.fn(() => ({ x: 3, y: 4 })),
      renderer: { domElement: {} as HTMLCanvasElement },
    } as unknown as PointResolverContext['renderer3d'],
    viewport: {} as unknown as HTMLElement,
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
