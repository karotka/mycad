import type { Vec2 } from '../math/geometry';
import { localToWorld, worldToLocal, WORLD_WORK_PLANE, type WorkPlane } from '../math/workplane';
import type { Document } from '../core/Document';
import type { Entity, Solid, SolidFaceSelection } from '../core/entities/types';
import type { CommandManager } from '../core/commands/CommandManager';
import type { Canvas2DRenderer } from '../render/Canvas2DRenderer';
import type { Viewport3D } from '../render/Viewport3D';
import type { ViewportNavigationController } from './ViewportNavigationController';
import type { WindowDragController } from './WindowDragController';
import type { GripController } from './GripController';
import type { GripInteractionController } from './GripInteractionController';
import type { DrawingInteractionController } from './DrawingInteractionController';
import type { SelectionController } from './SelectionController';
import type { DynamicUcsController } from './DynamicUcsController';
import type { PreviewController } from '../ui/PreviewController';
import type { ObjectSnapMode, SnapTarget } from './SnapService';
import { resolvePointerGesture } from './PointerGesture';
import { grabsGrip, resolveViewportAction } from './ViewportAction';
import { hitTestSolid2d, pickEntityAt } from './PickingService';
import { createPointResolver, type PointResolverState } from './PointResolver';
import { createSolidDragPreview } from './DragEditing';
import { createDynamicUcsCoordinator } from './DynamicUcsCoordinator';
import { createToolActions } from './ToolActions';
import { pointWorkPlaneAxisAt, type UcsHandleName } from '../math/ucsAxisRotation';

/**
 * The handful of small preview/selection helpers that still live in main.ts and
 * are shared between the pointer handlers and the render loop. Passed in rather
 * than moved so the render loop keeps its own copies.
 */
export interface ViewportPointerHelpers {
  gripEditingPoint(event: Pick<PointerEvent, 'clientX' | 'clientY'>, snap?: SnapTarget | null, endpointAnchor?: Vec2 | null): Vec2 | null;
  updatePreview(cursor: Vec2): void;
  showDimension(text: string | null, x: number, y: number): void;
  showPreviewLabel(text: string | null, x: number, y: number): void;
  updateDynamicRectangleInput(start: Vec2, cursor: Vec2): Vec2;
  positionMeasureMarker(marker: HTMLElement, x: number, y: number): void;
  positionSnapMarker(point: { x: number; y: number; z: number }, fallbackX: number, fallbackY: number, mode?: ObjectSnapMode): void;
  selectedEntity(): Entity | undefined;
  selectedSolid(): Solid | undefined;
  profileContainingPoint(point: Vec2): Entity | undefined;
  solidSelectionExclusions(): Set<string>;
  activeGripsInWorld(): Array<{ point: Vec2 & { z?: number }; index: number; shape?: 'square' | 'edge' }>;
}

export interface ViewportPointerContext {
  cadDocument: Document;
  commands: CommandManager;
  renderer2d: Canvas2DRenderer;
  renderer3d: Viewport3D;
  navigation: ViewportNavigationController;
  windowDrag: WindowDragController;
  gripController: GripController;
  gripInteraction: GripInteractionController;
  drawingInteraction: DrawingInteractionController;
  selectionController: SelectionController;
  dynamicUcsController: DynamicUcsController;
  previewController: PreviewController;
  viewport: HTMLElement;
  gripMenu: HTMLElement;
  crosshair: HTMLElement;
  prompt: HTMLElement;
  snapMarker: HTMLElement;
  coords: HTMLElement;
  trackingLine: HTMLElement;
  measureTarget: HTMLElement;
  measureOrigin: HTMLElement;
  input: HTMLInputElement;
  resolver: ReturnType<typeof createPointResolver>;
  dragPreview: ReturnType<typeof createSolidDragPreview>;
  ducs: ReturnType<typeof createDynamicUcsCoordinator>;
  toolActions: ReturnType<typeof createToolActions>;
  helpers: ViewportPointerHelpers;
  pointerState: PointResolverState;
  hoverState: { ucsHoverPoint: { x: number; y: number; z: number } | null };
  zoomWindowMode: () => boolean;
  redraw: () => void;
  log: (message: string) => void;
}

/**
 * Registers the three viewport pointer listeners. This is the app's central
 * event orchestration — hover feedback, drag commits, grip editing, dynamic
 * UCS, selection and the context menu — so it reaches almost every controller.
 * Extracted from main.ts verbatim: the bodies are unchanged except that the
 * shared bindings arrive through `ctx`.
 */
export function attachViewportPointerHandlers(ctx: ViewportPointerContext): void {
  const {
    cadDocument, commands, renderer2d, renderer3d, navigation, windowDrag,
    gripController, gripInteraction, drawingInteraction, selectionController,
    dynamicUcsController, previewController, viewport, gripMenu, crosshair, prompt,
    snapMarker, coords, trackingLine, measureTarget, measureOrigin, input,
    pointerState, hoverState, zoomWindowMode, redraw, log,
  } = ctx;
  const {
    interactionPoint, worldPoint, worldPoint3d, rawWorldPoint, rawWorldPoint3d,
    nearestMeasurementPoint, nearestGripTargetSnap, nearestPersistentSnap,
    endpointAnchorFromSnap, updateTrackingGuide,
  } = ctx.resolver;
  const { pressPullDrag, extrudeHeightUnderCursor, primitiveFinalUnderCursor, updateExtrudePreview, updatePrimitiveFinalPreview } = ctx.dragPreview;
  const { canAcquireDynamicUcs, snapKeepsDynamicUcs, acquireDynamicUcs, releaseDynamicUcs, beforeDynamicUcsAnswer, afterDynamicUcsAnswer, ownsActiveCommand } = ctx.ducs;
  const { openContextMenu } = ctx.toolActions;
  const {
    gripEditingPoint, updatePreview, showDimension, showPreviewLabel,
    updateDynamicRectangleInput,
    positionMeasureMarker, positionSnapMarker, selectedEntity, selectedSolid,
    profileContainingPoint, solidSelectionExclusions, activeGripsInWorld,
  } = ctx.helpers;

  /** Set by a right-button press: a release that never moved opens the menu. */
  let menuOnStillRelease = false;
  let ucsAxisDrag: {
    handle: UcsHandleName;
    basePlane: WorkPlane;
    startedWithoutNamedUcs: boolean;
    changed: boolean;
  } | null = null;
  let ucsHandlesArmed = false;

  function finishUcsAxisDrag(): void {
    if (!ucsAxisDrag) return;
    const createNamed = ucsAxisDrag.startedWithoutNamedUcs && ucsAxisDrag.changed;
    const changed = ucsAxisDrag.changed;
    ucsAxisDrag = null;
    snapMarker.hidden = true;
    if (createNamed) {
      const named = cadDocument.addNamedWorkPlane(cadDocument.activeWorkPlane);
      log(`UCS axis rotated; ${named.name} created.`);
    } else if (changed) {
      cadDocument.notify();
      log('UCS axis rotated.');
    }
  }

  viewport.addEventListener('pointermove', (event) => {
    if (gripMenu.hidden) viewport.classList.remove('context-menu-cursor-pending');
    const rect = viewport.getBoundingClientRect();
    const sx = event.clientX - rect.left;
    const sy = event.clientY - rect.top;
    // Keep the software CAD cursor attached to the pointer even when a mode
    // (selection window, pan, etc.) returns before geometric hover processing.
    crosshair.style.left = `${sx}px`;
    crosshair.style.top = `${sy}px`;
    if (ucsAxisDrag) {
      // Prefer an exact model vertex, but keep the grip following the pointer
      // between snap points as well.  The projection must use the plane captured
      // at pointer-down; projecting against the plane while we rotate it creates
      // a feedback loop and makes the grip appear stuck or jittery.
      const snappedTarget = nearestMeasurementPoint(event);
      const planarTarget = renderer3d.workPlanePoint(
        renderer3d.renderer.domElement,
        event.clientX,
        event.clientY,
        ucsAxisDrag.basePlane,
      );
      const target = snappedTarget
        ?? (planarTarget ? localToWorld(ucsAxisDrag.basePlane, planarTarget) : null);
      if (target) {
        const plane = ucsAxisDrag.handle === 'origin'
          ? { ...ucsAxisDrag.basePlane, origin: { ...target } }
          : pointWorkPlaneAxisAt(ucsAxisDrag.basePlane, ucsAxisDrag.handle, target);
        if (plane) {
          ucsAxisDrag.changed = true;
          cadDocument.activeWorkPlane = plane;
          const named = cadDocument.namedWorkPlanes.find((item) => item.id === cadDocument.activeNamedWorkPlaneId);
          if (named) named.workPlane = { ...plane, origin: { ...plane.origin }, xAxis: { ...plane.xAxis }, yAxis: { ...plane.yAxis }, zAxis: { ...plane.zAxis } };
          renderer3d.setWorkPlane(plane);
          positionSnapMarker(target, sx, sy);
          showDimension(ucsAxisDrag.handle === 'origin' ? 'UCS origin' : `UCS ${ucsAxisDrag.handle.toUpperCase()} axis`, sx, sy);
          redraw();
        }
      }
      event.preventDefault();
      return;
    }
    if (ucsHandlesArmed && cadDocument.viewMode === '3d' && !commands.active) {
      const handle = renderer3d.pickUcsHandle(renderer3d.renderer.domElement, event.clientX, event.clientY);
      renderer3d.highlightUcsHandle(handle);
      viewport.classList.toggle('object-pick', handle !== null);
    } else if (ucsHandlesArmed) renderer3d.highlightUcsHandle(null);
    const choosingCircularDimensionEdge = cadDocument.viewMode === '3d'
      && (commands.active?.name === 'DIMRADIUS' || commands.active?.name === 'DIMDIAMETER')
      && commands.active.stepIndex === 0;
    if (choosingCircularDimensionEdge) {
      renderer3d.pickCircularSolidEdge(
        renderer3d.renderer.domElement,
        cadDocument.solids.filter((solid) => !cadDocument.hiddenLayers.has(solid.layer)),
        event.clientX,
        event.clientY,
      );
    } else if (
      cadDocument.viewMode === '3d'
      && commands.active?.name === 'DIMANGULAR'
      && commands.active.steps[commands.active.stepIndex]?.kind === 'entity'
    ) {
      renderer3d.pickSolidEdge(
        renderer3d.renderer.domElement,
        cadDocument.solids.filter((solid) => !cadDocument.hiddenLayers.has(solid.layer)),
        event.clientX,
        event.clientY,
      );
    } else if (cadDocument.viewMode === '3d' && (commands.active?.name === 'CHAMFER' || commands.active?.name === 'FILLET')) {
      const circular = renderer3d.pickCircularSolidEdge(
        renderer3d.renderer.domElement,
        cadDocument.solids,
        event.clientX,
        event.clientY,
      );
      if (!circular) {
        renderer3d.pickSolidEdge(renderer3d.renderer.domElement, cadDocument.solids, event.clientX, event.clientY);
      }
    } else {
      renderer3d.clearEdgeHighlight();
    }
    // Highlighting follows the cursor only while a face is still being chosen.
    // Once one is picked the cursor is dragging it, and re-picking under the
    // cursor would light up whatever it happens to pass over instead.
    const choosingModellingFace = (commands.active?.name === 'PRESSPULL' || commands.active?.name === 'DELETEFACE')
      && commands.active.stepIndex === 0;
    const choosingSlicePlane = commands.active?.name === 'SLICE'
      && commands.active.steps[commands.active.stepIndex]?.kind === 'plane';
    const choosingDynamicUcs = canAcquireDynamicUcs();
    const slicePlanePoint = choosingSlicePlane
      ? ((drawingInteraction.targetSnapMode
        ? nearestGripTargetSnap(event, drawingInteraction.targetSnapMode)
        : nearestPersistentSnap(event)) ?? nearestMeasurementPoint(event))
      : null;
    let dynamicFace: SolidFaceSelection | null = null;
    if (choosingDynamicUcs) {
      const keepCurrentFace = snapKeepsDynamicUcs(event);
      if (!keepCurrentFace) {
        dynamicFace = renderer3d.pickSolidFace(
          renderer3d.renderer.domElement,
          event.clientX,
          event.clientY,
          cadDocument.solids,
          cadDocument.entities.filter((item) => !cadDocument.hiddenLayers.has(item.layer)),
        );
      }
      if (dynamicFace) acquireDynamicUcs(dynamicFace, event);
      else if (!keepCurrentFace) {
        releaseDynamicUcs();
        renderer3d.clearFaceHighlight();
      }
    } else if (cadDocument.viewMode === '3d' && (choosingModellingFace || (choosingSlicePlane && !slicePlanePoint))) {
      renderer3d.pickSolidFace(
        renderer3d.renderer.domElement,
        event.clientX,
        event.clientY,
        cadDocument.solids,
        cadDocument.entities.filter((item) => !cadDocument.hiddenLayers.has(item.layer)),
      );
    } else if (commands.active?.name !== 'PRESSPULL' && commands.active?.name !== 'DELETEFACE' && !dynamicUcsController.isTemporary) {
      renderer3d.clearFaceHighlight();
    }
    if (windowDrag.active) {
      const drag = windowDrag.update({ x: sx, y: sy });
      if (drag?.purpose === 'zoom') prompt.textContent = 'Specify opposite corner of zoom window:';
      return;
    }
    navigation.updatePointer({ x: sx, y: sy });
    if (commands.active?.name === 'UCS') {
      const snap = nearestMeasurementPoint(event, Number.POSITIVE_INFINITY);
      hoverState.ucsHoverPoint = snap;
      if (snap) {
        positionSnapMarker(snap, sx, sy);
        const ucsLabel = commands.active.stepIndex === 0
          ? 'UCS origin'
          : commands.active.stepIndex === 1 ? 'UCS positive X axis' : 'UCS positive Y axis';
        showDimension(ucsLabel, sx, sy);
      } else {
        hoverState.ucsHoverPoint = null;
        snapMarker.hidden = true;
      }
    }
    const gripSnap = gripController.isDragging
      ? (gripInteraction.targetSnapMode ? nearestGripTargetSnap(event) : nearestPersistentSnap(event))
      : null;
    const endpointAnchor = endpointAnchorFromSnap(gripSnap)
      ?? (gripController.isDragging && cadDocument.viewMode === '2d'
        ? gripController.polylineEndpointAnchor(rawWorldPoint(event), 8 / renderer2d.zoom)
        : null);
    if (endpointAnchor) pointerState.activeEndpointAnchor = endpointAnchor;
    const p = gripController.isDragging ? gripEditingPoint(event, gripSnap, pointerState.activeEndpointAnchor) : interactionPoint(event);
    if (!p) { trackingLine.hidden = true; return; }
    if (gripController.isDragging) {
      gripController.update(p);
      if (gripSnap) positionSnapMarker(gripSnap.world, sx, sy, gripSnap.mode);
      else if (gripInteraction.targetSnapMode) snapMarker.hidden = true;
      showDimension(gripController.changedDimension(), sx, sy);
    }
    else {
      if (cadDocument.viewMode === '2d') gripController.hoveredGrip = gripController.nearest2d(rawWorldPoint(event), 10 / renderer2d.zoom);
      else gripController.hoveredGrip = renderer3d.pickGripIndex(
        renderer3d.renderer.domElement,
        activeGripsInWorld(),
        event.clientX,
        event.clientY
      );
    }
    coords.textContent = `X: ${p.x.toFixed(3)} mm Y: ${p.y.toFixed(3)} mm`;
    updateTrackingGuide();
    if (pointerState.activeTracking) showDimension(`∠ ${pointerState.activeTracking.angle.toFixed(0)}°`, sx, sy);
    updatePreview(p);
    // After updatePreview, which clears the frame before deciding what to draw:
    // this one is steered by the pointer ray rather than by the work-plane point
    // it is handed, so it has no say in there.
    const pressPull = pressPullDrag(event);
    if (pressPull) showDimension(`${pressPull.delta > 0 ? 'Pull' : 'Push'} ${Math.abs(pressPull.delta).toFixed(2)} mm`, sx, sy);
    updateExtrudePreview(event, sx, sy);
    const primitiveFinalDrag = updatePrimitiveFinalPreview(event, sx, sy);
    const active = commands.active;
    if (active?.name === 'ROTATE' && active.stepIndex === 2 && active.data.basePoint) {
      const base = active.data.basePoint as Vec2;
      const angle = Math.atan2(p.y - base.y, p.x - base.x) * 180 / Math.PI;
      showPreviewLabel(`Angle ${angle.toFixed(2)}°`, sx, sy);
    }
    const targetedDrawingSnap = drawingInteraction.isPointStep && drawingInteraction.targetSnapMode
      ? nearestGripTargetSnap(event, drawingInteraction.targetSnapMode)
      : null;
    const persistentDrawingSnap = drawingInteraction.isPointStep && !drawingInteraction.targetSnapMode
      ? nearestPersistentSnap(event)
      : null;
    const drawingSnap = drawingInteraction.isPointStep
      ? targetedDrawingSnap?.world ?? persistentDrawingSnap?.world ?? null
      : null;
    const extrudeSnap = active?.name === 'EXTRUDE' && active.stepIndex === 1
      ? nearestMeasurementPoint(event)
      : null;
    const pressPullSnap = active?.name === 'PRESSPULL' && active.stepIndex === 1
      ? nearestMeasurementPoint(event)
      : null;
    const primitiveFinalSnap = primitiveFinalDrag?.snap ?? null;
    const rotateSnap = active?.name === 'ROTATE' && active.steps[active.stepIndex]?.kind === 'point'
      ? nearestMeasurementPoint(event)
      : null;
    const sliceVertexSnap = active?.name === 'SLICE'
      && (active.steps[active.stepIndex]?.kind === 'plane' || active.steps[active.stepIndex]?.kind === 'point')
      ? nearestMeasurementPoint(event)
      : null;
    if (drawingSnap || extrudeSnap || pressPullSnap || primitiveFinalSnap || rotateSnap || sliceVertexSnap) {
      if (targetedDrawingSnap) positionSnapMarker(targetedDrawingSnap.world, sx, sy, targetedDrawingSnap.mode);
      else if (persistentDrawingSnap) positionSnapMarker(persistentDrawingSnap.world, sx, sy, persistentDrawingSnap.mode);
      else if (primitiveFinalSnap) positionSnapMarker(primitiveFinalSnap, sx, sy);
      else if (rotateSnap) positionSnapMarker(rotateSnap, sx, sy);
      else if (sliceVertexSnap) positionSnapMarker(sliceVertexSnap, sx, sy);
      // Extrude/press-pull snap the height to a vertex — an endpoint. Draw the
      // endpoint square at it, not the stale symbol positionMeasureMarker left on
      // the marker (which showed the previous Nearest hourglass).
      else if (extrudeSnap) positionSnapMarker(extrudeSnap, sx, sy);
      else if (pressPullSnap) positionSnapMarker(pressPullSnap, sx, sy);
      else positionMeasureMarker(snapMarker, sx, sy);
      if (extrudeSnap) {
        const height = worldToLocal(cadDocument.activeWorkPlane, extrudeSnap).z;
        showDimension(`Height ${height.toFixed(2)} mm`, sx, sy);
      }
    } else if (!gripController.isDragging || !gripInteraction.targetSnapMode) {
      snapMarker.hidden = true;
    }
    if (active?.name === 'MEASURE' || active?.name === 'DIMALIGNED') {
      const snap = nearestMeasurementPoint(event);
      if (snap && active.stepIndex === 1 && active.data.start) {
        positionMeasureMarker(measureTarget, sx, sy);
        const start = active.data.start as { x: number; y: number; z?: number };
        const distance = Math.hypot(snap.x - start.x, snap.y - start.y, snap.z - (start.z ?? 0));
        showDimension(`Distance ${distance.toFixed(3)} mm`, sx, sy);
      } else if (snap) {
        if (active.stepIndex === 0) measureTarget.hidden = true;
        showDimension(`Point ${snap.x.toFixed(2)}, ${snap.y.toFixed(2)}, ${snap.z.toFixed(2)}`, sx, sy);
      } else if (active.stepIndex === 1) {
        measureTarget.hidden = true;
      }
    } else {
      measureOrigin.hidden = true;
      measureTarget.hidden = true;
    }
    if (active?.stepIndex === 1) {
      if (active.name === 'LINE' && active.data.start) {
        const start = active.data.start as Vec2;
        showPreviewLabel(`L ${Math.hypot(p.x - start.x, p.y - start.y).toFixed(2)} mm`, sx, sy);
      } else if (active.name === 'RECTANGLE' && active.data.start) {
        const start = active.data.start as Vec2;
        if (cadDocument.viewMode === '2d') {
          // The boxes may fix one axis at a typed value; redraw the rubber-band
          // preview against that same effective corner, not the raw cursor —
          // otherwise a typed width shows the right number but the drawn
          // rectangle keeps changing size as if nothing had been fixed.
          const corner = updateDynamicRectangleInput(start, p);
          updatePreview(corner);
        }
        else showPreviewLabel(`${Math.abs(p.x - start.x).toFixed(2)} × ${Math.abs(p.y - start.y).toFixed(2)} mm`, sx, sy);
      } else if (active.name === 'CIRCLE' && active.data.center) {
        const center = active.data.center as Vec2;
        const radius = Math.hypot(p.x - center.x, p.y - center.y);
        showPreviewLabel(`R ${radius.toFixed(2)} mm · Ø ${(radius * 2).toFixed(2)} mm`, sx, sy);
      }
    }
    if (active?.name === 'POLYGON' && active.stepIndex === 2 && active.data.center) {
      const center = active.data.center as Vec2;
      showPreviewLabel(`Apothem ${Math.hypot(p.x - center.x, p.y - center.y).toFixed(2)} mm`, sx, sy);
    }
    if (active?.name === 'MOVE' && active.stepIndex === 2 && active.data.basePoint) {
      const base = active.data.basePoint as Vec2;
      const delta = { x: p.x - base.x, y: p.y - base.y };
      const distance = Math.hypot(delta.x, delta.y);
      const label = cadDocument.viewMode === '3d'
        ? renderer3d.formatMoveDelta(delta)
        : `ΔX ${delta.x.toFixed(2)} · ΔY ${delta.y.toFixed(2)} · ${distance.toFixed(2)} mm`;
      showPreviewLabel(label, sx, sy);
    }
    void commands.handlePreview(p);
    redraw();
  });

  viewport.addEventListener('pointerdown', async (event) => {
    // The MTEXT editor's own controls sit inside #viewport for layout, but a
    // click there is ordinary HTML text editing. Letting it reach the CAD
    // picking/selection logic below refocused the command line mid-drag,
    // which broke selecting and copying text out of the editor.
    if ((event.target as HTMLElement).closest('.mtext-editor')) return;
    if (event.button === 0 && ucsAxisDrag) {
      finishUcsAxisDrag();
      event.preventDefault();
      return;
    }
    if (event.button === 0 && ucsHandlesArmed && cadDocument.viewMode === '3d' && !commands.active) {
      const handle = renderer3d.pickUcsHandle(renderer3d.renderer.domElement, event.clientX, event.clientY);
      if (handle) {
        const plane = cadDocument.activeWorkPlane;
        ucsAxisDrag = {
          handle,
          basePlane: {
            origin: { ...plane.origin },
            xAxis: { ...plane.xAxis },
            yAxis: { ...plane.yAxis },
            zAxis: { ...plane.zAxis },
          },
          startedWithoutNamedUcs: cadDocument.activeNamedWorkPlaneId === null,
          changed: false,
        };
        event.preventDefault();
        return;
      }
    }
    const gesture = resolvePointerGesture({
      button: event.button,
      metaKey: event.metaKey,
      altKey: event.altKey,
      onViewToggle: Boolean((event.target as HTMLElement).closest('.view-toggle')),
      zoomWindowArmed: zoomWindowMode(),
    });

    if (gesture.kind === 'ignore') return;
    if (gesture.kind === 'zoomWindow') {
      selectionController.beginWindow(event, 'zoom');
      event.preventDefault();
      return;
    }
    // The 3D transition is deferred until Viewport3D observes real pointer movement.
    if (gesture.kind === 'orbit') {
      event.preventDefault();
      return;
    }
    if (gesture.kind === 'pan') {
      menuOnStillRelease = gesture.opensMenuIfStill;
      const rect = viewport.getBoundingClientRect();
      navigation.beginPan({ x: event.clientX - rect.left, y: event.clientY - rect.top }, event.pointerId);
      event.preventDefault();
      return;
    }
    if (gripController.isDragging && gripInteraction.isLatched) {
      const snap = nearestGripTargetSnap(event);
      const point = gripEditingPoint(event, snap);
      if (point) gripController.update(point);
      gripInteraction.finishClick(event.pointerId);
      snapMarker.hidden = true;
      event.preventDefault();
      redraw();
      input.focus();
      return;
    }
    if (commands.active?.name === 'UCS') {
      let snap = nearestMeasurementPoint(event, Number.POSITIVE_INFINITY);
      if (snap && commands.active.stepIndex === 1 && commands.active.data.origin) {
        const origin = commands.active.data.origin as { x: number; y: number; z: number };
        if (Math.hypot(snap.x - origin.x, snap.y - origin.y, snap.z - origin.z) < 1e-8) {
          log('UCS: select a different vertex for the positive X axis.');
          snap = null;
        }
      }
      if (snap && commands.active.stepIndex === 2 && commands.active.data.origin && commands.active.data.xPoint) {
        const origin = commands.active.data.origin as { x: number; y: number; z: number };
        const xPoint = commands.active.data.xPoint as { x: number; y: number; z: number };
        const x = { x: xPoint.x - origin.x, y: xPoint.y - origin.y, z: xPoint.z - origin.z };
        const y = { x: snap.x - origin.x, y: snap.y - origin.y, z: snap.z - origin.z };
        const crossLength = Math.hypot(
          x.y * y.z - x.z * y.y,
          x.z * y.x - x.x * y.z,
          x.x * y.y - x.y * y.x,
        );
        if (crossLength < 1e-8) {
          log('UCS: select a Y-axis vertex that is not collinear with the X axis.');
          snap = null;
        }
      }
      if (snap) {
        await commands.handleClick(snap);
        input.focus();
      } else {
        log('UCS: select an existing vertex.');
      }
      event.preventDefault();
      return;
    }
    // The click that ends the drag commits the distance the preview was showing,
    // so what you let go of is what you get.
    const pressPull = pressPullDrag(event);
    if (pressPull) {
      previewController.clearPreview();
      await commands.submitInput(String(pressPull.delta));
      renderer3d.clearFaceHighlight();
      input.focus();
      event.preventDefault();
      return;
    }
    // The click ends the drag at the height the preview was showing. It used to
    // fire only when a vertex was under the cursor, and measured that against the
    // *active* work plane rather than the profile's — so moving the UCS after
    // drawing put the height on the wrong ruler.
    const extrudeDrag = extrudeHeightUnderCursor(event);
    if (extrudeDrag) {
      previewController.clearPreview();
      await commands.submitInput(String(extrudeDrag.height));
      snapMarker.hidden = true;
      input.focus();
      event.preventDefault();
      return;
    }
    const primitiveFinalDrag = primitiveFinalUnderCursor(event);
    if (primitiveFinalDrag) {
      previewController.clearPreview();
      const dynamicAnswer = beforeDynamicUcsAnswer();
      await commands.submitInput(String(primitiveFinalDrag.value));
      afterDynamicUcsAnswer(dynamicAnswer);
      snapMarker.hidden = true;
      input.focus();
      event.preventDefault();
      return;
    }
    if (
      commands.active?.name === 'DIMANGULAR'
      && commands.active.data.angularPointMode === true
      && commands.active.stepIndex === 2
      && commands.active.data.dynamicUcsConfirmed !== true
    ) {
      if (canAcquireDynamicUcs()) {
        if (!snapKeepsDynamicUcs(event)) {
          const face = renderer3d.pickSolidFace(
            renderer3d.renderer.domElement,
            event.clientX,
            event.clientY,
            cadDocument.solids,
            cadDocument.entities.filter((item) => !cadDocument.hiddenLayers.has(item.layer)),
          );
          if (face) acquireDynamicUcs(face, event);
          else releaseDynamicUcs();
        }
      }
      if (ownsActiveCommand()) {
        dynamicUcsController.lock();
        commands.active.data.dynamicUcsConfirmed = true;
        log('DUCS plane locked. Specify the angle vertex.');
        redraw();
        input.focus();
        event.preventDefault();
        return;
      }
    }
    if (commands.active?.name === 'MEASURE' || commands.active?.name === 'DIMALIGNED') {
      // Pointer move normally acquires the highlighted DUCS face. Repeat the
      // pick on the first click so a quick toolbar-to-viewport click cannot miss
      // the temporary plane merely because no move event arrived in between.
      if (commands.active.name === 'MEASURE' && canAcquireDynamicUcs()) {
        if (!snapKeepsDynamicUcs(event)) {
          const face = renderer3d.pickSolidFace(
            renderer3d.renderer.domElement,
            event.clientX,
            event.clientY,
            cadDocument.solids,
            cadDocument.entities.filter((item) => !cadDocument.hiddenLayers.has(item.layer)),
          );
          if (face) acquireDynamicUcs(face, event);
          else releaseDynamicUcs();
        }
      }
      if (
        commands.active.name === 'MEASURE'
        && commands.active.stepIndex === 0
        && commands.active.data.dynamicUcsConfirmed !== true
        && ownsActiveCommand()
      ) {
        dynamicUcsController.lock();
        commands.active.data.dynamicUcsConfirmed = true;
        log('DUCS plane locked. Select the first measurement point.');
        redraw();
        input.focus();
        event.preventDefault();
        return;
      }
      // The first two steps measure, so they must land on real geometry. Where the
      // dimension line and its text then go is free: those steps take the cursor
      // wherever it is rather than refusing a click that snapped to nothing.
      const placingDimension = commands.active.stepIndex >= 2;
      const point = interactionPoint(event) ?? (placingDimension
        ? (cadDocument.viewMode === '3d' ? worldPoint3d(event) : worldPoint(event))
        : null);
      if (point) {
        const rect = viewport.getBoundingClientRect();
        const sx = event.clientX - rect.left;
        const sy = event.clientY - rect.top;
        if (commands.active.stepIndex === 0) {
          positionMeasureMarker(measureOrigin, sx, sy);
          measureTarget.hidden = true;
        } else if (!placingDimension) {
          positionMeasureMarker(measureTarget, sx, sy);
        }
        const dynamicAnswer = beforeDynamicUcsAnswer();
        await commands.handleClick(point);
        afterDynamicUcsAnswer(dynamicAnswer);
        input.focus();
      } else {
        log('Dimension: move the cursor closer to an endpoint or vertex.');
      }
      event.preventDefault();
      return;
    }
    if (cadDocument.viewMode === '2d') {
      const pointStepKind = commands.active?.steps[commands.active.stepIndex]?.kind;
      const expectsPoint = pointStepKind === 'point' || pointStepKind === 'plane';
      const point = expectsPoint ? interactionPoint(event) ?? worldPoint(event) : worldPoint(event);
      const gripIndex = gripController.nearest2d(rawWorldPoint(event), 10 / renderer2d.zoom);
      const selected = selectedEntity();
      const selectedBody = selectedSolid();
      // Picking asks "what is under the cursor", so it must use the real cursor.
      // `point` is grid-snapped for placing geometry, which would test for a hit
      // at the nearest grid dot instead — only ever landing on snapped endpoints.
      const pickPoint = rawWorldPoint(event);
      const entity = pickEntityAt(cadDocument, pickPoint, 8 / renderer2d.zoom)
        ?? (commands.active?.name === 'EXTRUDE' ? profileContainingPoint(pickPoint) : undefined);
      const solid = hitTestSolid2d(cadDocument, pickPoint, solidSelectionExclusions());
      const action = resolveViewportAction({
        commandActive: Boolean(commands.active),
        multiObjectStep: commands.isMultiObjectStep,
        gripIndex,
        hasSelection: Boolean(selected || selectedBody),
        entityHit: Boolean(entity),
        solidHit: Boolean(solid),
        canWindowSelect: true,
      });

      if (action.kind === 'dragGrip') {
        // A grip's own point is local to the selected entity's work plane, same
        // as its vertices or control points — lift it to world before it
        // becomes the drag's origin, or the delta the drag computes from the
        // (world) cursor position is measured from the wrong place entirely.
        const exactGrip = gripController.activeGrips().find((grip) => grip.index === gripIndex);
        const gripPoint = exactGrip
          ? localToWorld(selected?.workPlane ?? WORLD_WORK_PLANE, exactGrip.point, exactGrip.point.z ?? 0)
          : gripEditingPoint(event);
        if (!gripPoint) return;
        gripInteraction.begin(selected, selectedBody, gripIndex, gripPoint, event.pointerId);
        event.preventDefault();
        return;
      }
      if (action.kind === 'windowSelect') {
        gripController.mode = null;
        selectionController.beginWindow(event, 'select');
        event.preventDefault();
        return;
      }
      if (action.kind === 'commandClick') {
        await drawingInteraction.handleClick(point, entity ?? undefined, solid?.id);
      } else if (action.kind === 'selectEntity' && entity) {
        // Deferred rather than selected outright: a press that turns into a
        // drag becomes a selection window instead, which is the only way to
        // start one from on top of a busy cluster of objects rather than only
        // from empty space.
        if (!cadDocument.selectedEntityIds.has(entity.id)) gripController.mode = null;
        selectionController.beginWindow(event, 'select', { entity, solidId: null });
        event.preventDefault();
        return;
      } else if (action.kind === 'selectSolid' && solid) {
        if (!cadDocument.selectedSolidIds.has(solid.id)) gripController.mode = null;
        selectionController.beginWindow(event, 'select', { entity: null, solidId: solid.id });
        event.preventDefault();
        return;
      }
    } else {
      const activeStep = commands.active?.steps[commands.active.stepIndex];
      if (commands.active?.name === 'DIMANGULAR' && activeStep?.kind === 'entity') {
        const edge = renderer3d.pickSolidEdge(
          renderer3d.renderer.domElement,
          cadDocument.solids.filter((solid) => !cadDocument.hiddenLayers.has(solid.layer)),
          event.clientX,
          event.clientY,
        );
        if (edge) {
          const midpoint = {
            x: (edge.start.x + edge.end.x) / 2,
            y: (edge.start.y + edge.end.y) / 2,
            z: (edge.start.z + edge.end.z) / 2,
          };
          const local = worldToLocal(cadDocument.activeWorkPlane, midpoint);
          await commands.handleClick(local, undefined, undefined, undefined, edge);
        } else {
          const entity = renderer3d.pickEntity(
            renderer3d.renderer.domElement,
            cadDocument.entities.filter((item) => !cadDocument.hiddenLayers.has(item.layer)),
            event.clientX,
            event.clientY,
          );
          if (entity?.type === 'line') {
            await commands.handleClick(worldPoint3d(event) ?? { x: 0, y: 0 }, entity);
          } else {
            log('Angular dimension: select a straight line or solid edge, or press Enter for three points.');
          }
        }
        renderer3d.clearEdgeHighlight();
        input.focus();
        event.preventDefault();
        return;
      }
      if ((commands.active?.name === 'DIMRADIUS' || commands.active?.name === 'DIMDIAMETER') && activeStep?.kind === 'entity') {
        const edge = renderer3d.pickCircularSolidEdge(
          renderer3d.renderer.domElement,
          cadDocument.solids.filter((solid) => !cadDocument.hiddenLayers.has(solid.layer)),
          event.clientX,
          event.clientY,
        );
        if (edge) {
          await commands.handleClick({ x: 0, y: 0 }, undefined, undefined, undefined, edge);
        } else {
          const entity = renderer3d.pickEntity(
            renderer3d.renderer.domElement,
            cadDocument.entities.filter((item) => !cadDocument.hiddenLayers.has(item.layer)),
            event.clientX,
            event.clientY,
          );
          if (entity?.type === 'circle' || entity?.type === 'arc') {
            await commands.handleClick({ x: 0, y: 0 }, entity);
          } else {
            log('Dimension: select a circle, arc, or circular solid edge.');
          }
        }
        renderer3d.clearEdgeHighlight();
        input.focus();
        event.preventDefault();
        return;
      }
      if (commands.active?.name === 'THREAD' && activeStep?.kind === 'entity') {
        const edge = renderer3d.pickCircularSolidEdge(
          renderer3d.renderer.domElement,
          cadDocument.solids.filter((solid) => !cadDocument.hiddenLayers.has(solid.layer)),
          event.clientX,
          event.clientY,
        );
        if (edge) {
          await commands.handleClick({ x: 0, y: 0 }, undefined, undefined, undefined, edge);
        } else {
          const entity = renderer3d.pickEntity(
            renderer3d.renderer.domElement,
            cadDocument.entities.filter((item) => !cadDocument.hiddenLayers.has(item.layer)),
            event.clientX,
            event.clientY,
          );
          if (entity?.type === 'circle' || entity?.type === 'arc') {
            await commands.handleClick(worldPoint3d(event) ?? { x: 0, y: 0 }, entity);
          } else {
            log('Thread: select a circular hole/shaft edge, or a circle.');
          }
        }
        renderer3d.clearEdgeHighlight();
        input.focus();
        event.preventDefault();
        return;
      }
      if ((commands.active?.name === 'CHAMFER' || commands.active?.name === 'FILLET') && activeStep?.kind === 'entity') {
        // The first step takes either a solid edge (3D) or a 2D line/polyline
        // side (corner chamfer/fillet); the second step takes only the other side.
        const acceptsEdge = activeStep.accepts?.includes('edge');
        const edge = acceptsEdge ? (renderer3d.pickCircularSolidEdge(
          renderer3d.renderer.domElement,
          cadDocument.solids,
          event.clientX,
          event.clientY,
        ) ?? renderer3d.pickSolidEdge(
          renderer3d.renderer.domElement,
          cadDocument.solids,
          event.clientX,
          event.clientY,
        )) : null;
        if (edge) {
          await commands.handleClick({ x: 0, y: 0 }, undefined, undefined, undefined, edge);
        } else {
          const entity = renderer3d.pickEntity(
            renderer3d.renderer.domElement,
            cadDocument.entities.filter((item) => !cadDocument.hiddenLayers.has(item.layer)),
            event.clientX,
            event.clientY,
          );
          if (entity?.type === 'line' || entity?.type === 'polyline') {
            await commands.handleClick(worldPoint3d(event) ?? { x: 0, y: 0 }, entity);
          } else {
            log(acceptsEdge ? `${commands.active.name}: select a solid edge, a 2D line, or a polyline.` : 'Select a second 2D side.');
          }
        }
        renderer3d.clearEdgeHighlight();
        input.focus();
        event.preventDefault();
        return;
      }
      if (commands.active?.name === 'MOVE' && activeStep?.kind === 'entity') {
        const entity = renderer3d.pickEntity(
          renderer3d.renderer.domElement,
          cadDocument.entities.filter((item) => !cadDocument.hiddenLayers.has(item.layer)),
          event.clientX,
          event.clientY,
        );
        const solidId = renderer3d.pickSolid(
          renderer3d.renderer.domElement,
          event.clientX,
          event.clientY,
          solidSelectionExclusions()
        );
        await commands.handleClick({ x: 0, y: 0 }, entity ?? undefined, solidId ?? undefined);
        input.focus();
        return;
      }
      if (canAcquireDynamicUcs()) {
        const dynamicClickFace = renderer3d.pickSolidFace(
          renderer3d.renderer.domElement,
          event.clientX,
          event.clientY,
          cadDocument.solids,
          cadDocument.entities.filter((item) => !cadDocument.hiddenLayers.has(item.layer)),
        );
        if (dynamicClickFace) acquireDynamicUcs(dynamicClickFace, event);
        else releaseDynamicUcs();
      }
      const point = interactionPoint(event);
      if (commands.active?.name === 'MOVE' && activeStep?.kind === 'point') {
        if (!point) return;
        await commands.handleClick(point);
        if (!commands.active) previewController.clearPreview();
        input.focus();
        return;
      }
      const pickPoint = rawWorldPoint3d(event);
      const gripIndex = renderer3d.pickGripIndex(
        renderer3d.renderer.domElement,
        activeGripsInWorld(),
        event.clientX,
        event.clientY
      );
      const selected = selectedEntity();
      const selectedBody = selectedSolid();
      if (grabsGrip({
        commandActive: Boolean(commands.active),
        gripIndex,
        hasSelection: Boolean(selected || selectedBody),
      })) {
        const exactGrip = gripController.activeGrips().find((grip) => grip.index === gripIndex);
        const gripPoint = exactGrip ? { x: exactGrip.point.x, y: exactGrip.point.y } : gripEditingPoint(event);
        if (!gripPoint) return;
        gripInteraction.begin(selected, selectedBody, gripIndex, gripPoint, event.pointerId);
        event.preventDefault();
        return;
      }
      const entity = renderer3d.pickEntity(
        renderer3d.renderer.domElement,
        cadDocument.entities.filter((item) => !cadDocument.hiddenLayers.has(item.layer)),
        event.clientX,
        event.clientY,
      ) ?? (commands.active?.name === 'EXTRUDE' && pickPoint ? profileContainingPoint(pickPoint) : undefined);
      const solidId = renderer3d.pickSolid(
        renderer3d.renderer.domElement,
        event.clientX,
        event.clientY,
        solidSelectionExclusions()
      );
      const choosingSlicePlane = commands.active?.name === 'SLICE' && activeStep?.kind === 'plane';
      // A requested or persistent object snap means the click is the first of
      // three plane points. Away from a snap, clicking the face interior chooses
      // that whole planar face instead, so the two input methods do not fight.
      const slicePointSnap = choosingSlicePlane
        ? (drawingInteraction.targetSnapMode
          ? nearestGripTargetSnap(event, drawingInteraction.targetSnapMode)
          : nearestPersistentSnap(event)) ?? nearestMeasurementPoint(event)
        : null;
      let face = commands.active?.name === 'PRESSPULL'
        || commands.active?.name === 'DELETEFACE'
        || (choosingSlicePlane && !slicePointSnap)
        ? renderer3d.pickSolidFace(
          renderer3d.renderer.domElement,
          event.clientX,
          event.clientY,
          cadDocument.solids,
          cadDocument.entities.filter((item) => !cadDocument.hiddenLayers.has(item.layer)),
        )
        : null;
      // Delete Face can also remove a hole or bump, whose face need not be
      // planar. If no planar face was hit, still hand it the raw surface point.
      if (!face && commands.active?.name === 'DELETEFACE') {
        const hit = renderer3d.pickSolidSurfacePoint(
          renderer3d.renderer.domElement,
          event.clientX,
          event.clientY,
          cadDocument.solids,
        );
        if (hit) face = {
          solidId: hit.solidId,
          topologyFaceId: hit.topologyFaceId,
          vertexIndices: [],
          normal: hit.normal,
          hitPoint: hit.hitPoint,
        };
      }
      const action = resolveViewportAction({
        commandActive: Boolean(commands.active),
        multiObjectStep: commands.isMultiObjectStep,
        gripIndex,
        hasSelection: Boolean(selected || selectedBody),
        entityHit: Boolean(entity),
        solidHit: Boolean(solidId),
        canWindowSelect: true,
      });

      if (action.kind === 'windowSelect') {
        // The 3D picker resolves an empty press to the same window-selection
        // action as 2D. It still has to start the shared drag controller here;
        // otherwise the resolved action is silently discarded and no rectangle
        // appears while the pointer moves.
        gripController.mode = null;
        selectionController.beginWindow(event, 'select');
        event.preventDefault();
        return;
      }
      if (action.kind === 'commandClick') {
        if ((activeStep?.kind === 'point' || activeStep?.kind === 'plane') && !point && !face) return;
        const dynamicAnswer = beforeDynamicUcsAnswer();
        await drawingInteraction.handleClick(point ?? { x: 0, y: 0 }, entity ?? undefined, solidId ?? undefined, face ?? undefined);
        afterDynamicUcsAnswer(dynamicAnswer);
      } else if (action.kind === 'selectEntity' || action.kind === 'selectSolid') {
        // Same deferral as the 2D view: let a drag from here become a
        // selection window instead of committing to this hit immediately.
        selectionController.beginWindow(event, 'select', { entity: entity ?? null, solidId: solidId ?? null });
        event.preventDefault();
        return;
      } else if (action.kind === 'clearSelection') {
        cadDocument.clearSelection();
      }
    }
    if (!commands.active || commands.active.stepIndex === 0) previewController.clearPreview();
    input.focus();
  });

  viewport.addEventListener('dblclick', (event) => {
    if ((event.target as HTMLElement).closest('.mtext-editor')) return;
    if (commands.active) return;
    const text = cadDocument.viewMode === '2d'
      ? pickEntityAt(cadDocument, rawWorldPoint(event), 8 / renderer2d.zoom)
      : renderer3d.pickEntity(
        renderer3d.renderer.domElement,
        cadDocument.entities.filter((entity) => !cadDocument.hiddenLayers.has(entity.layer)),
        event.clientX,
        event.clientY,
      );
    if (text?.type === 'text') {
      cadDocument.clearSelection();
      cadDocument.selectEntity(text.id);
      commands.startCommand('TEXTEDIT');
      event.preventDefault();
      return;
    }
    if (cadDocument.viewMode !== '3d') return;
    const handle = renderer3d.pickUcsHandle(renderer3d.renderer.domElement, event.clientX, event.clientY);
    if (!handle) return;
    ucsHandlesArmed = true;
    renderer3d.showUcsHandles(true, handle);
    log('UCS grips active. Drag a square grip; Escape hides them.');
    event.preventDefault();
  });

  window.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || !ucsHandlesArmed) return;
    ucsHandlesArmed = false;
    if (ucsAxisDrag?.changed) {
      const plane = ucsAxisDrag.basePlane;
      cadDocument.activeWorkPlane = plane;
      const named = cadDocument.namedWorkPlanes.find((item) => item.id === cadDocument.activeNamedWorkPlaneId);
      if (named) named.workPlane = {
        ...plane,
        origin: { ...plane.origin },
        xAxis: { ...plane.xAxis },
        yAxis: { ...plane.yAxis },
        zAxis: { ...plane.zAxis },
      };
      renderer3d.setWorkPlane(plane);
    }
    ucsAxisDrag = null;
    renderer3d.showUcsHandles(false);
    snapMarker.hidden = true;
    event.preventDefault();
    redraw();
  }, { capture: true });

  window.addEventListener('pointerup', (event) => {
    if (ucsAxisDrag) {
      if (viewport.hasPointerCapture(event.pointerId)) viewport.releasePointerCapture(event.pointerId);
      return;
    }
    if (selectionController.finishWindow(event.pointerId)) return;
    // A right-button press that never moved was a click, not a pan, so it opens
    // the menu. Deciding on the movement is what lets a pan start anywhere.
    const wasStillPress = menuOnStillRelease && navigation.isPanning && navigation.panDistance < 4;
    menuOnStillRelease = false;
    navigation.endPan(event.pointerId);
    if (wasStillPress) openContextMenu(event);
    gripInteraction.commitIfNotLatched();
    if (!gripController.isDragging) pointerState.activeEndpointAnchor = null;
    if (viewport.hasPointerCapture(event.pointerId)) viewport.releasePointerCapture(event.pointerId);
  });
}
