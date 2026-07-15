import { describe, expect, it, vi } from 'vitest';
import { PreviewController } from './PreviewController';

function element() {
  return { textContent: '', style: { left: '', top: '' }, hidden: true } as unknown as HTMLElement;
}

describe('PreviewController', () => {
  it('owns preview state and resets all transient markers', () => {
    const dimension = element(), origin = element(), target = element(), snap = element();
    const controller = new PreviewController(dimension, origin, target, snap);
    controller.setPreview({ type: 'line', data: {} });
    controller.showMarker(origin, 10, 20);
    controller.showMarker(target, 30, 40);
    controller.showSnap({ x: 1, y: 2, z: 3 }, 50, 60);

    controller.reset();

    expect(controller.preview).toBeUndefined();
    expect([origin.hidden, target.hidden, snap.hidden]).toEqual([true, true, true]);
  });

  it('uses a projected 3D position for the snap marker', () => {
    const snap = element();
    const project = vi.fn(() => ({ x: 12, y: 34 }));
    const controller = new PreviewController(element(), element(), element(), snap, project);
    controller.showSnap({ x: 1, y: 2, z: 3 }, 90, 80);
    expect(snap.style.left).toBe('12px');
    expect(snap.style.top).toBe('34px');
  });
});
