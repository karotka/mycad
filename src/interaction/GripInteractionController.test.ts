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
});
