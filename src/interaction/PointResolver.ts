import type { Vec2, Vec3 } from '../math/geometry';
import { snapPoint2, worldToScreen } from '../math/geometry';
import type { WorkPlane } from '../math/workplane';
import { cloneWorkPlane, localToWorld, WORLD_WORK_PLANE, worldToLocal } from '../math/workplane';
import type { Document } from '../core/Document';
import type { Entity } from '../core/entities/types';
import type { CommandManager } from '../core/commands/CommandManager';
import { takesPointInput, transformsObjects } from '../core/commands/registry';
import { resolveDraftingPoint } from './DraftingService';
import { DYNAMIC_UCS_PER_POINT_COMMANDS } from './DynamicUcsCoordinator';
import {
  derivedRectangleCenterCandidates,
  measurementCandidates,
  nearestCandidate2d,
  nearestCandidateProjected,
  nearestEdgeLocalPoint,
  nearestEdgeWorldPoint,
  objectSnapCandidates,
  rectangleMidpointOwner,
  rectangleSymmetryGuides,
  tangentDragCandidates,
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
  centerGuideA: HTMLElement;
  centerGuideB: HTMLElement;
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
  const { doc, commands, gripController, gripInteraction, drawingInteraction, renderer2d, renderer3d, viewport, trackingLine, centerGuideA, centerGuideB, state } = ctx;

  // Rectangles a Middle-snap hover has, this session, caught on two of their
  // own different edges — once that happens, the rectangle's true centre
  // (not itself a drawn point) becomes an ordinary snap candidate too, so
  // aiming toward it catches it without a diagonal construction line and
  // without needing Center object-snap separately enabled. Session-lived by
  // design: once earned for a given rectangle, re-priming it every time
  // would defeat the point ("no need to keep re-finding it by hand").
  const primedRectangleCenters = new Set<string>();
  let lastMidpointHover: { entityId: string; edgeIndex: number } | null = null;
  function notePotentialRectangleMidpoint(target: GripSnapTarget | null): void {
    if (target?.mode !== 'middle') return;
    const owner = rectangleMidpointOwner(doc, target.world, gripController.draggingObjectId);
    if (!owner) return;
    if (lastMidpointHover && lastMidpointHover.entityId === owner.entityId && lastMidpointHover.edgeIndex !== owner.edgeIndex) {
      primedRectangleCenters.add(owner.entityId);
    }
    lastMidpointHover = owner;
  }

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

  /**
   * `commit` distinguishes a real click (the point is actually about to be
   * used) from a hover preview (called on every pointermove, just to show
   * where a click would land) — established here since this single function
   * serves both. Only a real click may latch a new `drawingPlane` onto the
   * active command: merely grazing an off-plane snap while the cursor is on
   * its way somewhere else must not silently commit the rest of the command
   * to a plane the user never actually clicked on — confirmed directly: it
   * made the drawing-plane marker appear to float free of the cursor,
   * because it had latched onto a past hover position, not the current one.
   */
  function interactionPoint(event: Pick<PointerEvent, 'clientX' | 'clientY'>, commit = false): Vec2 | null {
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
      // BEZIER/SPLINE deliberately want each point free to land on whatever
      // plane Dynamic UCS currently holds (DYNAMIC_UCS_PER_POINT_COMMANDS,
      // DynamicUcsCoordinator's own doc comment) — the drawingPlane freeze
      // below exists for the opposite case (a LINE/RECTANGLE/etc.'s whole
      // shape staying in the ONE plane its first off-plane point picked),
      // and would otherwise silently override every later point back onto
      // whichever plane happened to freeze first, defeating per-point DUCS
      // re-acquisition entirely. Confirmed directly: a spline drawn by
      // hovering a different box face for each point stayed flat.
      const perPointPlane = DYNAMIC_UCS_PER_POINT_COMMANDS.has(active.name);
      const targetedSnap = drawingInteraction.targetSnapMode
        ? nearestGripTargetSnap(event, drawingInteraction.targetSnapMode)
        : nearestPersistentSnap(event);
      if (targetedSnap) {
        // Resting on an endpoint acquires it, so moving off it can then track
        // along its alignment path rather than losing it. A "Nearest" snap slides
        // along an edge and is never a tracking anchor — acquiring one drew a
        // guide line to an arbitrary point on the edge.
        const acquired = targetedSnap.mode === 'nearest' ? null : endpointAnchorFromSnap(targetedSnap);
        if (acquired) state.activeEndpointAnchor = acquired;
        // Carry how far the snap sits off the active plane, not just its shadow on
        // it, so a line drawn in 3D lands on the point it snapped to even when that
        // point belongs to another UCS. The line keeps the active plane; only the
        // endpoint's z rides along.
        let plane = perPointPlane ? undefined : active.data.drawingPlane as WorkPlane | undefined;
        if (!plane) {
          const local = worldToLocal(doc.activeWorkPlane, targetedSnap.world);
          if (Math.abs(local.z) > 1e-8) {
            plane = cloneWorkPlane(doc.activeWorkPlane);
            plane.origin.x += plane.zAxis.x * local.z;
            plane.origin.y += plane.zAxis.y * local.z;
            plane.origin.z += plane.zAxis.z * local.z;
            if (commit && !perPointPlane) {
              active.data.drawingPlane = plane;
              // plane.origin only shares the snapped point's elevation along
              // the UCS normal — its own x/y stay at the UCS origin's, since
              // only orientation matters for the math above. The marker
              // needs the actual point that established the plane, not that
              // arbitrary point on it, or it renders nowhere near the click.
              active.data.drawingPlaneAnchor = targetedSnap.world;
            }
          }
        }
        const local = worldToLocal(plane ?? doc.activeWorkPlane, targetedSnap.world);
        // Carried alongside for commands that snap more than one point off the
        // UCS independently (e.g. ARC_SER's start and end, each Nearest-caught
        // on a curve that is not itself parallel to the UCS): the plane above
        // only ever fits the *first* such point, so a second one silently gets
        // flattened onto it unless the command itself notices and refits — see
        // drawArcStartEndRadius. Every other command is free to ignore this.
        return { x: local.x, y: local.y, world: targetedSnap.world } as Vec2;
      }
      // A per-point command reads the LIVE active work plane (whatever
      // Dynamic UCS currently holds) for every point, carrying its world
      // position along — drawBezier needs the real 3D point, not just its
      // shadow on that plane, to place a point from a different face than
      // the last one anywhere but flattened onto this one. Every other
      // command instead keeps the frozen drawingPlane, once an off-plane
      // first point established one, for every free point and Ortho
      // constraint after it.
      if (perPointPlane) {
        if (doc.viewMode === '3d') {
          const local = renderer3d.workPlanePoint(renderer3d.renderer.domElement, event.clientX, event.clientY, doc.activeWorkPlane);
          if (!local) return null;
          const constrained = constrainedPoint(local);
          return { ...constrained, world: localToWorld(doc.activeWorkPlane, constrained) } as Vec2;
        }
      } else {
        const plane = active.data.drawingPlane as WorkPlane | undefined;
        if (plane && doc.viewMode === '3d') {
          const point = renderer3d.workPlanePoint(renderer3d.renderer.domElement, event.clientX, event.clientY, plane);
          return point ? constrainedPoint(point) : null;
        }
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
      const ridesAlong = active.name === 'MOVE' || active.name === 'COPY' || active.name === 'SCALE';
      const targetedSnap = drawingInteraction.targetSnapMode
        ? nearestGripTargetSnap(event, drawingInteraction.targetSnapMode)
        : nearestPersistentSnap(event);
      if (targetedSnap) {
        // A snapped base-and-target is a full 3D hop: the world point rides along
        // (via worldDeltaOf) so grabbing a corner and dropping it on another lands
        // x, y and z. Otherwise the move stays in the UCS plane.
        if (ridesAlong) active.data.pendingMoveWorldPoint = targetedSnap.world;
        return targetedSnap.point;
      }
      // Grabbing a corner is the natural base point for a transform, so a nearby
      // vertex wins even when persistent OSNAP is off — the same courtesy SLICE
      // gives its plane points. Its world point rides along as an exact 3D hop.
      const vertex = nearestMeasurementPoint(event);
      if (vertex) {
        if (ridesAlong) active.data.pendingMoveWorldPoint = vertex;
        const local = worldToLocal(doc.activeWorkPlane, vertex);
        return { x: local.x, y: local.y };
      }
      if (ridesAlong) delete active.data.pendingMoveWorldPoint;
      if (doc.viewMode === '3d') {
        const planar = worldPoint3d(event);
        if (planar) return constrainedPoint(planar);
        // A steeply tilted UCS can sit edge-on to the camera: its plane ray then
        // misses and the base point could never be placed, so the click silently
        // did nothing. Fall back to the view plane so a point always lands — a
        // typed @dist<angle drives the move within the UCS wherever the base sits.
        return renderer3d.viewPlanePoint(renderer3d.renderer.domElement, event.clientX, event.clientY);
      }
    }
    if (doc.viewMode === '2d') return constrainedPoint(worldPoint(event));
    // In 3D a point with no snap slides along the active UCS plane: the ray
    // meets that plane, so X and Y move and the height is kept. This is why moving
    // a solid used to drift across the screen instead of across its own floor.
    const point = worldPoint3d(event);
    if (point) return constrainedPoint(point);
    // Same edge-on-UCS fallback as the transform branch above: a UCS rotated
    // to stand up out of the screen (UCS X/Y/Z, or a plane picked side-on) can
    // sit near-parallel to every ray the camera casts, so the plane ray misses
    // everywhere and the cursor would otherwise freeze — no preview, no snap
    // retry, nothing placeable — until it happens to land within an object
    // snap's aperture. Falling back to the view plane keeps the cursor live.
    return renderer3d.viewPlanePoint(renderer3d.renderer.domElement, event.clientX, event.clientY);
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
      const guidePlane = commands.active?.data.drawingPlane as WorkPlane | undefined ?? doc.activeWorkPlane;
      start = renderer3d.projectCadPoint(renderer3d.renderer.domElement, localToWorld(guidePlane, state.activeTracking.base));
      end = renderer3d.projectCadPoint(renderer3d.renderer.domElement, localToWorld(guidePlane, state.activeTracking.point));
    }
    if (!start || !end) { trackingLine.hidden = true; return; }
    const dx = end.x - start.x, dy = end.y - start.y;
    trackingLine.style.left = `${start.x}px`;
    trackingLine.style.top = `${start.y}px`;
    trackingLine.style.width = `${Math.hypot(dx, dy)}px`;
    trackingLine.style.transform = `rotate(${Math.atan2(dy, dx)}rad)`;
    trackingLine.hidden = false;
  }

  /** One of the two derived-centre symmetry guide lines — same projection
   *  convention `updateTrackingGuide` above uses (2D: onto the active plane
   *  then screen; 3D: `projectCadPoint`), just from a world-space start/end
   *  rather than ones already local to a guide plane the caller tracked. */
  function positionCenterGuide(element: HTMLElement, guide: { start: Vec3; end: Vec3 } | null): void {
    if (!guide) { element.hidden = true; return; }
    let start: Vec2 | null;
    let end: Vec2 | null;
    if (doc.viewMode === '2d') {
      const { width, height } = ctx.size();
      start = worldToScreen(worldToLocal(doc.activeWorkPlane, guide.start), width, height, renderer2d.pan, renderer2d.zoom);
      end = worldToScreen(worldToLocal(doc.activeWorkPlane, guide.end), width, height, renderer2d.pan, renderer2d.zoom);
    } else {
      start = renderer3d.projectCadPoint(renderer3d.renderer.domElement, guide.start);
      end = renderer3d.projectCadPoint(renderer3d.renderer.domElement, guide.end);
    }
    if (!start || !end) { element.hidden = true; return; }
    const dx = end.x - start.x, dy = end.y - start.y;
    element.style.left = `${start.x}px`;
    element.style.top = `${start.y}px`;
    element.style.width = `${Math.hypot(dx, dy)}px`;
    element.style.transform = `rotate(${Math.atan2(dy, dx)}rad)`;
    element.hidden = false;
  }

  /** Updates both derived-centre guide lines from the current cursor — see
   *  `primedRectangleGuides`'s own doc comment for what triggers them. */
  function updateCenterGuideLines(event: Pick<PointerEvent, 'clientX' | 'clientY'>): void {
    const guides = primedRectangleGuides(event);
    positionCenterGuide(centerGuideA, guides?.a ?? null);
    positionCenterGuide(centerGuideB, guides?.b ?? null);
  }

  /**
   * The default aperture (10px, AutoCAD's own default) — small enough that
   * the marker only lights up close enough to the point that clicking really
   * does land on it. Wider than that, the marker still showing read as "this
   * click will snap here" when the click could just as easily have landed a
   * few pixels short, on the raw cursor position instead.
   */
  function nearestMeasurementPoint(event: Pick<PointerEvent, 'clientX' | 'clientY'>, pixelTolerance = 10): { x: number; y: number; z: number } | null {
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

  /**
   * The "from" point Perpendicular and Tangent measure against: the active
   * draw command's last point when one is running, or — with no command
   * active, which is the ordinary case while grip-dragging an existing
   * entity's own point — the natural reference the grip drag itself supplies
   * (a dragged line endpoint's own other end).
   */
  function commandOrDragReferencePoint(): Vec3 | null {
    const active = commands.active;
    const referenceValue = active?.data.start ?? active?.data.basePoint ?? active?.data.center;
    if (referenceValue && typeof referenceValue === 'object' && 'x' in referenceValue && 'y' in referenceValue) {
      return localToWorld(doc.activeWorkPlane, referenceValue as Vec2);
    }
    return gripController.dragReferencePoint();
  }

  /**
   * The two symmetry guide lines for whichever primed rectangle the cursor
   * is currently near — so aiming for the centre has a visual crosshair to
   * follow instead of hunting blind for the exact snap pixel (the user's
   * own follow-up request, after the plain snap point shipped: "no need to
   * circle the cursor around looking for it"). "Near" is that rectangle's
   * own bounding box, expanded by a margin, in its own local frame — one
   * primed earlier in the session stays quiet everywhere else in the
   * drawing until the cursor is actually back near it again.
   */
  function primedRectangleGuides(event: Pick<PointerEvent, 'clientX' | 'clientY'>): { a: { start: Vec3; end: Vec3 }; b: { start: Vec3; end: Vec3 } } | null {
    if (primedRectangleCenters.size === 0) return null;
    const cursor = cursorWorldPoint(event);
    if (!cursor) return null;
    for (const id of primedRectangleCenters) {
      const entity = doc.getEntity(id);
      if (!entity || entity.type !== 'rectangle') continue;
      const plane = entity.workPlane ?? WORLD_WORK_PLANE;
      const local = worldToLocal(plane, cursor);
      const minX = Math.min(entity.first.x, entity.opposite.x), maxX = Math.max(entity.first.x, entity.opposite.x);
      const minY = Math.min(entity.first.y, entity.opposite.y), maxY = Math.max(entity.first.y, entity.opposite.y);
      const marginX = (maxX - minX) * 0.2, marginY = (maxY - minY) * 0.2;
      if (local.x < minX - marginX || local.x > maxX + marginX || local.y < minY - marginY || local.y > maxY + marginY) continue;
      const [guideA, guideB] = rectangleSymmetryGuides(entity);
      const toWorld = (point: Vec2): Vec3 => localToWorld(plane, point);
      return {
        a: { start: toWorld(guideA.start), end: toWorld(guideA.end) },
        b: { start: toWorld(guideB.start), end: toWorld(guideB.end) },
      };
    }
    return null;
  }

  /** The cursor's own world point, standing in for a reference when a snap
   *  mode's valid targets form a locus tracked by the cursor rather than a
   *  handful of fixed points (see `tangentDragCandidates`). */
  function cursorWorldPoint(event: Pick<PointerEvent, 'clientX' | 'clientY'>): Vec3 | null {
    const local = doc.viewMode === '3d' ? rawWorldPoint3d(event) : rawWorldPoint(event);
    return local ? localToWorld(doc.activeWorkPlane, local) : null;
  }

  /** Tangent candidates for a whole circle being moved by its centre grip, so
   *  it can snap to touch a target line or circle at its own fixed radius —
   *  in addition to (not instead of) the ordinary point-tangent candidates,
   *  which stay empty here since a circle-centre drag has no reference point. */
  function tangentCircleDragCandidates(event: Pick<PointerEvent, 'clientX' | 'clientY'>) {
    const draggedRadius = gripController.draggingCircleRadius();
    if (!draggedRadius) return [];
    const cursor = cursorWorldPoint(event);
    if (!cursor) return [];
    return tangentDragCandidates(doc, draggedRadius, cursor, gripController.draggingObjectId);
  }

  function nearestGripTargetSnap(
    event: Pick<PointerEvent, 'clientX' | 'clientY'>,
    mode: ObjectSnapMode | null = gripInteraction.targetSnapMode,
    pixelTolerance = 10,
  ): GripSnapTarget | null {
    if (!mode) return null;
    // 'nearest' has no discrete candidates (objectSnapCandidates deliberately
    // returns none for it — see its own comment) — same edge resolution
    // nearestPersistentSnap's own tail uses, just forced instead of only
    // filling in when no discrete snap wins. Forcing this one explicitly is
    // the point of the override menu: no more losing to a nearby Endpoint.
    if (mode === 'nearest') {
      const rect = viewport.getBoundingClientRect();
      const cursor = { x: event.clientX - rect.left, y: event.clientY - rect.top };
      const world = doc.viewMode === '3d'
        ? nearestEdgeWorldPoint(
          doc,
          cursor,
          renderer3d.pointerRay(renderer3d.renderer.domElement, event.clientX, event.clientY),
          (point) => renderer3d.projectCadPoint(renderer3d.renderer.domElement, point),
          pixelTolerance,
          gripController.draggingObjectId,
        )
        : nearestEdgeLocalPoint(doc, rawWorldPoint(event), doc.activeWorkPlane, pixelTolerance / renderer2d.zoom, gripController.draggingObjectId);
      if (!world) return null;
      const local = worldToLocal(doc.activeWorkPlane, world);
      return { point: { x: local.x, y: local.y }, world, mode: 'nearest' };
    }
    const reference = commandOrDragReferencePoint();
    const candidates = objectSnapCandidates(doc, mode, gripController.draggingObjectId, reference);
    if (mode === 'tangent') candidates.push(...tangentCircleDragCandidates(event));
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
    pixelTolerance = 10,
  ): GripSnapTarget | null {
    if (!doc.drafting.objectSnapEnabled || doc.drafting.objectSnapModes.length === 0) return null;
    const active = commands.active;
    const reference = commandOrDragReferencePoint();
    // Intersection snapping is quadratic in entity count (and curves expand to
    // segments). While a large selection is transformed, intersections among
    // the objects riding together cannot help place the transform, but used to
    // consume nearly the whole pointer frame for illustrations. Keep endpoint,
    // midpoint, centre and the other linear modes available.
    const transformSelection = active && transformsObjects(active.name)
      ? doc.selectedEntityIds.size + doc.selectedSolidIds.size
      : 0;
    const modes = transformSelection > 1
      ? doc.drafting.objectSnapModes.filter((mode) => mode !== 'intersection' && mode !== 'apparent-intersection')
      : doc.drafting.objectSnapModes;
    const candidates = modes.flatMap((mode) =>
      objectSnapCandidates(doc, mode, gripController.draggingObjectId, reference));
    if (modes.includes('tangent')) candidates.push(...tangentCircleDragCandidates(event));
    // Not gated on 'center' being an active running osnap — this candidate is
    // earned by the priming gesture itself, not by the ambient mode list.
    candidates.push(...derivedRectangleCenterCandidates(doc, primedRectangleCenters, gripController.draggingObjectId));
    const rect = viewport.getBoundingClientRect();
    const cursor = { x: event.clientX - rect.left, y: event.clientY - rect.top };
    const discrete = doc.viewMode === '3d'
      ? nearestCandidateProjected(
        candidates,
        cursor,
        (point) => renderer3d.projectCadPoint(renderer3d.renderer.domElement, point),
        pixelTolerance,
        doc.activeWorkPlane,
      )
      : nearestCandidate2d(candidates, rawWorldPoint(event), doc.activeWorkPlane, pixelTolerance / renderer2d.zoom);
    notePotentialRectangleMidpoint(discrete);
    // Discrete snaps (end, mid, centre…) win; the "Nearest" edge snap only fills
    // in when none of them is under the cursor, so ending a line on an edge keeps
    // the edge's true 3D point rather than dropping onto the UCS/WCS plane. It
    // takes a tighter aperture so a nearby endpoint or midpoint clearly wins.
    if (discrete || !modes.includes('nearest')) return discrete;
    const world = doc.viewMode === '3d'
      ? nearestEdgeWorldPoint(
        doc,
        cursor,
        renderer3d.pointerRay(renderer3d.renderer.domElement, event.clientX, event.clientY),
        (point) => renderer3d.projectCadPoint(renderer3d.renderer.domElement, point),
        pixelTolerance * 0.6,
        gripController.draggingObjectId,
      )
      : nearestEdgeLocalPoint(
        doc,
        rawWorldPoint(event),
        doc.activeWorkPlane,
        pixelTolerance * 0.6 / renderer2d.zoom,
        gripController.draggingObjectId,
      );
    if (!world) return null;
    const local = worldToLocal(doc.activeWorkPlane, world);
    return { point: { x: local.x, y: local.y }, world, mode: 'nearest' };
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
    primedRectangleGuides,
    updateCenterGuideLines,
  };
}
