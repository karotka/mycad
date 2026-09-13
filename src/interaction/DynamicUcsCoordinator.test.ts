import { describe, expect, it } from 'vitest';
import { Document } from '../core/Document';
import { createDynamicUcsCoordinator, type DynamicUcsState } from './DynamicUcsCoordinator';
import { DynamicUcsController } from './DynamicUcsController';
import type { CommandManager } from '../core/commands/CommandManager';
import type { ActiveCommand } from '../core/commands/types';
import type { Viewport3D } from '../render/Viewport3D';
import { localToWorld, type WorkPlane } from '../math/workplane';

function setup(commandName: ActiveCommand['name']) {
  const doc = new Document();
  doc.viewMode = '3d';
  const controller = new DynamicUcsController(true);
  const active: ActiveCommand = { name: commandName, steps: [{ kind: 'point', label: 'Specify point:' }], stepIndex: 0, data: {} };
  const commands = { active } as unknown as CommandManager;
  const state: DynamicUcsState = { command: null };
  const coordinator = createDynamicUcsCoordinator({
    doc,
    commands,
    renderer3d: { setWorkPlane: () => undefined, clearFaceHighlight: () => undefined } as unknown as Viewport3D,
    controller,
    nearestMeasurementPoint: () => null,
    renderNamedUcs: () => undefined,
    log: () => undefined,
    redraw: () => undefined,
    state,
  });
  // Acquire a face plane the same way a real hover would, so isTemporary is true.
  const facePlane = {
    origin: { x: 5, y: 0, z: 0 },
    xAxis: { x: 1, y: 0, z: 0 }, yAxis: { x: 0, y: 0, z: 1 }, zAxis: { x: 0, y: -1, z: 0 },
  };
  coordinator.acquireDynamicUcs({ solidId: 's', vertexIndices: [0, 1, 2], region: { plane: facePlane, loops: [] }, hitPoint: facePlane.origin } as never, { clientX: 0, clientY: 0 });
  return { doc, coordinator, controller, active };
}

describe('DynamicUcsCoordinator: per-point re-acquisition for free-form curves', () => {
  it('locks Dynamic UCS after the first point for an ordinary command (LINE) — every remaining point stays on that one plane', () => {
    const { coordinator, controller, active } = setup('LINE');
    expect(controller.isTemporary).toBe(true);
    expect(controller.isLocked).toBe(false);

    const before = coordinator.beforeDynamicUcsAnswer();
    active.stepIndex = 1; // the first point landed
    coordinator.afterDynamicUcsAnswer(before);

    expect(controller.isLocked).toBe(true);
  });

  it('does NOT lock Dynamic UCS after a point for BEZIER — every control point may still adopt a new face', () => {
    const { coordinator, controller, active } = setup('BEZIER');
    const before = coordinator.beforeDynamicUcsAnswer();
    active.stepIndex = 1;
    coordinator.afterDynamicUcsAnswer(before);

    expect(controller.isLocked).toBe(false);
  });

  it('does NOT lock Dynamic UCS after a point for SPLINE either, for the same reason', () => {
    const { coordinator, controller, active } = setup('SPLINE');
    const before = coordinator.beforeDynamicUcsAnswer();
    active.stepIndex = 1;
    coordinator.afterDynamicUcsAnswer(before);

    expect(controller.isLocked).toBe(false);
  });

  it('a BEZIER still unlocked after one point can go on to adopt a genuinely different face for the next one', () => {
    const { doc, coordinator, controller, active } = setup('BEZIER');
    const before = coordinator.beforeDynamicUcsAnswer();
    active.stepIndex = 1;
    coordinator.afterDynamicUcsAnswer(before);
    expect(controller.isLocked).toBe(false);

    const otherFace = {
      origin: { x: 0, y: 5, z: 0 },
      xAxis: { x: 0, y: 1, z: 0 }, yAxis: { x: 0, y: 0, z: 1 }, zAxis: { x: 1, y: 0, z: 0 },
    };
    coordinator.acquireDynamicUcs(
      { solidId: 's', vertexIndices: [3, 4, 5], region: { plane: otherFace, loops: [] }, hitPoint: otherFace.origin } as never,
      { clientX: 10, clientY: 10 },
    );
    expect(doc.activeWorkPlane.origin).toEqual({ x: 0, y: 5, z: 0 });
  });
});

/**
 * The same harness, but without acquiring a face up front — these tests are
 * about what happens when the FIRST face arrives only after a point has
 * already been placed.
 */
function setupWithoutFace(active: ActiveCommand) {
  const doc = new Document();
  doc.viewMode = '3d';
  const controller = new DynamicUcsController(true);
  const commands = { active } as unknown as CommandManager;
  const state: DynamicUcsState = { command: null };
  const coordinator = createDynamicUcsCoordinator({
    doc,
    commands,
    renderer3d: { setWorkPlane: () => undefined, clearFaceHighlight: () => undefined } as unknown as Viewport3D,
    controller,
    nearestMeasurementPoint: () => null,
    renderNamedUcs: () => undefined,
    log: () => undefined,
    redraw: () => undefined,
    state,
  });
  const hover = (plane: WorkPlane, vertexIndices = [0, 1, 2]) => coordinator.acquireDynamicUcs(
    { solidId: 's', vertexIndices, region: { plane, loops: [] }, hitPoint: plane.origin } as never,
    { clientX: 0, clientY: 0 },
  );
  return { doc, controller, coordinator, hover };
}

describe('DynamicUcsCoordinator: adopting a face after the first point has landed', () => {
  // Measured on a real part (a wall mount, 135 x 13 x 23): LINE started at a
  // top corner of a vertical face. The corner is off the WCS, so the first
  // point froze a WCS-parallel plane through it; moving onto the face then
  // correctly acquired and highlighted it, and the second point landed 46 mm
  // away from the part, on the frozen horizontal plane.
  const face: WorkPlane = {
    origin: { x: 40, y: 10.75, z: 12 },
    xAxis: { x: 1, y: 0, z: 0 }, yAxis: { x: 0, y: 0, z: 1 }, zAxis: { x: 0, y: -1, z: 0 },
  };
  const frozen: WorkPlane = {
    origin: { x: 0, y: 0, z: 18 },
    xAxis: { x: 1, y: 0, z: 0 }, yAxis: { x: 0, y: 1, z: 0 }, zAxis: { x: 0, y: 0, z: 1 },
  };
  const lineFromCorner = (): ActiveCommand => ({
    name: 'LINE',
    steps: [{ kind: 'point', label: 'Specify first point:' }, { kind: 'point', label: 'Specify next point:' }],
    stepIndex: 1,
    // The corner (0, 10.75, 18), as LINE stored it in the frozen plane.
    data: { start: { x: 0, y: 10.75 }, drawingPlane: frozen },
  });

  it('keeps the point already drawn exactly where it is, and draws the rest on the face', () => {
    const active = lineFromCorner();
    const { doc, hover } = setupWithoutFace(active);

    hover(face);

    // The face was adopted, and pinned as the command's own plane so that
    // letting go of the face later cannot re-read the point a second time.
    expect(doc.activeWorkPlane.zAxis).toEqual({ x: 0, y: -1, z: 0 });
    expect((active.data.drawingPlane as WorkPlane).zAxis).toEqual({ x: 0, y: -1, z: 0 });
    // Same corner in space, different numbers: (0, 10.75) in the frozen plane
    // is (-40, 6) in the face's own frame.
    const start = active.data.start as { x: number; y: number };
    expect(localToWorld(active.data.drawingPlane as WorkPlane, start)).toEqual({
      x: expect.closeTo(0, 9), y: expect.closeTo(10.75, 9), z: expect.closeTo(18, 9),
    });
  });

  it('refuses a face the drawn point does not lie on, leaving the command in the plane it was started in', () => {
    const active = lineFromCorner();
    const { doc, controller, hover } = setupWithoutFace(active);
    const elsewhere: WorkPlane = { ...face, origin: { x: 40, y: 3, z: 12 } };

    hover(elsewhere);

    expect(controller.isTemporary).toBe(false);
    expect(doc.activeWorkPlane.zAxis).toEqual({ x: 0, y: 0, z: 1 });
    expect(active.data.drawingPlane).toBe(frozen);
    expect(active.data.start).toEqual({ x: 0, y: 10.75 });
  });

  it('still adopts a face freely before any point has been placed', () => {
    const active: ActiveCommand = {
      name: 'LINE', steps: [{ kind: 'point', label: 'Specify first point:' }], stepIndex: 0, data: {},
    };
    const { doc, hover } = setupWithoutFace(active);

    hover(face);

    expect(doc.activeWorkPlane.zAxis).toEqual({ x: 0, y: -1, z: 0 });
    // Nothing to move, so nothing is pinned — the command stays free to use
    // whatever plane is live, exactly as before.
    expect(active.data.drawingPlane).toBeUndefined();
  });
});
