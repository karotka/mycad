import { describe, expect, it } from 'vitest';
import { Document } from '../core/Document';
import { CommandHistory } from '../core/history/CommandHistory';
import { createMoveEditing, createSolidDragPreview } from './DragEditing';

describe('solid move editing', () => {
  it('moves a mesh-only exact piece without making its B-rep stale', () => {
    const doc = new Document();
    const history = new CommandHistory(doc);
    const solid = doc.createSolid({
      positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
      indices: new Uint32Array([0, 1, 2]),
    }, 'Exact slice', 1, [], undefined, { kind: 'mesh' });
    solid.exact = {
      kernel: 'opencascade', revision: solid.revision,
      shape: { format: 'occt-brep-v1', data: 'fixture' },
    };
    doc.addSolid(solid);
    const editing = createMoveEditing({ doc, history });

    editing.moveObjects([solid.id], { x: 3, y: 4 });

    expect(doc.solids[0].mesh.positions.slice(0, 3)).toEqual(new Float32Array([3, 4, 0]));
    expect(doc.solids[0].exact).toMatchObject({
      revision: doc.solids[0].revision,
      transform: [1, 0, 0, 3, 0, 1, 0, 4, 0, 0, 1, 0],
    });
    history.undo();
    expect(doc.solids[0].mesh.positions.slice(0, 3)).toEqual(new Float32Array([0, 0, 0]));
    expect(doc.solids[0].exact?.transform).toBeUndefined();
  });
});

describe('revolveAngleUnderCursor', () => {
  /** A REVOLVE waiting for its angle, with a profile 10 from the Z axis. */
  function setup(rayDirection: { x: number; y: number; z: number }, rayOrigin = { x: 0, y: 0, z: 100 }) {
    const doc = new Document();
    doc.viewMode = '3d';
    const profile = doc.createRectangle({ x: 9, y: -1 }, { x: 11, y: 1 });
    doc.addEntity(profile);
    const commands = {
      active: {
        name: 'REVOLVE',
        stepIndex: 3,
        data: { profile, axisStart: { x: 0, y: 0, z: 0 }, axisEnd: { x: 0, y: 0, z: 1 } },
      },
    } as unknown as Parameters<typeof createSolidDragPreview>[0]['commands'];
    const preview = createSolidDragPreview({
      doc,
      commands,
      renderer3d: {
        renderer: { domElement: {} as HTMLCanvasElement },
        pointerRay: () => ({ origin: rayOrigin, direction: rayDirection }),
      } as unknown as Parameters<typeof createSolidDragPreview>[0]['renderer3d'],
      previewController: { showDimension: () => undefined, setPreview: () => undefined, clearPreview: () => undefined } as never,
      nearestMeasurementPoint: () => null,
      redraw: () => undefined,
    });
    return preview;
  }

  /** A ray straight down onto the plane of the profile, aimed at (x, y). */
  const downAt = (x: number, y: number) => ({ rayOrigin: { x, y, z: 100 }, rayDirection: { x: 0, y: 0, z: -1 } });

  it('reads a quarter turn when the cursor is a quarter of the way round', () => {
    // The profile stands along +X, so +Y is 90 degrees round.
    const { rayOrigin, rayDirection } = downAt(0, 10);
    const drag = setup(rayDirection, rayOrigin).revolveAngleUnderCursor({ clientX: 0, clientY: 0 } as PointerEvent);
    expect(drag?.degrees).toBeCloseTo(90, 6);
  });

  it('reads most of the way round rather than a negative, just behind the profile', () => {
    // A sweep runs one way from where the profile is: a hair clockwise of it
    // is nearly a whole turn, not minus nothing.
    const { rayOrigin, rayDirection } = downAt(10, -0.1);
    const drag = setup(rayDirection, rayOrigin).revolveAngleUnderCursor({ clientX: 0, clientY: 0 } as PointerEvent);
    expect(drag!.degrees).toBeGreaterThan(359);
  });

  it('builds the angle into a revolve feature the command would build too', () => {
    const { rayOrigin, rayDirection } = downAt(-10, 0);
    const drag = setup(rayDirection, rayOrigin).revolveAngleUnderCursor({ clientX: 0, clientY: 0 } as PointerEvent);
    expect(drag?.degrees).toBeCloseTo(180, 6);
    expect(drag?.feature).toMatchObject({ kind: 'revolve', angle: expect.closeTo(Math.PI, 6) });
  });

  it('says nothing when the view looks along the plane the profile turns in', () => {
    // A ray square to the axis never meets that plane.
    const drag = setup({ x: 1, y: 0, z: 0 }, { x: -100, y: 0, z: 0 })
      .revolveAngleUnderCursor({ clientX: 0, clientY: 0 } as PointerEvent);
    expect(drag).toBeNull();
  });

  it('says nothing while the cursor is on the axis itself, where there is no angle', () => {
    const { rayOrigin, rayDirection } = downAt(0, 0);
    expect(setup(rayDirection, rayOrigin).revolveAngleUnderCursor({ clientX: 0, clientY: 0 } as PointerEvent)).toBeNull();
  });
});
