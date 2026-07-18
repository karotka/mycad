import { describe, expect, it } from 'vitest';
import { resolvePointerGesture, type PointerGestureInput } from './PointerGesture';

const press = (overrides: Partial<PointerGestureInput> = {}): PointerGestureInput => ({
  button: 0,
  metaKey: false,
  altKey: false,
  onViewToggle: false,
  zoomWindowArmed: false,
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

  it('is an ordinary interaction otherwise', () => {
    expect(resolvePointerGesture(press())).toEqual({ kind: 'interact' });
  });

  it('ignores buttons it has no meaning for', () => {
    expect(resolvePointerGesture(press({ button: 3 }))).toEqual({ kind: 'ignore' });
    expect(resolvePointerGesture(press({ button: 4 }))).toEqual({ kind: 'ignore' });
  });

  describe('panning', () => {
    // Two fingers and a press is the right button on a trackpad, and that is the
    // pan gesture — so it must pan from anywhere, including over a selection.
    it('pans on the right button, the middle button and Alt+left', () => {
      expect(resolvePointerGesture(press({ button: 2 })).kind).toBe('pan');
      expect(resolvePointerGesture(press({ button: 1 })).kind).toBe('pan');
      expect(resolvePointerGesture(press({ altKey: true })).kind).toBe('pan');
    });

    // Only the release can tell a pan from a click, so nothing under the cursor
    // is consulted here — that is what used to make a selected object unpannable.
    it('starts the same pan wherever the press lands', () => {
      const gestures = [press({ button: 2 }), press({ button: 2, zoomWindowArmed: false })]
        .map(resolvePointerGesture);
      expect(gestures.every((gesture) => gesture.kind === 'pan')).toBe(true);
    });

    it('marks only the right button as able to become a menu', () => {
      const right = resolvePointerGesture(press({ button: 2 }));
      expect(right).toEqual({ kind: 'pan', opensMenuIfStill: true });
      for (const other of [press({ button: 1 }), press({ altKey: true })]) {
        expect(resolvePointerGesture(other)).toEqual({ kind: 'pan', opensMenuIfStill: false });
      }
    });
  });

  describe('the right button is always live', () => {
    // Mid-command and mid-grip-drag it still pans and can open the menu — that
    // menu is the only way to pick an object snap, and snaps are what a drawing
    // command is for. It must never be swallowed.
    it('stays a pan-and-menu whatever is in progress', () => {
      expect(resolvePointerGesture(press({ button: 2 }))).toEqual({ kind: 'pan', opensMenuIfStill: true });
      expect(resolvePointerGesture(press({ button: 2, zoomWindowArmed: true }))).toEqual({ kind: 'pan', opensMenuIfStill: true });
    });
  });
});
