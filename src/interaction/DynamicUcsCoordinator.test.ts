import { describe, expect, it } from 'vitest';
import { Document } from '../core/Document';
import { createDynamicUcsCoordinator, type DynamicUcsState } from './DynamicUcsCoordinator';
import { DynamicUcsController } from './DynamicUcsController';
import type { CommandManager } from '../core/commands/CommandManager';
import type { ActiveCommand } from '../core/commands/types';
import type { Viewport3D } from '../render/Viewport3D';

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
