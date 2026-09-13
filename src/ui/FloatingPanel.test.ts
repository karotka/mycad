import { describe, expect, it } from 'vitest';
import { clampPanelPosition } from './FloatingPanel';

describe('clampPanelPosition', () => {
  const panel = { width: 340, height: 400 };
  const viewport = { width: 1200, height: 800 };

  it('leaves a panel dropped well inside the window exactly where it was put', () => {
    expect(clampPanelPosition({ x: 300, y: 200 }, panel, viewport)).toEqual({ x: 300, y: 200 });
  });

  it('never lets a panel past the top or left edge, where its header would go out of reach', () => {
    expect(clampPanelPosition({ x: -500, y: -80 }, panel, viewport)).toEqual({ x: 4, y: 4 });
  });

  it('lets a panel hang off the right and bottom, but keeps enough of it to grab', () => {
    const far = clampPanelPosition({ x: 5000, y: 5000 }, panel, viewport);
    // Still on screen by more than nothing, and by less than its whole width:
    // hanging off the edge is allowed, disappearing is not.
    expect(far.x).toBeLessThan(viewport.width);
    expect(viewport.width - far.x).toBeGreaterThanOrEqual(48);
    expect(viewport.height - far.y).toBeGreaterThanOrEqual(48);
  });

  it('brings a panel back when the window it was saved in is now smaller — the case that would otherwise lose it', () => {
    const saved = { x: 1100, y: 700 };
    const smaller = { width: 640, height: 480 };
    const rescued = clampPanelPosition(saved, panel, smaller);
    expect(rescued.x).toBeLessThanOrEqual(smaller.width - 48);
    expect(rescued.y).toBeLessThanOrEqual(smaller.height - 48);
  });

  it('still yields a usable position in a window smaller than the panel itself', () => {
    const tiny = { width: 200, height: 120 };
    const position = clampPanelPosition({ x: 900, y: 900 }, panel, tiny);
    expect(position.x).toBeGreaterThanOrEqual(4);
    expect(position.y).toBeGreaterThanOrEqual(4);
    expect(position.x).toBeLessThan(tiny.width);
    expect(position.y).toBeLessThan(tiny.height);
  });
});
