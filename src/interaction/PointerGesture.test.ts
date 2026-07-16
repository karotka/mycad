import { describe, expect, it } from 'vitest';
import { resolvePointerGesture, type PointerGestureInput } from './PointerGesture';

const press = (overrides: Partial<PointerGestureInput> = {}): PointerGestureInput => ({
  button: 0,
  metaKey: false,
  altKey: false,
  onViewToggle: false,
  zoomWindowArmed: false,
  gripLatched: false,
  awaitingPoint: false,
  overSelectedObject: false,
  ...overrides,
});

describe('what a press in the viewport means', () => {
  it('leaves the view toggle to itself, whatever else is going on', () => {
    expect(resolvePointerGesture(press({ onViewToggle: true, zoomWindowArmed: true }))).toEqual({ kind: 'ignore' });
  });

  it('draws a zoom rectangle while zoom-window mode is armed', () => {
    expect(resolvePointerGesture(press({ zoomWindowArmed: true }))).toEqual({ kind: 'zoomWindow' });
  });

  it('does not arm zoom-window on any button but the left', () => {
    expect(resolvePointerGesture(press({ zoomWindowArmed: true, button: 1 })).kind).toBe('pan');
  });

  it('reads Command+left as a possible orbit', () => {
    expect(resolvePointerGesture(press({ metaKey: true }))).toEqual({ kind: 'orbit' });
  });

  it('pans on the middle button and on Alt+left', () => {
    expect(resolvePointerGesture(press({ button: 1 }))).toEqual({ kind: 'pan', suppressContextMenu: false });
    expect(resolvePointerGesture(press({ altKey: true }))).toEqual({ kind: 'pan', suppressContextMenu: false });
  });

  it('is an ordinary interaction otherwise', () => {
    expect(resolvePointerGesture(press())).toEqual({ kind: 'interact' });
  });

  it('ignores buttons it has no meaning for', () => {
    expect(resolvePointerGesture(press({ button: 3 }))).toEqual({ kind: 'ignore' });
    expect(resolvePointerGesture(press({ button: 4 }))).toEqual({ kind: 'ignore' });
  });

  describe('the right button', () => {
    // The subtle one: it decides about the menu and then falls through to a pan.
    it('pans, and swallows the menu it would have opened', () => {
      expect(resolvePointerGesture(press({ button: 2 }))).toEqual({ kind: 'pan', suppressContextMenu: true });
    });

    it('opens the object menu instead when the press is on something selected', () => {
      expect(resolvePointerGesture(press({ button: 2, overSelectedObject: true }))).toEqual({ kind: 'objectMenu' });
    });

    it('keeps out of the way of a latched grip', () => {
      expect(resolvePointerGesture(press({ button: 2, gripLatched: true }))).toEqual({ kind: 'ignore' });
    });

    it('keeps out of the way of a command waiting for a point', () => {
      expect(resolvePointerGesture(press({ button: 2, awaitingPoint: true }))).toEqual({ kind: 'ignore' });
    });

    // A latched grip wins over the object menu: it asked first.
    it('lets the latched grip win over a selected object underneath', () => {
      expect(resolvePointerGesture(press({ button: 2, gripLatched: true, overSelectedObject: true })))
        .toEqual({ kind: 'ignore' });
    });
  });

  // Only a pan that displaced a context menu should swallow one.
  it('never swallows a menu it did not displace', () => {
    for (const input of [press({ button: 1 }), press({ altKey: true })]) {
      const gesture = resolvePointerGesture(input);
      expect(gesture.kind === 'pan' && gesture.suppressContextMenu).toBe(false);
    }
  });
});
