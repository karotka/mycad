import { describe, expect, it, vi } from 'vitest';
import type { GripController } from './GripController';
import { GripInteractionController } from './GripInteractionController';

describe('GripInteractionController', () => {
  it('owns latched editing, snap mode and pointer capture lifecycle', () => {
    const grips = { begin: vi.fn(), commit: vi.fn(), cancel: vi.fn(), hoveredGrip: 2, isDragging: true } as unknown as GripController;
    let captured = false;
    const viewport = {
      setPointerCapture: vi.fn(() => { captured = true; }),
      hasPointerCapture: vi.fn(() => captured),
      releasePointerCapture: vi.fn(() => { captured = false; }),
    } as unknown as HTMLElement;
    const controller = new GripInteractionController(grips, viewport);

    controller.begin(undefined, undefined, 2, { x: 1, y: 2 }, 9);
    controller.setTargetSnapMode('end');
    expect(controller.isLatched).toBe(true);
    expect(controller.targetSnapMode).toBe('end');

    controller.finishClick(9);
    expect(controller.isLatched).toBe(false);
    expect(controller.targetSnapMode).toBeNull();
    expect(viewport.releasePointerCapture).toHaveBeenCalledWith(9);
  });

  it('commitTypedPoint finishes a latched drag at an absolute point, like a typed rectangle dimension', () => {
    const grips = { begin: vi.fn(), update: vi.fn(), commit: vi.fn(), cancel: vi.fn(), hoveredGrip: 3, isDragging: true } as unknown as GripController;
    const viewport = { setPointerCapture: vi.fn(), hasPointerCapture: vi.fn(() => false), releasePointerCapture: vi.fn() } as unknown as HTMLElement;
    const controller = new GripInteractionController(grips, viewport);
    controller.begin(undefined, undefined, 0, { x: 0, y: 0 }, 5);
    controller.setTargetSnapMode('end');

    expect(controller.commitTypedPoint({ x: 25, y: 9 })).toBe(true);
    expect(grips.update).toHaveBeenCalledWith({ x: 25, y: 9 });
    expect(grips.commit).toHaveBeenCalled();
    expect(controller.isLatched).toBe(false);
    expect(controller.targetSnapMode).toBeNull();
    expect(grips.hoveredGrip).toBe(-1);
  });

  it('commitTypedPoint does nothing once the drag is no longer latched', () => {
    const grips = { begin: vi.fn(), update: vi.fn(), commit: vi.fn(), cancel: vi.fn(), hoveredGrip: 0, isDragging: false } as unknown as GripController;
    const viewport = { setPointerCapture: vi.fn(), hasPointerCapture: vi.fn(() => false), releasePointerCapture: vi.fn() } as unknown as HTMLElement;
    const controller = new GripInteractionController(grips, viewport);

    expect(controller.commitTypedPoint({ x: 1, y: 1 })).toBe(false);
    expect(grips.update).not.toHaveBeenCalled();
    expect(grips.commit).not.toHaveBeenCalled();
  });
});
