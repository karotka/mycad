import type { Vec2, Vec3 } from '../math/geometry';
import type { WorkPlane } from '../math/workplane';
import { cloneWorkPlane, localToWorld, WORLD_WORK_PLANE, worldToLocal } from '../math/workplane';
import type { Document } from '../core/Document';
import type { CommandManager, CommandName } from '../core/commands/CommandManager';
import type { CommandHistory, DocumentEdit } from '../core/history/CommandHistory';
import { CompositeEdit, UpdateEntityEdit, UpdateSolidEdit, cloneSolid } from '../core/history/edits';
import { cloneEntity, entityBounds, transformEntityPoints, type Entity, type SolidFaceSelection, type SolidMesh } from '../core/entities/types';
import { translatedFeature } from '../core/solids/featureTransform';
import { preserveExactTransform, translationAffine } from '../core/geometry/ExactTransform';
import { boxLikePrimitiveFeature, radialLikePrimitiveFeature, torusPrimitiveFeature } from '../core/commands/steps/solids';
import { extrusionFeature } from '../core/solids/extrusion';
import { buildExactFeature } from '../core/geometry/ExactSolid';
import { primitivePreviewMesh } from '../core/geometry/PrimitiveMesh';
import { axisOffsetUnderRay } from './AxisDrag';
import type { Viewport3D } from '../render/Viewport3D';
import type { PreviewController } from '../ui/PreviewController';

/** The primitives whose final step is dragged live in 3D (height, or TORUS tube radius). */
export const FINAL_DRAG_PRIMITIVES = new Set<CommandName>([
  'BOX', 'WEDGE', 'CYLINDER', 'CONE', 'PYRAMID', 'TORUS',
]);

export interface PrimitiveFinalDrag {
  value: number;
  mesh: SolidMesh;
  snap: { x: number; y: number; z: number } | null;
  label: string;
}

/**
 * A drag measured in the active UCS plane, turned into a world vector. Only X
 * and Y move; the UCS height is untouched — dragging a solid across the floor of
 * its coordinate system rather than across the screen, which is what "move it,
 * keep the same height" means. A snapped point-to-point hop overrides this with
 * its own full-3D delta.
 */
export function ucsPlaneWorldDelta(plane: WorkPlane, local: Vec2): Vec3 {
  return {
    x: plane.xAxis.x * local.x + plane.yAxis.x * local.y,
    y: plane.xAxis.y * local.x + plane.yAxis.y * local.y,
    z: plane.xAxis.z * local.x + plane.yAxis.z * local.y,
  };
}

export interface MoveEditingContext {
  doc: Document;
  history: CommandHistory;
}

/**
 * Committing moves to history. Extracted from main.ts verbatim; wired early
 * because `moveObjects` is read when the CommandManager is constructed.
 */
export function createMoveEditing(ctx: MoveEditingContext) {
  const { doc, history } = ctx;

  /** The edit that moves one object, without running it — so many can share a step. */
  function moveObjectEdit(
    object: Entity | string,
    delta: { x: number; y: number; z: number },
    snapped: boolean,
  ): DocumentEdit | null {
    if (typeof object !== 'string') {
      const before = cloneEntity(object);
      let after: Entity;
      if (doc.viewMode === '3d') {
        after = cloneEntity(object);
        const plane = cloneWorkPlane(after.workPlane ?? WORLD_WORK_PLANE);
        plane.origin.x += delta.x;
        plane.origin.y += delta.y;
        plane.origin.z += delta.z;
        after.workPlane = plane;
      } else if (snapped) {
        const plane = object.workPlane ?? WORLD_WORK_PLANE;
        const localDelta = {
          x: delta.x * plane.xAxis.x + delta.y * plane.xAxis.y + delta.z * plane.xAxis.z,
          y: delta.x * plane.yAxis.x + delta.y * plane.yAxis.y + delta.z * plane.yAxis.z,
        };
        after = transformEntityPoints(object, (point) => ({ x: point.x + localDelta.x, y: point.y + localDelta.y }));
      } else {
        after = transformEntityPoints(object, (point) => ({ x: point.x + delta.x, y: point.y + delta.y }));
      }
      return new UpdateEntityEdit('Move object', before, after);
    }
    const solid = doc.getSolid(object);
    if (!solid) return null;
    const before = cloneSolid(solid);
    const after = cloneSolid(solid);
    for (let i = 0; i < after.mesh.positions.length; i += 3) {
      after.mesh.positions[i] += delta.x;
      after.mesh.positions[i + 1] += delta.y;
      after.mesh.positions[i + 2] += delta.z;
    }
    after.feature = translatedFeature(after.feature, delta) ?? { kind: 'mesh' };
    preserveExactTransform(after, translationAffine(delta));
    after.revision++;
    return new UpdateSolidEdit('Move solid', before, after);
  }

  /**
   * Moves any number of objects as one step in the history: dragging three things
   * is one thing the user did, so one Undo has to put all three back.
   */
  function moveObjects(
    objects: ReadonlyArray<Entity | string>,
    screenDelta: Vec2,
    snappedWorldDelta?: { x: number; y: number; z: number },
  ): void {
    const delta = snappedWorldDelta ?? (doc.viewMode === '2d'
      ? { x: screenDelta.x, y: screenDelta.y, z: 0 }
      : ucsPlaneWorldDelta(doc.activeWorkPlane, screenDelta));
    const edits = objects
      .map((object) => moveObjectEdit(object, delta, Boolean(snappedWorldDelta)))
      .filter((edit): edit is DocumentEdit => edit !== null);
    if (edits.length === 0) return;
    history.execute(edits.length === 1 ? edits[0] : new CompositeEdit('Move objects', edits));
  }

  return { moveObjectEdit, moveObjects };
}

export interface SolidDragPreviewContext {
  doc: Document;
  commands: CommandManager;
  renderer3d: Viewport3D;
  previewController: PreviewController;
  nearestMeasurementPoint: (event: Pick<PointerEvent, 'clientX' | 'clientY'>, pixelTolerance?: number) => { x: number; y: number; z: number } | null;
  redraw: () => void;
}

/**
 * The live 3D drag geometry for PRESSPULL, EXTRUDE, and the final step of a
 * height-based primitive: what the solid would be as the cursor steers it, so
 * the shape is what you aim by rather than a number typed at a still picture.
 * Extracted from main.ts verbatim; depends on the point resolver's snap.
 */
export function createSolidDragPreview(ctx: SolidDragPreviewContext) {
  const { doc, commands, renderer3d, previewController, nearestMeasurementPoint, redraw } = ctx;

  /**
   * PRESSPULL waiting for its distance, with the cursor dragging the face it was
   * given. Builds the solid as it would be, so the shape is what you steer by
   * rather than a number typed at a stationary picture — and returns the distance
   * so the click that ends it commits exactly what was on screen.
   */
  function pressPullDrag(event: PointerEvent): { delta: number } | null {
    const active = commands.active;
    if (doc.viewMode !== '3d' || active?.name !== 'PRESSPULL' || active.stepIndex !== 1) return null;
    const face = active.data.face as SolidFaceSelection | undefined;
    const solid = doc.getSolid(active.data.solidId as string);
    if (!face?.region || !solid) return null;
    // A vertex under the cursor snaps the pull to exactly its depth along the
    // face normal, so a face can be pushed to existing geometry rather than to a
    // number that is nearly it — the same object snap EXTRUDE already honours. A
    // vertex on the face itself reads as zero depth and is ignored below.
    const snap = nearestMeasurementPoint(event);
    const delta = snap
      ? worldToLocal(face.region.plane, snap).z
      : renderer3d.faceDragDelta(renderer3d.renderer.domElement, solid, face, event.clientX, event.clientY);
    if (delta === null || Math.abs(delta) < 1e-6) return null;
    previewController.setPreview({ type: 'presspull-region', data: { region: face.region, distance: delta } });
    return { delta };
  }

  /** Which way the profile is being pulled, and how far. Null when it is neither. */
  function extrudeHeightUnderCursor(event: PointerEvent): { height: number; profile: Entity } | null {
    const active = commands.active;
    if (doc.viewMode !== '3d' || active?.name !== 'EXTRUDE' || active.stepIndex !== 1) return null;
    const profile = (active.data.entities as Entity[] | undefined)?.[0];
    if (!profile) return null;
    const plane = profile.workPlane ?? WORLD_WORK_PLANE;

    // A vertex under the cursor wins, so an extrusion can be pulled to exactly
    // the height of something already drawn rather than to a number that is
    // nearly it.
    const snap = nearestMeasurementPoint(event);
    if (snap) {
      const height = worldToLocal(plane, snap).z;
      return Math.abs(height) > 1e-6 ? { height, profile } : null;
    }
    // Otherwise the profile only travels along its plane's normal, so the height
    // is the point on that axis the pointer ray passes closest to — the same
    // question press-pull asks of a face.
    const bounds = entityBounds(profile);
    const centre = localToWorld(plane, { x: (bounds.min.x + bounds.max.x) / 2, y: (bounds.min.y + bounds.max.y) / 2 }, 0);
    const ray = renderer3d.pointerRay(renderer3d.renderer.domElement, event.clientX, event.clientY);
    const height = axisOffsetUnderRay(centre, plane.zAxis, ray.origin, ray.direction);
    return height !== null && Math.abs(height) > 1e-6 ? { height, profile } : null;
  }

  /**
   * Final size of a primitive after its base has been placed. A nearby vertex
   * wins; elsewhere the cursor ray is measured along the current UCS Z axis.
   * For every height-based primitive this is its height; for TORUS it is the
   * tube radius, giving its third input the same live 3D workflow.
   */
  function primitiveFinalUnderCursor(event: PointerEvent): PrimitiveFinalDrag | null {
    const active = commands.active;
    if (doc.viewMode !== '3d'
      || !active
      || !FINAL_DRAG_PRIMITIVES.has(active.name)
      || active.stepIndex !== 2) return null;

    const plane = doc.activeWorkPlane;
    const snap = nearestMeasurementPoint(event);
    let baseCenter: Vec2;
    if (active.name === 'BOX' || active.name === 'WEDGE') {
      const start = active.data.start as Vec2 | undefined;
      const end = active.data.end as Vec2 | undefined;
      if (!start || !end) return null;
      baseCenter = { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 };
    } else {
      const center = active.data.center as Vec2 | undefined;
      if (!center || !active.data.radiusPoint) return null;
      baseCenter = center;
    }
    const centre = localToWorld(plane, baseCenter);
    let value: number | null;
    if (snap) {
      value = worldToLocal(plane, snap).z;
    } else {
      const ray = renderer3d.pointerRay(renderer3d.renderer.domElement, event.clientX, event.clientY);
      value = axisOffsetUnderRay(centre, plane.zAxis, ray.origin, ray.direction);
    }
    if (value === null || Math.abs(value) < 1e-6) return null;

    const feature = active.name === 'BOX' || active.name === 'WEDGE'
      ? boxLikePrimitiveFeature(
        active.name === 'BOX' ? 'box' : 'wedge',
        active.data.start as Vec2,
        active.data.end as Vec2,
        value,
        plane,
      )
      : active.name === 'TORUS'
        ? torusPrimitiveFeature(
          active.data.center as Vec2,
          active.data.radiusPoint as Vec2,
          value,
          plane,
        )
        : radialLikePrimitiveFeature(
          active.name === 'CYLINDER' ? 'cylinder' : active.name === 'CONE' ? 'cone' : 'pyramid',
          active.data.center as Vec2,
          active.data.radiusPoint as Vec2,
          value,
          plane,
        );
    if (!feature) return null;
    const finalValue = active.name === 'TORUS' ? feature.tubeRadius! : feature.height;
    const name = active.name[0] + active.name.slice(1).toLowerCase();
    return {
      value: finalValue,
      mesh: primitivePreviewMesh(feature),
      snap,
      label: `${name} ${active.name === 'TORUS' ? 'tube radius' : 'height'}`,
    };
  }

  function updatePrimitiveFinalPreview(event: PointerEvent, sx: number, sy: number): PrimitiveFinalDrag | null {
    const drag = primitiveFinalUnderCursor(event);
    if (!drag) return null;
    previewController.setPreview({ type: 'solid', data: { solidId: '', mesh: drag.mesh } });
    previewController.showDimension(`${drag.label} ${drag.value.toFixed(2)} mm`, sx, sy);
    return drag;
  }

  /** Guards against a slow frame's preview landing on top of a newer one. */
  let extrudePreviewToken = 0;

  function updateExtrudePreview(event: PointerEvent, sx: number, sy: number): void {
    const drag = extrudeHeightUnderCursor(event);
    if (!drag) return;
    previewController.showDimension(`Extrude ${drag.height.toFixed(2)} mm`, sx, sy);
    const token = ++extrudePreviewToken;
    // Built by the engine that will build the real one, so the preview cannot
    // promise a shape the command then declines to make. The await settles in a
    // microtask, before anything is painted, so this does not flicker.
    void buildExactFeature(extrusionFeature(drag.profile, drag.height)).then((geometry) => {
      if (!geometry || token !== extrudePreviewToken) return;
      previewController.setPreview({ type: 'solid', data: { solidId: '', mesh: geometry.mesh } });
      redraw();
    });
  }

  return {
    pressPullDrag,
    extrudeHeightUnderCursor,
    primitiveFinalUnderCursor,
    updatePrimitiveFinalPreview,
    updateExtrudePreview,
  };
}
