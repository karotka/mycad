import type { WorkPlane } from '../math/workplane';
import { cloneWorkPlane, WORLD_WORK_PLANE, worldToLocal } from '../math/workplane';
import type { Document } from '../core/Document';
import type { ActiveCommand, CommandManager, CommandName } from '../core/commands/CommandManager';
import type { SolidFaceSelection } from '../core/entities/types';
import type { Viewport3D } from '../render/Viewport3D';
import { type DynamicUcsController, preferredDynamicFacePlane } from './DynamicUcsController';

/**
 * The commands whose first point may be picked on a solid face, so hovering one
 * temporarily adopts that face's plane as the UCS (Dynamic UCS).
 */
const DYNAMIC_UCS_COMMANDS = new Set<CommandName>([
  'LINE', 'POLYLINE', 'RECTANGLE', 'CIRCLE', 'CIRCLE_DIAMETER', 'OCTAGON',
  'ELLIPSE', 'POLYGON', 'ARC', 'BEZIER', 'TEXT',
  'BOX', 'WEDGE', 'SPHERE', 'CONE', 'CYLINDER', 'PYRAMID', 'TORUS',
  // A linear dimension belongs to a plane. DUCS lets the first picked face
  // supply that plane, then the ordinary first-point lock keeps every
  // remaining dimension step in it. DIMALIGNED builds its own spatial plane.
  'MEASURE', 'DIMANGULAR',
]);

interface DynamicUcsAnswer {
  command: ActiveCommand;
  data: Record<string, unknown>;
  stepIndex: number;
  stepKind: string;
}

/** The command that acquired the live face plane; shared with the pointer handlers. */
export interface DynamicUcsState {
  command: ActiveCommand | null;
}

export interface DynamicUcsCoordinatorContext {
  doc: Document;
  commands: CommandManager;
  renderer3d: Viewport3D;
  controller: DynamicUcsController;
  nearestMeasurementPoint: (event: Pick<PointerEvent, 'clientX' | 'clientY'>, pixelTolerance?: number) => { x: number; y: number; z: number } | null;
  renderNamedUcs: () => void;
  log: (message: string) => void;
  redraw: () => void;
  state: DynamicUcsState;
}

/**
 * Dynamic UCS: temporarily adopting the plane of the solid face under the cursor
 * while a drawing command's first point is being picked, then locking it once a
 * point lands or restoring the previous UCS when the command ends. Extracted
 * from main.ts verbatim; shared bindings arrive through `ctx`, and the command
 * that owns the live plane lives on `ctx.state`.
 */
export function createDynamicUcsCoordinator(ctx: DynamicUcsCoordinatorContext) {
  const { doc, commands, renderer3d, controller, nearestMeasurementPoint, renderNamedUcs, log, redraw, state } = ctx;

  function useWorkPlaneWithoutDocumentEvent(plane: WorkPlane): void {
    doc.activeWorkPlane = cloneWorkPlane(plane);
    renderer3d.setWorkPlane(doc.activeWorkPlane);
  }

  /** Restores the named/manual UCS that was active before a face was acquired. */
  function releaseDynamicUcs(restored = controller.release()): boolean {
    state.command = null;
    if (!restored) return false;
    useWorkPlaneWithoutDocumentEvent(restored);
    renderer3d.clearFaceHighlight();
    renderNamedUcs();
    return true;
  }

  function syncDynamicUcsLifecycle(): void {
    if (!controller.isTemporary) return;
    if (doc.viewMode !== '3d'
      || commands.active !== state.command
      || !commands.active
      || !DYNAMIC_UCS_COMMANDS.has(commands.active.name)) {
      releaseDynamicUcs();
    }
  }

  function canAcquireDynamicUcs(): boolean {
    const active = commands.active;
    return Boolean(
      controller.enabled
      && !controller.isLocked
      && doc.viewMode === '3d'
      && active
      && DYNAMIC_UCS_COMMANDS.has(active.name)
      && active.steps[active.stepIndex]?.kind === 'point'
    );
  }

  /** A boundary snap still belongs to the face whose interior acquired DUCS. */
  function snapKeepsDynamicUcs(event: Pick<PointerEvent, 'clientX' | 'clientY'>): boolean {
    if (!controller.isTemporary) return false;
    const snap = nearestMeasurementPoint(event);
    return Boolean(snap && controller.containsPoint(snap));
  }

  function acquireDynamicUcs(face: SolidFaceSelection, event: Pick<PointerEvent, 'clientX' | 'clientY'>): void {
    if (!face.region) return;
    const facePlane = preferredDynamicFacePlane(face.region);
    const snap = nearestMeasurementPoint(event);
    const snapOnFacePlane = snap && Math.abs(worldToLocal(facePlane, snap).z) < 1e-5 ? snap : null;
    const origin = snapOnFacePlane ?? face.hitPoint ?? face.region.plane.origin;
    const key = `${face.solidId}:${[...face.vertexIndices].sort((a, b) => a - b).join(',')}`;
    const temporary = controller.acquire(doc.activeWorkPlane, facePlane, origin, key);
    if (!temporary) return;
    state.command = commands.active;
    useWorkPlaneWithoutDocumentEvent(temporary);
    renderNamedUcs();
  }

  function beforeDynamicUcsAnswer(): DynamicUcsAnswer | null {
    const active = commands.active;
    if (!controller.isTemporary || !active || active !== state.command) return null;
    return {
      command: active,
      data: active.data,
      stepIndex: active.stepIndex,
      stepKind: active.steps[active.stepIndex]?.kind ?? '',
    };
  }

  /** Locks after the first point, or restores after the object/command finishes. */
  function afterDynamicUcsAnswer(before: DynamicUcsAnswer | null): void {
    if (!before || !controller.isTemporary) return;
    const active = commands.active;
    if (active !== before.command || active.data !== before.data) {
      releaseDynamicUcs();
      return;
    }
    if (before.stepKind === 'point' && active.stepIndex !== before.stepIndex) controller.lock();
  }

  function toggleDynamicUcs(): void {
    const restored = controller.toggle();
    if (restored) releaseDynamicUcs(restored);
    localStorage.setItem('mycad.dynamicUcs', controller.enabled ? 'on' : 'off');
    log(`Dynamic UCS: ${controller.enabled ? 'ON' : 'OFF'}`);
    if (!controller.enabled) renderer3d.clearFaceHighlight();
    redraw();
  }

  /** Promotes the live face plane to the same named-UCS list as manual UCS. */
  function saveDynamicUcs(): void {
    if (!controller.isTemporary) return;
    const plane = cloneWorkPlane(doc.activeWorkPlane);
    controller.release();
    state.command = null;
    const named = doc.addNamedWorkPlane(plane);
    renderer3d.setWorkPlane(doc.activeWorkPlane);
    log(`${named.name} saved from Dynamic UCS.`);
    redraw();
  }

  /** Whether the temporary plane belongs to the command now running. */
  function ownsActiveCommand(): boolean {
    return controller.isTemporary && state.command === commands.active;
  }

  return {
    releaseDynamicUcs,
    syncDynamicUcsLifecycle,
    canAcquireDynamicUcs,
    snapKeepsDynamicUcs,
    acquireDynamicUcs,
    beforeDynamicUcsAnswer,
    afterDynamicUcsAnswer,
    toggleDynamicUcs,
    saveDynamicUcs,
    ownsActiveCommand,
  };
}
