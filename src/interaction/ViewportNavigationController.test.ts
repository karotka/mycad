import { describe, expect, it, vi } from 'vitest';
import type { Document } from '../core/Document';
import type { Canvas2DRenderer } from '../render/Canvas2DRenderer';
import type { Viewport3D } from '../render/Viewport3D';
import { ViewportNavigationController } from './ViewportNavigationController';

class FakeViewport {
  readonly classList = { add: vi.fn(), remove: vi.fn() };
  readonly setPointerCapture = vi.fn((pointerId: number) => { this.capture = pointerId; });
  readonly releasePointerCapture = vi.fn(() => { this.capture = null; });
  private capture: number | null = null;
  private wheel?: (event: WheelEvent) => void;

  addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    if (type === 'wheel') this.wheel = listener as (event: WheelEvent) => void;
  }

  removeEventListener(type: string): void {
    if (type === 'wheel') this.wheel = undefined;
  }

  getBoundingClientRect(): DOMRect {
    return { left: 10, top: 20, width: 800, height: 600 } as DOMRect;
  }

  hasPointerCapture(pointerId: number): boolean { return this.capture === pointerId; }

  dispatchWheel(values: Partial<WheelEvent>): void {
    this.wheel?.({
      clientX: 410,
      clientY: 320,
      deltaX: 0,
      deltaY: 0,
      metaKey: false,
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
      ...values,
    } as WheelEvent);
  }
}

function setup(mode: '2d' | '3d' = '2d') {
  const doc = { viewMode: mode } as Document;
  const viewport = new FakeViewport();
  const renderer2dFake = {
    pan: { x: 0, y: 0 },
    zoom: 10,
    screenToWorld(x: number, y: number, width: number, height: number) {
      return {
        x: (x - width / 2) / renderer2dFake.zoom + renderer2dFake.pan.x,
        y: (height / 2 - y) / renderer2dFake.zoom + renderer2dFake.pan.y,
      };
    },
  };
  const renderer2d = renderer2dFake as unknown as Canvas2DRenderer;
  const renderer3d = {
    orbitByScreenDelta: vi.fn(),
    panByScreenDelta: vi.fn(),
    zoomByWheelDelta: vi.fn(),
    render: vi.fn(),
  } as unknown as Viewport3D;
  const redraw = vi.fn();
  const enter3dForOrbit = vi.fn(() => { doc.viewMode = '3d'; });
  const controller = new ViewportNavigationController(
    doc,
    viewport as unknown as HTMLElement,
    renderer2d,
    renderer3d,
    { redraw, enter3dForOrbit },
  );
  return { controller, doc, viewport, renderer2d, renderer3d, redraw, enter3dForOrbit };
}

describe('ViewportNavigationController', () => {
  it('pans in 2D until the captured pointer is released', () => {
    const { controller, viewport, renderer2d, redraw } = setup();
    controller.beginPan({ x: 100, y: 100 }, 7);

    expect(controller.updatePointer({ x: 120, y: 90 })).toBe(true);
    expect(renderer2d.pan).toEqual({ x: -2, y: -1 });
    expect(redraw).toHaveBeenCalledOnce();
    expect(controller.endPan(7)).toBe(true);
    expect(viewport.releasePointerCapture).toHaveBeenCalledWith(7);
  });

  it('zooms 2D around the cursor without changing the world point beneath it', () => {
    const { viewport, renderer2d, redraw } = setup();
    const before = renderer2d.screenToWorld(400, 300, 800, 600);

    viewport.dispatchWheel({ deltaY: -100 });

    expect(renderer2d.zoom).toBeGreaterThan(10);
    expect(renderer2d.screenToWorld(400, 300, 800, 600)).toEqual(before);
    expect(redraw).toHaveBeenCalledOnce();
  });

  it('enters 3D and orbits only for a non-empty Command-wheel gesture', () => {
    const { viewport, renderer3d, enter3dForOrbit } = setup();
    viewport.dispatchWheel({ metaKey: true });
    expect(enter3dForOrbit).not.toHaveBeenCalled();

    viewport.dispatchWheel({ metaKey: true, deltaX: 12, deltaY: -5 });
    expect(enter3dForOrbit).toHaveBeenCalledOnce();
    const [dx, dy] = vi.mocked(renderer3d.orbitByScreenDelta).mock.calls[0];
    expect(dx).toBeCloseTo(7.2);
    expect(dy).toBe(-3);
    expect(renderer3d.render).toHaveBeenCalledOnce();
  });

  it('zooms the 3D camera when Command is not held', () => {
    const { viewport, renderer3d } = setup('3d');
    viewport.dispatchWheel({ deltaY: 40 });
    expect(renderer3d.zoomByWheelDelta).toHaveBeenCalledWith(40);
    expect(renderer3d.render).toHaveBeenCalledOnce();
  });
});
