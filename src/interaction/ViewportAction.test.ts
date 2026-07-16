import { describe, expect, it } from 'vitest';
import { grabsGrip, resolveViewportAction, type ViewportPick } from './ViewportAction';

const click = (overrides: Partial<ViewportPick> = {}): ViewportPick => ({
  commandActive: false,
  multiObjectStep: false,
  gripIndex: -1,
  hasSelection: false,
  entityHit: false,
  solidHit: false,
  canWindowSelect: true,
  ...overrides,
});

describe('what a click in the viewport does', () => {
  it('drags a grip of the selection when one is under the cursor', () => {
    expect(resolveViewportAction(click({ gripIndex: 2, hasSelection: true })))
      .toEqual({ kind: 'dragGrip' });
  });

  it('ignores a grip with nothing selected — there are none on screen', () => {
    expect(resolveViewportAction(click({ gripIndex: 2, hasSelection: false })))
      .toEqual({ kind: 'windowSelect' });
  });

  // While a command runs the click is the command's, even over a grip.
  it('gives the click to a running command rather than to a grip', () => {
    expect(resolveViewportAction(click({ commandActive: true, gripIndex: 2, hasSelection: true })))
      .toEqual({ kind: 'commandClick' });
  });

  it('feeds a running command whatever was picked', () => {
    for (const hit of [{ entityHit: true }, { solidHit: true }, {}]) {
      expect(resolveViewportAction(click({ commandActive: true, ...hit })))
        .toEqual({ kind: 'commandClick' });
    }
  });

  it('selects an entity, and a solid when there is no entity', () => {
    expect(resolveViewportAction(click({ entityHit: true }))).toEqual({ kind: 'selectEntity' });
    expect(resolveViewportAction(click({ solidHit: true }))).toEqual({ kind: 'selectSolid' });
  });

  it('prefers the entity when both are under the cursor', () => {
    expect(resolveViewportAction(click({ entityHit: true, solidHit: true })))
      .toEqual({ kind: 'selectEntity' });
  });

  it('drags a rectangle on empty space', () => {
    expect(resolveViewportAction(click())).toEqual({ kind: 'windowSelect' });
  });

  describe('a step that gathers objects', () => {
    // Handing the command a click that picked nothing would do nothing at all;
    // dragging a rectangle is what the user meant.
    it('drags a rectangle when the click misses everything', () => {
      expect(resolveViewportAction(click({ commandActive: true, multiObjectStep: true })))
        .toEqual({ kind: 'windowSelect' });
    });

    it('still feeds the command when the click hits something', () => {
      expect(resolveViewportAction(click({ commandActive: true, multiObjectStep: true, entityHit: true })))
        .toEqual({ kind: 'commandClick' });
      expect(resolveViewportAction(click({ commandActive: true, multiObjectStep: true, solidHit: true })))
        .toEqual({ kind: 'commandClick' });
    });
  });

  describe('a view that cannot drag a rectangle', () => {
    const in3d = (overrides: Partial<ViewportPick> = {}) => click({ canWindowSelect: false, ...overrides });

    it('clears the selection on empty space instead', () => {
      expect(resolveViewportAction(in3d())).toEqual({ kind: 'clearSelection' });
    });

    it('gives an empty gathering click to the command rather than a rectangle', () => {
      expect(resolveViewportAction(in3d({ commandActive: true, multiObjectStep: true })))
        .toEqual({ kind: 'commandClick' });
    });

    it('behaves the same as any other view once something is under the cursor', () => {
      expect(resolveViewportAction(in3d({ entityHit: true }))).toEqual({ kind: 'selectEntity' });
      expect(resolveViewportAction(in3d({ gripIndex: 0, hasSelection: true }))).toEqual({ kind: 'dragGrip' });
    });
  });
});

describe('grabsGrip', () => {
  // The 3D view asks this before it raycasts, so it must agree with the full
  // decision — otherwise the two views would grab grips on different rules.
  it('agrees with resolveViewportAction on every combination', () => {
    for (const commandActive of [false, true]) {
      for (const gripIndex of [-1, 0, 3]) {
        for (const hasSelection of [false, true]) {
          for (const entityHit of [false, true]) {
            for (const canWindowSelect of [false, true]) {
              const pick = { commandActive, gripIndex, hasSelection, entityHit, solidHit: false, multiObjectStep: false, canWindowSelect };
              expect(grabsGrip(pick), JSON.stringify(pick)).toBe(resolveViewportAction(pick).kind === 'dragGrip');
            }
          }
        }
      }
    }
  });
});
