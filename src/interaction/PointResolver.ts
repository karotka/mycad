import type { Vec2 } from '../math/geometry';
import { snapPoint2, worldToScreen } from '../math/geometry';
import type { WorkPlane } from '../math/workplane';
import { localToWorld, WORLD_WORK_PLANE, worldToLocal } from '../math/workplane';
import type { Document } from '../core/Document';
import type { Entity } from '../core/entities/types';
import type { CommandManager } from '../core/commands/CommandManager';
import { takesPointInput, transformsObjects } from '../core/commands/registry';
import { resolveDraftingPoint } from './DraftingService';
import {
  measurementCandidates,
  nearestCandidate2d,
  nearestCandidateProjected,
  objectSnapCandidates,
  type ObjectSnapMode,
  type SnapTarget,
} from './SnapService';
import type { Canvas2DRenderer } from '../render/Canvas2DRenderer';
import type { Viewport3D } from '../render/Viewport3D';
import type { GripController } from './GripController';
import type { GripInteractionController } from './GripInteractionController';
import type { DrawingInteractionController } from './DrawingInteractionController';

type GripSnapTarget = SnapTarget;

/**
 * The transient drafting state a resolved point produces and later reads back:
 * the alignment guide currently latched, and the endpoint whose alignment path
 * the cursor can track along. Shared with the pointer handlers, so it lives on a
 * mutable object both sides hold rather than inside this module.
 */
export interface PointResolverState {
  activeTracking: { base: Vec2; point: Vec2; angle: number } | null;
  activeEndpointAnchor: Vec2 | null;
}

export interface PointResolverContext {
  doc: Document;
  commands: CommandManager;
  gripController: GripController;
  gripInteraction: GripInteractionController;
  drawingInteraction: DrawingInteractionController;
  renderer2d: Canvas2DRenderer;
  renderer3d: Viewport3D;
  viewport: HTMLElement;
  trackingLine: HTMLElement;
  size(): { width: number; height: number };
  state: PointResolverState;
}

/**
 * Turns a raw pointer event into a placed CAD point: object snap, acquired
 * alignment paths, Ortho/Polar, and the UCS-plane projection in 3D. Extracted
 * verbatim from main.ts; the only change is that shared bindings arrive through
 * `ctx` and the two transient markers live on `ctx.state`.
 */
export function createPointResolver(ctx: PointResolverContext) {
  const { doc, commands, gripController, gripInteraction, drawingInteraction, renderer2d, renderer3d, viewport, trackingLine, state } = ctx;

  function worldPoint(event: Pick<PointerEvent, 'clientX' | 'clientY'>): Vec2 {
    const raw = rawWorldPoint(event);
    return doc.snapEnabled ? snapPoint2(raw, doc.snapSize) : raw;
  }

  function rawWorldPoint(event: Pick<PointerEvent, 'clientX' | 'clientY'>): Vec2 {
    const rect = viewport.getBoundingClientRect();
    const { width, height } = ctx.size();
    return renderer2d.screenToWorld(event.clientX - rect.left, event.clientY - rect.top, width, height);
  }

  function worldPoint3d(event: Pick<PointerEvent, 'clientX' | 'clientY'>): Vec2 | null {
    const raw = rawWorldPoint3d(event);
    if (!raw) return null;
    return doc.snapEnabled ? snapPoint2(raw, doc.snapSize) : raw;
  }

  function rawWorldPoint3d(event: Pick<PointerEvent, 'clientX' | 'clientY'>): Vec2 | null {
    return renderer3d.workPlanePoint(renderer3d.renderer.domElement, event.clientX, event.clientY);
  }

  function interactionPoint(event: Pick<PointerEvent, 'clientX' | 'clientY'>): Vec2 | null {
    state.activeTracking = null;
    const active = commands.active;
    const angularPlane = active?.name === 'DIMANGULAR'
      && active.stepIndex >= 5
      ? active.data.angularSource as { workPlane?: WorkPlane } | undefined
      : undefined;
    if (angularPlane?.workPlane) {
      const targetedSnap = drawingInteraction.targetSnapMode
        ? nearestGripTargetSnap(event, drawingInteraction.targetSnapMode)
        : nearestPersistentSnap(event);
      if (targetedSnap) {
        const local = worldToLocal(angularPlane.workPlane, targetedSnap.world);
        return { x: local.x, y: local.y };
      }
      if (doc.viewMode === '3d') {
        return renderer3d.workPlanePoint(
          renderer3d.renderer.domElement,
          event.clientX,
          event.clientY,
          angularPlane.workPlane,
        );
      }
      const world = localToWorld(doc.activeWorkPlane, worldPoint(event));
      const local = worldToLocal(angularPlane.workPlane, world);
      return { x: local.x, y: local.y };
    }
    let radialPlane = doc.viewMode === '3d'
      && (active?.name === 'DIMRADIUS' || active?.name === 'DIMDIAMETER')
      && active.stepIndex === 1
      ? active.data.radialSource as { workPlane?: WorkPlane } | undefined
      : undefined;
    const radialEntity = active?.data.entity as Entity | undefined;
    if (!radialPlane && (radialEntity?.type === 'circle' || radialEntity?.type === 'arc')) {
      radialPlane = { workPlane: radialEntity.workPlane ?? WORLD_WORK_PLANE };
    }
    if (radialPlane?.workPlane) {
      const targetedSnap = drawingInteraction.targetSnapMode
        ? nearestGripTargetSnap(event, drawingInteraction.targetSnapMode)
        : nearestPersistentSnap(event);
      if (targetedSnap) {
        const local = worldToLocal(radialPlane.workPlane, targetedSnap.world);
        return { x: local.x, y: local.y };
      }
      return renderer3d.workPlanePoint(
        renderer3d.renderer.domElement,
        event.clientX,
        event.clientY,
        radialPlane.workPlane,
      );
    }
    // Tools that place new geometry: they snap, but have no object to track.
    const drawing = active && takesPointInput(active.name) && !transformsObjects(active.name)
      && (active.steps[active.stepIndex]?.kind === 'point' || active.steps[active.stepIndex]?.kind === 'plane');
    if (drawing) {
      const targetedSnap = drawingInteraction.targetSnapMode
        ? nearestGripTargetSnap(event, drawingInteraction.targetSnapMode)
        : nearestPersistentSnap(event);
      if (targetedSnap) {
        // Resting on an endpoint acquires it, so moving off it can then track
        // along its alignment path rather than losing it.
        const acquired = endpointAnchorFromSnap(targetedSnap);
        if (acquired) state.activeEndpointAnchor = acquired;
        // Carry how far the snap sits off the active plane, not just its shadow on
        // it, so a line drawn in 3D lands on the point it snapped to even when that
        // point belongs to another UCS. The line keeps the active plane; only the
        // endpoint's z rides along.
        return { ...targetedSnap.point, z: worldToLocal(doc.activeWorkPlane, targetedSnap.world).z } as Vec2;
      }
    }
    // Defining a cutting plane by points must not depend on whether End happens
    // to be enabled in persistent OSNAP. A nearby 3D vertex is an explicit plane
    // point and therefore wins over the planar face underneath it.
    const sliceStep = active?.name === 'SLICE' ? active.steps[active.stepIndex] : undefined;
    if (sliceStep?.kind === 'plane' || sliceStep?.kind === 'point') {
      const vertex = nearestMeasurementPoint(event);
      if (vertex) {
        const local = worldToLocal(doc.activeWorkPlane, vertex);
        return { x: local.x, y: local.y, z: local.z } as Vec2;
      }
    }
    if (active && transformsObjects(active.name) && active.steps[active.stepIndex]?.kind === 'point') {
      const targetedSnap = drawingInteraction.targetSnapMode
        ? nearestGripTargetSnap(event, drawingInteraction.targetSnapMode)
        : nearestPersistentSnap(event);
      if (targetedSnap) {
        // A snapped base-and-target is a full 3D hop: the world point rides along
        // (via worldDeltaOf) so grabbing a corner and dropping it on another lands
        // x, y and z. Otherwise the move stays in the UCS plane.
        if (active.name === 'MOVE' || active.name === 'COPY' || active.name === 'SCALE') active.data.pendingMoveWorldPoint = targetedSnap.world;
        return targetedSnap.point;
      }
      if (active.name === 'MOVE' || active.name === 'COPY' || active.name === 'SCALE') delete active.data.pendingMoveWorldPoint;
    }
    if (doc.viewMode === '2d') return constrainedPoint(worldPoint(event));
    // In 3D a transform with no snap slides along the active UCS plane: the ray
    // meets that plane, so X and Y move and the height is kept. This is why moving
    // a solid used to drift across the screen instead of across its own floor.
    const point = worldPoint3d(event);
    return point ? constrainedPoint(point) : null;
  }

  function draftingBasePoint(): Vec2 | null {
    const active = commands.active;
    const step = active?.steps[active.stepIndex];
    if (!active || step?.kind !== 'point') return null;
    // A placement has no direction to constrain; see `ignoresDirection`.
    if (step.ignoresDirection) return null;
    const value = active.name === 'BEZIER'
      ? active.data.control2 ?? active.data.control1 ?? active.data.start
      : active.data.basePoint ?? active.data.start ?? active.data.center;
    return value && typeof value === 'object' && 'x' in value && 'y' in value ? value as Vec2 : null;
  }

  function constrainedPoint(point: Vec2, baseOverride: Vec2 | null = null): Vec2 {
    return resolvePoint(point, baseOverride ?? draftingBasePoint(), state.activeEndpointAnchor, null);
  }

  /**
   * The single place a cursor turns into a placed point: object snap, then an
   * acquired point's alignment path, then Ortho/Polar. Also publishes the guide
   * to draw, so what is shown and where the point lands cannot disagree.
   */
  function resolvePoint(cursor: Vec2, base: Vec2 | null, anchor: Vec2 | null, snap: Vec2 | null): Vec2 {
    const resolved = resolveDraftingPoint({
      cursor,
      base,
      anchor,
      snap,
      settings: doc.drafting,
      captureDistance: 8 / renderer2d.zoom,
    });
    state.activeTracking = resolved.guide
      ? { base: resolved.guide.start, point: resolved.guide.end, angle: resolved.guide.angle }
      : null;
    return resolved.point;
  }

  function samePoint3d(a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }, epsilon = 1e-9): boolean {
    return Math.abs(a.x - b.x) <= epsilon && Math.abs(a.y - b.y) <= epsilon && Math.abs(a.z - b.z) <= epsilon;
  }

  /**
   * Hovering an endpoint acquires it, so its alignment path can catch the cursor
   * later (F11). Works while drawing as well as while dragging a grip — the
   * object being dragged is excluded so it cannot track against itself.
   */
  function endpointAnchorFromSnap(snap: GripSnapTarget | null): Vec2 | null {
    if (!snap) return null;
    const excluded = gripController.isDragging ? gripController.draggingObjectId : undefined;
    const candidates = objectSnapCandidates(doc, 'end', excluded);
    return candidates.some((candidate) => samePoint3d(candidate.world, snap.world)) ? snap.point : null;
  }

  function updateTrackingGuide(): void {
    if (!state.activeTracking) {
      trackingLine.hidden = true;
      return;
    }
    const { width, height } = ctx.size();
    let start: Vec2 | null;
    let end: Vec2 | null;
    if (doc.viewMode === '2d') {
      start = worldToScreen(state.activeTracking.base, width, height, renderer2d.pan, renderer2d.zoom);
      end = worldToScreen(state.activeTracking.point, width, height, renderer2d.pan, renderer2d.zoom);
    } else {
      start = renderer3d.projectCadPoint(renderer3d.renderer.domElement, localToWorld(doc.activeWorkPlane, state.activeTracking.base));
      end = renderer3d.projectCadPoint(renderer3d.renderer.domElement, localToWorld(doc.activeWorkPlane, state.activeTracking.point));
    }
    if (!start || !end) { trackingLine.hidden = true; return; }
    const dx = end.x - start.x, dy = end.y - start.y;
    trackingLine.style.left = `${start.x}px`;
    trackingLine.style.top = `${start.y}px`;
    trackingLine.style.width = `${Math.hypot(dx, dy)}px`;
    trackingLine.style.transform = `rotate(${Math.atan2(dy, dx)}rad)`;
    trackingLine.hidden = false;
  }

  function nearestMeasurementPoint(event: Pick<PointerEvent, 'clientX' | 'clientY'>, pixelTolerance = 14): { x: number; y: number; z: number } | null {
    const candidates = measurementCandidates(doc).map((world) => ({ world }));
    if (doc.viewMode === '3d') {
      const rect = viewport.getBoundingClientRect();
      return nearestCandidateProjected(
        candidates,
        { x: event.clientX - rect.left, y: event.clientY - rect.top },
        (point) => renderer3d.projectCadPoint(renderer3d.renderer.domElement, point),
        pixelTolerance,
        doc.activeWorkPlane,
      )?.world ?? null;
    }
    const cursor = rawWorldPoint(event);
    return nearestCandidate2d(candidates, cursor, doc.activeWorkPlane, pixelTolerance / renderer2d.zoom)?.world ?? null;
  }

  function nearestGripTargetSnap(
    event: Pick<PointerEvent, 'clientX' | 'clientY'>,
    mode: ObjectSnapMode | null = gripInteraction.targetSnapMode,
    pixelTolerance = 14,
  ): GripSnapTarget | null {
    if (!mode) return null;
    const active = commands.active;
    const referenceValue = active?.data.start ?? active?.data.basePoint ?? active?.data.center;
    const reference = referenceValue && typeof referenceValue === 'object' && 'x' in referenceValue && 'y' in referenceValue
      ? localToWorld(doc.activeWorkPlane, referenceValue as Vec2)
      : null;
    const candidates = objectSnapCandidates(doc, mode, gripController.draggingObjectId, reference);
    if (doc.viewMode === '3d') {
      const rect = viewport.getBoundingClientRect();
      return nearestCandidateProjected(
        candidates,
        { x: event.clientX - rect.left, y: event.clientY - rect.top },
        (point) => renderer3d.projectCadPoint(renderer3d.renderer.domElement, point),
        pixelTolerance,
        doc.activeWorkPlane,
      );
    }
    return nearestCandidate2d(
      candidates,
      rawWorldPoint(event),
      doc.activeWorkPlane,
      pixelTolerance / renderer2d.zoom,
    );
  }

  function nearestPersistentSnap(
    event: Pick<PointerEvent, 'clientX' | 'clientY'>,
    pixelTolerance = 14,
  ): GripSnapTarget | null {
    if (!doc.drafting.objectSnapEnabled || doc.drafting.objectSnapModes.length === 0) return null;
    const active = commands.active;
    const referenceValue = active?.data.start ?? active?.data.basePoint ?? active?.data.center;
    const reference = referenceValue && typeof referenceValue === 'object' && 'x' in referenceValue && 'y' in referenceValue
      ? localToWorld(doc.activeWorkPlane, referenceValue as Vec2)
      : null;
    const candidates = doc.drafting.objectSnapModes.flatMap((mode) =>
      objectSnapCandidates(doc, mode, gripController.draggingObjectId, reference));
    if (doc.viewMode === '3d') {
      const rect = viewport.getBoundingClientRect();
      return nearestCandidateProjected(
        candidates,
        { x: event.clientX - rect.left, y: event.clientY - rect.top },
        (point) => renderer3d.projectCadPoint(renderer3d.renderer.domElement, point),
        pixelTolerance,
        doc.activeWorkPlane,
      );
    }
    return nearestCandidate2d(candidates, rawWorldPoint(event), doc.activeWorkPlane, pixelTolerance / renderer2d.zoom);
  }

  return {
    worldPoint,
    rawWorldPoint,
    worldPoint3d,
    rawWorldPoint3d,
    interactionPoint,
    draftingBasePoint,
    constrainedPoint,
    resolvePoint,
    endpointAnchorFromSnap,
    updateTrackingGuide,
    nearestMeasurementPoint,
    nearestGripTargetSnap,
    nearestPersistentSnap,
  };
}
