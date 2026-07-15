import { describe, expect, it } from 'vitest';
import { WindowDragController } from './WindowDragController';

describe('WindowDragController', () => {
  it('resets stale visuals and marks right-to-left selection as crossing', () => {
    const captured = new Set<number>();
    const viewport = {
      setPointerCapture: (id: number) => captured.add(id),
      hasPointerCapture: (id: number) => captured.has(id),
      releasePointerCapture: (id: number) => captured.delete(id),
    } as unknown as HTMLElement;
    const classes = new Set<string>(['crossing']);
    const element = {
      hidden: true,
      style: { left: '90px', top: '80px', width: '70px', height: '60px' },
      classList: {
        remove: (name: string) => classes.delete(name),
        toggle: (name: string, enabled: boolean) => enabled ? classes.add(name) : classes.delete(name),
      },
    } as unknown as HTMLElement;
    const controller = new WindowDragController(viewport, element);

    controller.begin({ x: 50, y: 40 }, 7, 'select');
    expect(element.style.width).toBe('0px');
    expect(classes.has('crossing')).toBe(false);
    controller.update({ x: 10, y: 80 });
    expect(classes.has('crossing')).toBe(true);
    expect(controller.finish(7)?.current).toEqual({ x: 10, y: 80 });
    expect(element.hidden).toBe(true);
    expect(captured.size).toBe(0);
  });
});
