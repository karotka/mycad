import './styles/app.css';
import { document as cadDocument } from './core/Document';
import { CommandManager, hitTestEntity, type CommandName } from './core/commands/CommandManager';
import { takesPointInput, transformsObjects } from './core/commands/registry';
import { cloneEntity, curvePoints, entityBounds, transformEntityPoints, type Entity, type Solid, type SolidFeature } from './core/entities/types';
import { CommandHistory } from './core/history/CommandHistory';
import { CompositeEdit, ReplaceObjectsEdit, UpdateEntityEdit, UpdateSolidEdit, cloneSolid } from './core/history/edits';
import type { DocumentEdit } from './core/history/CommandHistory';
import { snapPoint2, worldToScreen, type Vec2 } from './math/geometry';
import { cloneWorkPlane, localToWorld, WORLD_WORK_PLANE, worldToLocal } from './math/workplane';
import { Canvas2DRenderer } from './render/Canvas2DRenderer';
import { Viewport3D } from './render/Viewport3D';
import { hitTestSolid2d, pickEntityAt, selectionExclusions, solidBounds } from './interaction/PickingService';
import { InputController } from './interaction/InputController';
import { GripController, type GripMode } from './interaction/GripController';
import type { ProjectViewState } from './io/ProjectIO';
import { LayerController } from './ui/LayerController';
import { WindowDragController } from './interaction/WindowDragController';
import { measurementCandidates, nearestCandidate2d, nearestCandidateProjected, objectSnapCandidates, type ObjectSnapMode, type SnapTarget } from './interaction/SnapService';
import { ViewportNavigationController } from './interaction/ViewportNavigationController';
import { PreviewController } from './ui/PreviewController';
import { ProjectController } from './ui/ProjectController';
import { SelectionController } from './interaction/SelectionController';
import { GripInteractionController } from './interaction/GripInteractionController';
import { DrawingInteractionController } from './interaction/DrawingInteractionController';
import { PropertiesController } from './ui/PropertiesController';
import { DimensionStyleController } from './ui/DimensionStyleController';
import { DraftingSettingsController } from './ui/DraftingSettingsController';
import {
  arrayFlyout, circleFlyout, circleTools, dimensionFlyout, dimensionTools, drawTools, editTools,
  extrudeFlyout, modifyTools, primitiveFlyout, primitiveTools, solidTools, toolButtons, zoomFlyout, zoomTools,
} from './ui/toolbar';
import { toolIcon } from './ui/toolIcons';
import { shellHtml } from './ui/shell';
import { resolveDraftingPoint } from './interaction/DraftingService';
import { resolvePointerGesture } from './interaction/PointerGesture';

const app = document.querySelector<HTMLDivElement>('#app');
if (!app) throw new Error('Missing #app element');

const savedPrimitive = localStorage.getItem('mycad.lastPrimitive') as CommandName | null;
let currentPrimitive: CommandName = primitiveTools.some(([, command]) => command === savedPrimitive) ? savedPrimitive! : 'BOX';
const savedCircle = localStorage.getItem('mycad.lastCircle') as CommandName | null;
let currentCircle: CommandName = circleTools.some(([, , command]) => command === savedCircle) ? savedCircle! : 'CIRCLE';
const savedDimension = localStorage.getItem('mycad.lastDimension') as CommandName | null;
let currentDimension: CommandName = dimensionTools.some(([, , command]) => command === savedDimension) ? savedDimension! : 'MEASURE';
const savedZoom = localStorage.getItem('mycad.lastZoom') as 'ZOOM_ALL' | 'ZOOM_WINDOW' | null;
let currentZoom: 'ZOOM_ALL' | 'ZOOM_WINDOW' = zoomTools.some(([, action]) => action === savedZoom) ? savedZoom! : 'ZOOM_ALL';

app.innerHTML = shellHtml({
  primitive: currentPrimitive,
  circle: currentCircle,
  dimension: currentDimension,
  zoom: currentZoom,
});

const viewport = get<HTMLElement>('viewport');
const canvas2d = get<HTMLCanvasElement>('canvas2d');
const viewport3dHost = get<HTMLElement>('viewport3d');
const input = get<HTMLInputElement>('command-input');
const commandForm = get<HTMLFormElement>('command-form');
const commandSuggestionsElement = get<HTMLElement>('command-suggestions');
const prompt = get<HTMLElement>('command-prompt');
const logElement = get<HTMLElement>('command-log');
const commandResizeHandle = get<HTMLElement>('command-resize-handle');
const coords = get<HTMLElement>('coords');
const crosshair = get<HTMLElement>('crosshair');
const selectionWindowElement = get<HTMLElement>('selection-window');
const measureOrigin = get<HTMLElement>('measure-origin');
const measureTarget = get<HTMLElement>('measure-target');
const snapMarker = get<HTMLElement>('snap-marker');
const trackingLine = get<HTMLElement>('tracking-line');
const gripMenu = get<HTMLElement>('grip-menu');
const dimensionToast = get<HTMLElement>('dimension-toast');
const textOptions = get<HTMLElement>('text-options');
const textFont = get<HTMLSelectElement>('text-font');
const textHeight = get<HTMLInputElement>('text-height');
const layerPanel = get<HTMLElement>('layer-panel');
const layerList = get<HTMLElement>('layer-list');
const propertiesPanel = get<HTMLElement>('properties-panel');
const renderer2d = new Canvas2DRenderer(canvas2d);
const renderer3d = new Viewport3D(viewport3dHost);
renderer3d.setWorkPlane(cadDocument.activeWorkPlane);
renderer3d.attachControls(viewport, enter3dForOrbit);
const previewController = new PreviewController(
  dimensionToast,
  measureOrigin,
  measureTarget,
  snapMarker,
  (point) => cadDocument.viewMode === '3d'
    ? renderer3d.projectCadPoint(renderer3d.renderer.domElement, point)
    : null,
  (delta) => cadDocument.viewMode === '3d' ? renderer3d.screenDeltaToCad(delta) : undefined,
);
const navigation = new ViewportNavigationController(
  cadDocument,
  viewport,
  renderer2d,
  renderer3d,
  { enter3dForOrbit, redraw },
);
const history = new CommandHistory(cadDocument);
const gripController = new GripController(cadDocument, history);
const gripInteraction = new GripInteractionController(gripController, viewport);
const windowDrag = new WindowDragController(viewport, selectionWindowElement);
const selectionController = new SelectionController(
  cadDocument,
  viewport,
  renderer2d,
  renderer3d,
  windowDrag,
  {
    viewportSize: () => ({ width, height }),
    selectionChanged: () => {
      gripController.mode = null;
      gripController.hoveredGrip = -1;
      commands?.syncWindowSelection();
    },
    zoomFinished: () => {
      zoomWindowMode = false;
      document.querySelector<HTMLButtonElement>('[data-view-action="zoom-window"]')?.classList.remove('active');
      prompt.textContent = 'Command:';
    },
    redraw,
  },
);
const layerController = new LayerController(
  cadDocument,
  history,
  layerPanel,
  layerList,
  get('layer-current'),
  get('layer-toggle'),
  get('layer-add'),
  { log, redraw, objectsDeleted: () => gripController.clear() },
);
const propertiesController = new PropertiesController(
  cadDocument,
  history,
  propertiesPanel,
  get('properties-content'),
  get('properties-toggle'),
  get('properties-close'),
  redraw,
);
const draftingSettingsController = new DraftingSettingsController(
  cadDocument,
  get('drafting-settings-panel'),
  get<HTMLFormElement>('drafting-settings-form'),
  get('drafting-settings-toggle'),
  get('drafting-settings-close'),
  redraw,
);
const dimensionStyleController = new DimensionStyleController(
  cadDocument,
  get('dimension-style-panel'),
  get<HTMLFormElement>('dimension-style-form'),
  get('dimension-style-toggle'),
  get('dimension-style-close'),
  redraw,
);

let width = 1;
let height = 1;
let ucsHoverPoint: { x: number; y: number; z: number } | null = null;
/** Set by a right-button press: a release that never moved opens the menu. */
let menuOnStillRelease = false;
let zoomWindowMode = false;
let currentSuggestions: CommandName[] = [];
let activeTracking: { base: Vec2; point: Vec2; angle: number } | null = null;
let activeEndpointAnchor: Vec2 | null = null;

function enter3dForOrbit(): void {
  if (cadDocument.viewMode === '3d') return;
  renderer3d.frameContent(cadDocument.entities, cadDocument.solids);
  cadDocument.viewMode = '3d';
  cadDocument.notify();
}

function captureProjectView(): ProjectViewState {
  return {
    mode: cadDocument.viewMode,
    twoD: { pan: { ...renderer2d.pan }, zoom: renderer2d.zoom },
    threeD: renderer3d.captureViewState(),
  };
}
let commandResize: { startY: number; startHeight: number; pointerId: number } | null = null;

commandResizeHandle.addEventListener('pointerdown', (event) => {
  const panel = commandResizeHandle.parentElement as HTMLElement;
  commandResize = { startY: event.clientY, startHeight: panel.getBoundingClientRect().height, pointerId: event.pointerId };
  commandResizeHandle.setPointerCapture(event.pointerId);
  document.body.classList.add('resizing-command-panel');
  event.preventDefault();
});

commandResizeHandle.addEventListener('pointermove', (event) => {
  if (!commandResize || event.pointerId !== commandResize.pointerId) return;
  const nextHeight = Math.max(58, Math.min(window.innerHeight * 0.6, commandResize.startHeight + commandResize.startY - event.clientY));
  app.style.setProperty('--command-panel-height', `${nextHeight}px`);
});

commandResizeHandle.addEventListener('pointerup', (event) => {
  if (!commandResize || event.pointerId !== commandResize.pointerId) return;
  commandResize = null;
  document.body.classList.remove('resizing-command-panel');
  commandResizeHandle.releasePointerCapture(event.pointerId);
});
let suggestionIndex = 0;

function get<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing #${id}`);
  return element as T;
}

function updateCommandSuggestions(): void {
  currentSuggestions = commands.active ? [] : commands.commandSuggestions(input.value);
  suggestionIndex = Math.min(suggestionIndex, Math.max(0, currentSuggestions.length - 1));
  commandSuggestionsElement.replaceChildren(...currentSuggestions.map((command, index) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = command;
    button.classList.toggle('active', index === suggestionIndex);
    button.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      input.value = '';
      commands.startCommand(command);
      commandSuggestionsElement.hidden = true;
      redraw();
      input.focus();
    });
    return button;
  }));
  commandSuggestionsElement.hidden = currentSuggestions.length === 0;
}

function log(message: string): void {
  const line = document.createElement('div');
  line.textContent = message;
  logElement.appendChild(line);
  logElement.scrollTop = logElement.scrollHeight;
}

function redraw(): void {
  const is2d = cadDocument.viewMode === '2d';
  const activeStepKind = commands.active?.steps[commands.active.stepIndex]?.kind;
  const isObjectPick = activeStepKind === 'entity' || activeStepKind === 'solid' || activeStepKind === 'edge';
  canvas2d.style.display = is2d ? 'block' : 'none';
  viewport3dHost.style.display = is2d ? 'none' : 'block';
  // The native cursor is hidden over the viewport, so the software CAD cursor
  // must remain visible in both 2D and 3D for selection and point input.
  crosshair.style.display = 'block';
  viewport.classList.toggle('object-pick', isObjectPick);
  if (is2d) {
    const grips = gripController.visibleGrips().map((grip) => ({
      point: grip.point,
      shape: grip.shape,
      angle: grip.angle,
      hot: grip.index === gripController.hoveredGrip,
    }));
    renderer2d.render(cadDocument, width, height, previewController.preview, grips, commands.active?.name === 'JOIN');
  }
  else {
    const grips = visibleGripsInWorld().map((grip) => ({
      point: grip.point,
      shape: grip.shape,
      hot: grip.index === gripController.hoveredGrip,
    }));
    const visibleEntities = cadDocument.entities.filter((entity) => !cadDocument.hiddenLayers.has(entity.layer));
    const visibleSolids = cadDocument.solids.filter((solid) => !cadDocument.hiddenLayers.has(solid.layer));
    renderer3d.syncEntities(visibleEntities);
    renderer3d.syncPreview(previewController.preview);
    renderer3d.syncGrips(grips);
    renderer3d.syncSolids(visibleSolids);
    renderer3d.render();
  }
  get('view-status').textContent = renderer3d.activeStandardView?.toUpperCase()
    ?? cadDocument.viewMode.toUpperCase();
  get('snap-status').textContent = cadDocument.snapEnabled
    ? `SNAP: ${cadDocument.snapSize} mm · GRID: ${cadDocument.gridSize} mm`
    : `SNAP: OFF · GRID: ${cadDocument.gridSize} mm`;
  get<HTMLButtonElement>('osnap-toggle').classList.toggle('active', cadDocument.drafting.objectSnapEnabled);
  get<HTMLButtonElement>('ortho-toggle').classList.toggle('active', cadDocument.drafting.orthoEnabled);
  get<HTMLButtonElement>('polar-toggle').classList.toggle('active', cadDocument.drafting.polarEnabled);
  get<HTMLButtonElement>('snap-toggle').classList.toggle('active', cadDocument.snapEnabled);
  get<HTMLButtonElement>('otrack-toggle').classList.toggle('active', cadDocument.drafting.objectSnapTrackingEnabled);
  document.querySelectorAll<HTMLButtonElement>('[data-command]').forEach((button) => {
    button.classList.toggle('active', button.dataset.command === commands.active?.name);
  });
  get<HTMLButtonElement>('primitive-main').classList.toggle('active', primitiveTools.some(([, command]) => command === commands.active?.name));
  get<HTMLButtonElement>('array-main').classList.toggle('active', commands.active?.name === 'ARRAY_RECTANGULAR' || commands.active?.name === 'ARRAY_POLAR');
  get<HTMLButtonElement>('extrude-main').classList.toggle('active', commands.active?.name === 'EXTRUDE' || commands.active?.name === 'SWEEP');
  get<HTMLButtonElement>('circle-main').classList.toggle('active', circleTools.some(([, , command]) => command === commands.active?.name));
  get<HTMLButtonElement>('dimension-main').classList.toggle('active', dimensionTools.some(([, command]) => command === commands.active?.name));
  get<HTMLButtonElement>('zoom-main').classList.toggle('active', zoomWindowMode);
  updateViewCubeOrientation();
  prompt.textContent = commands.currentPrompt();
}

function visibleGripsInWorld(): Array<{ point: Vec2 & { z?: number }; index: number; shape?: 'square' | 'edge' }> {
  const entity = cadDocument.getSelectedEntities()[0];
  return gripController.visibleGrips().map((grip) => ({
    ...grip,
    point: entity
      ? localToWorld(entity.workPlane ?? WORLD_WORK_PLANE, grip.point, grip.point.z ?? 0)
      : grip.point,
  }));
}

function activeGripsInWorld(): Array<{ point: Vec2 & { z?: number }; index: number; shape?: 'square' | 'edge' }> {
  const entity = cadDocument.getSelectedEntities()[0];
  return gripController.activeGrips().map((grip) => ({
    ...grip,
    point: entity
      ? localToWorld(entity.workPlane ?? WORLD_WORK_PLANE, grip.point, grip.point.z ?? 0)
      : grip.point,
  }));
}

function gripEditingPoint(
  event: Pick<PointerEvent, 'clientX' | 'clientY'>,
  snap?: GripSnapTarget | null,
  endpointAnchor: Vec2 | null = null,
): Vec2 | null {
  const entity = selectedEntity();
  if (cadDocument.viewMode === '3d' && entity) {
    const plane = entity.workPlane ?? WORLD_WORK_PLANE;
    if (snap) {
      const local = worldToLocal(plane, snap.world);
      return { x: local.x, y: local.y };
    }
    return renderer3d.workPlanePoint(renderer3d.renderer.domElement, event.clientX, event.clientY, plane);
  }
  return resolvePoint(
    worldPoint(event),
    gripController.isDragging ? gripController.draggingOrigin : null,
    gripController.endpointBase(endpointAnchor),
    snap?.point ?? null,
  );
}

function updateViewCubeOrientation(): void {
  const plane = cadDocument.activeWorkPlane;
  const yaw = Math.atan2(plane.xAxis.y, plane.xAxis.x) * 180 / Math.PI;
  const pitch = Math.asin(Math.max(-1, Math.min(1, plane.xAxis.z))) * 180 / Math.PI;
  const roll = Math.asin(Math.max(-1, Math.min(1, plane.yAxis.z))) * 180 / Math.PI;
  const cube = get<HTMLElement>('view-cube');
  cube.style.transform = `perspective(180px) rotateZ(${-yaw}deg) rotateX(${pitch * 0.55}deg) rotateY(${-roll * 0.55}deg)`;
  cube.classList.toggle('ucs-oriented', Math.abs(yaw) + Math.abs(pitch) + Math.abs(roll) > 0.01);
}

const commands = new CommandManager({
  doc: cadDocument,
  history,
  moveObjects,
  copyWorldDelta: (delta) => cadDocument.viewMode === '3d' ? renderer3d.screenDeltaToCad(delta) : undefined,
  workPlaneChanged: () => renderer3d.setWorkPlane(cadDocument.activeWorkPlane),
  log,
  prompt: (message) => {
    prompt.textContent = message;
    queueMicrotask(syncTextOptions);
  },
  getCursor: () => {
    const cursor = navigation.cursor;
    return renderer2d.screenToWorld(cursor.x, cursor.y, width, height);
  },
  redraw,
});
const drawingInteraction = new DrawingInteractionController(commands);

const projectController = new ProjectController(cadDocument, history, {
  captureView: captureProjectView,
  cancelInteraction: () => {
    commands.cancelActive();
    gripInteraction.cancel();
    gripController.clear();
    previewController.reset();
  },
  resetView: () => {
    renderer2d.pan = { x: 0, y: 0 };
    renderer2d.zoom = 20;
    renderer3d.clearFaceHighlight();
    renderer3d.clearEdgeHighlight();
    renderer3d.setWorkPlane(cadDocument.activeWorkPlane);
    renderer3d.frameContent([], []);
  },
  applyView: (view) => {
    renderer3d.setWorkPlane(cadDocument.activeWorkPlane);
    if (!view) return;
    renderer2d.pan = { ...view.twoD.pan };
    renderer2d.zoom = view.twoD.zoom;
    renderer3d.restoreViewState(view.threeD);
  },
  zoomExtents: () => renderer2d.zoomExtents(cadDocument, width, height),
  renderLayers: () => layerController.render(),
  log,
  clearLog: () => logElement.replaceChildren(),
  redraw,
  focusInput: () => input.focus(),
});

/** The native menu owns these on Electron; each maps to an action the app already had. */
const menuActions: Record<string, () => void> = {
  new: () => projectController.newProject(),
  open: () => { void projectController.open(); },
  'import-dxf': () => { void projectController.importDxf(); },
  save: () => { void projectController.quickSave(); },
  'save-as': () => { void projectController.saveAs(); },
  'export-stl': () => { void projectController.exportStl(); },
  undo: () => { log(history.undo() ? 'Undo complete.' : 'Nothing to undo.'); redraw(); },
  redo: () => { log(history.redo() ? 'Redo complete.' : 'Nothing to redo.'); redraw(); },
};

const removeMenuListener = window.mycadEvents?.onMenuAction((action) => {
  menuActions[action]?.();
});

function syncTextOptions(): void {
  const selectingStyle = commands.active?.name === 'TEXT' && commands.active.stepIndex < 2;
  textOptions.hidden = !selectingStyle;
}

get<HTMLButtonElement>('text-options-continue').addEventListener('click', async () => {
  if (commands.active?.name !== 'TEXT' || commands.active.stepIndex >= 2) return;
  const height = Number(textHeight.value);
  if (!Number.isFinite(height) || height <= 0) {
    textHeight.focus();
    return;
  }
  if (commands.active.stepIndex === 0) await commands.submitInput(textFont.value);
  if (commands.active?.name === 'TEXT' && commands.active.stepIndex === 1) await commands.submitInput(String(height));
  syncTextOptions();
  redraw();
  input.focus();
});

function worldPoint(event: Pick<PointerEvent, 'clientX' | 'clientY'>): Vec2 {
  const raw = rawWorldPoint(event);
  return cadDocument.snapEnabled ? snapPoint2(raw, cadDocument.snapSize) : raw;
}

function rawWorldPoint(event: Pick<PointerEvent, 'clientX' | 'clientY'>): Vec2 {
  const rect = viewport.getBoundingClientRect();
  return renderer2d.screenToWorld(event.clientX - rect.left, event.clientY - rect.top, width, height);
}

function worldPoint3d(event: Pick<PointerEvent, 'clientX' | 'clientY'>): Vec2 | null {
  const raw = rawWorldPoint3d(event);
  if (!raw) return null;
  return cadDocument.snapEnabled ? snapPoint2(raw, cadDocument.snapSize) : raw;
}

function rawWorldPoint3d(event: Pick<PointerEvent, 'clientX' | 'clientY'>): Vec2 | null {
  return renderer3d.workPlanePoint(renderer3d.renderer.domElement, event.clientX, event.clientY);
}

function interactionPoint(event: Pick<PointerEvent, 'clientX' | 'clientY'>): Vec2 | null {
  activeTracking = null;
  const active = commands.active;
  // Tools that place new geometry: they snap, but have no object to track.
  const drawing = active && takesPointInput(active.name) && !transformsObjects(active.name)
    && active.steps[active.stepIndex]?.kind === 'point';
  if (drawing) {
    const targetedSnap = drawingInteraction.targetSnapMode
      ? nearestGripTargetSnap(event, drawingInteraction.targetSnapMode)
      : nearestPersistentSnap(event);
    if (targetedSnap) {
      // Resting on an endpoint acquires it, so moving off it can then track
      // along its alignment path rather than losing it.
      const acquired = endpointAnchorFromSnap(targetedSnap);
      if (acquired) activeEndpointAnchor = acquired;
      return targetedSnap.point;
    }
  }
  if (active && transformsObjects(active.name) && active.steps[active.stepIndex]?.kind === 'point') {
    const targetedSnap = drawingInteraction.targetSnapMode
      ? nearestGripTargetSnap(event, drawingInteraction.targetSnapMode)
      : nearestPersistentSnap(event);
    if (targetedSnap) {
      if (active.name === 'MOVE' || active.name === 'COPY' || active.name === 'SCALE') active.data.pendingMoveWorldPoint = targetedSnap.world;
      return (active.name === 'MOVE' || active.name === 'COPY') && cadDocument.viewMode === '3d'
        ? renderer3d.cadPointToViewPlane(targetedSnap.world)
        : targetedSnap.point;
    }
    if (active.name === 'MOVE' || active.name === 'COPY' || active.name === 'SCALE') delete active.data.pendingMoveWorldPoint;
  }
  if (cadDocument.viewMode === '2d') return constrainedPoint(worldPoint(event));
  const step = commands.active?.steps[commands.active.stepIndex];
  if ((commands.active?.name === 'MOVE' || commands.active?.name === 'COPY') && step?.kind === 'point') {
    const point = renderer3d.viewPlanePoint(renderer3d.renderer.domElement, event.clientX, event.clientY);
    const snapped = point && cadDocument.snapEnabled ? snapPoint2(point, cadDocument.snapSize) : point;
    return snapped ? constrainedPoint(snapped) : null;
  }
  const point = worldPoint3d(event);
  return point ? constrainedPoint(point) : null;
}

function draftingBasePoint(): Vec2 | null {
  const active = commands.active;
  const step = active?.steps[active.stepIndex];
  if (!active || step?.kind !== 'point') return null;
  // A corner has no direction to constrain: Ortho would collapse the shape.
  if (step.corner) return null;
  const value = active.name === 'BEZIER'
    ? active.data.control2 ?? active.data.control1 ?? active.data.start
    : active.data.basePoint ?? active.data.start ?? active.data.center;
  return value && typeof value === 'object' && 'x' in value && 'y' in value ? value as Vec2 : null;
}

function constrainedPoint(point: Vec2, baseOverride: Vec2 | null = null): Vec2 {
  return resolvePoint(point, baseOverride ?? draftingBasePoint(), activeEndpointAnchor, null);
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
    settings: cadDocument.drafting,
    captureDistance: 8 / renderer2d.zoom,
  });
  activeTracking = resolved.guide
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
  const candidates = objectSnapCandidates(cadDocument, 'end', excluded);
  return candidates.some((candidate) => samePoint3d(candidate.world, snap.world)) ? snap.point : null;
}

function updateTrackingGuide(): void {
  if (!activeTracking) {
    trackingLine.hidden = true;
    return;
  }
  let start: Vec2 | null;
  let end: Vec2 | null;
  if (cadDocument.viewMode === '2d') {
    start = worldToScreen(activeTracking.base, width, height, renderer2d.pan, renderer2d.zoom);
    end = worldToScreen(activeTracking.point, width, height, renderer2d.pan, renderer2d.zoom);
  } else {
    start = renderer3d.projectCadPoint(renderer3d.renderer.domElement, localToWorld(cadDocument.activeWorkPlane, activeTracking.base));
    end = renderer3d.projectCadPoint(renderer3d.renderer.domElement, localToWorld(cadDocument.activeWorkPlane, activeTracking.point));
  }
  if (!start || !end) { trackingLine.hidden = true; return; }
  const dx = end.x - start.x, dy = end.y - start.y;
  trackingLine.style.left = `${start.x}px`;
  trackingLine.style.top = `${start.y}px`;
  trackingLine.style.width = `${Math.hypot(dx, dy)}px`;
  trackingLine.style.transform = `rotate(${Math.atan2(dy, dx)}rad)`;
  trackingLine.hidden = false;
}

/** The edit that moves one object, without running it — so many can share a step. */
function moveObjectEdit(
  object: Entity | string,
  delta: { x: number; y: number; z: number },
  snapped: boolean,
): DocumentEdit | null {
  if (typeof object !== 'string') {
    const before = cloneEntity(object);
    let after: Entity;
    if (cadDocument.viewMode === '3d') {
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
  const solid = cadDocument.getSolid(object);
  if (!solid) return null;
  const before = cloneSolid(solid);
  const after = cloneSolid(solid);
  for (let i = 0; i < after.mesh.positions.length; i += 3) {
    after.mesh.positions[i] += delta.x;
    after.mesh.positions[i + 1] += delta.y;
    after.mesh.positions[i + 2] += delta.z;
  }
  translateFeature(after.feature, delta);
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
  const delta = snappedWorldDelta ?? (cadDocument.viewMode === '2d'
    ? { x: screenDelta.x, y: screenDelta.y, z: 0 }
    : renderer3d.screenDeltaToCad(screenDelta));
  const edits = objects
    .map((object) => moveObjectEdit(object, delta, Boolean(snappedWorldDelta)))
    .filter((edit): edit is DocumentEdit => edit !== null);
  if (edits.length === 0) return;
  history.execute(edits.length === 1 ? edits[0] : new CompositeEdit('Move objects', edits));
}

function translateFeature(feature: SolidFeature, delta: { x: number; y: number; z: number }): void {
  if (feature.kind === 'extrusion') {
    feature.transform.translateX += delta.x;
    feature.transform.translateY += delta.y;
    feature.transform.translateZ = (feature.transform.translateZ ?? 0) + delta.z;
  } else if (feature.kind === 'boolean') {
    for (const operand of feature.operands) translateFeature(operand, delta);
  }
}

function updatePreview(cursor: Vec2): void {
  previewController.update(commands.active, cursor, ucsHoverPoint);
}

function showDimension(text: string | null, x: number, y: number): void {
  previewController.showDimension(text, x, y);
}

function positionMeasureMarker(marker: HTMLElement, x: number, y: number): void {
  previewController.showMarker(marker, x, y);
}

function positionSnapMarker(
  point: { x: number; y: number; z: number },
  fallbackX: number,
  fallbackY: number,
  mode?: ObjectSnapMode,
): void {
  previewController.showSnap(point, fallbackX, fallbackY, mode);
}

function selectedEntity(): Entity | undefined {
  return cadDocument.getSelectedEntities()[0];
}

function selectedSolid(): Solid | undefined {
  return cadDocument.getSelectedSolids()[0];
}

function profileContainingPoint(point: Vec2): Entity | undefined {
  for (let i = cadDocument.entities.length - 1; i >= 0; i--) {
    const entity = cadDocument.entities[i];
    if (entity.type === 'circle') {
      if (Math.hypot(point.x - entity.center.x, point.y - entity.center.y) <= entity.radius) return entity;
    } else if (entity.type === 'rectangle') {
      const bounds = entityBounds(entity);
      if (point.x >= bounds.min.x && point.x <= bounds.max.x && point.y >= bounds.min.y && point.y <= bounds.max.y) return entity;
    } else if (entity.type === 'octagon' || (entity.type === 'polyline' && entity.closed)) {
      const vertices = entity.vertices;
      let inside = false;
      for (let a = 0, b = vertices.length - 1; a < vertices.length; b = a++) {
        const va = vertices[a];
        const vb = vertices[b];
        if ((va.y > point.y) !== (vb.y > point.y)
          && point.x < (vb.x - va.x) * (point.y - va.y) / (vb.y - va.y) + va.x) inside = !inside;
      }
      if (inside) return entity;
    }
  }
  return undefined;
}

function nearestMeasurementPoint(event: Pick<PointerEvent, 'clientX' | 'clientY'>, pixelTolerance = 14): { x: number; y: number; z: number } | null {
  const candidates = measurementCandidates(cadDocument).map((world) => ({ world }));
  if (cadDocument.viewMode === '3d') {
    const rect = viewport.getBoundingClientRect();
    return nearestCandidateProjected(
      candidates,
      { x: event.clientX - rect.left, y: event.clientY - rect.top },
      (point) => renderer3d.projectCadPoint(renderer3d.renderer.domElement, point),
      pixelTolerance,
      cadDocument.activeWorkPlane,
    )?.world ?? null;
  }
  const cursor = rawWorldPoint(event);
  return nearestCandidate2d(candidates, cursor, cadDocument.activeWorkPlane, pixelTolerance / renderer2d.zoom)?.world ?? null;
}

type GripSnapTarget = SnapTarget;

function nearestGripTargetSnap(
  event: Pick<PointerEvent, 'clientX' | 'clientY'>,
  mode: ObjectSnapMode | null = gripInteraction.targetSnapMode,
  pixelTolerance = 14,
): GripSnapTarget | null {
  if (!mode) return null;
  const active = commands.active;
  const referenceValue = active?.data.start ?? active?.data.basePoint ?? active?.data.center;
  const reference = referenceValue && typeof referenceValue === 'object' && 'x' in referenceValue && 'y' in referenceValue
    ? localToWorld(cadDocument.activeWorkPlane, referenceValue as Vec2)
    : null;
  const candidates = objectSnapCandidates(cadDocument, mode, gripController.draggingObjectId, reference);
  if (cadDocument.viewMode === '3d') {
    const rect = viewport.getBoundingClientRect();
    return nearestCandidateProjected(
      candidates,
      { x: event.clientX - rect.left, y: event.clientY - rect.top },
      (point) => renderer3d.projectCadPoint(renderer3d.renderer.domElement, point),
      pixelTolerance,
      cadDocument.activeWorkPlane,
    );
  }
  return nearestCandidate2d(
    candidates,
    rawWorldPoint(event),
    cadDocument.activeWorkPlane,
    pixelTolerance / renderer2d.zoom,
  );
}

function nearestPersistentSnap(
  event: Pick<PointerEvent, 'clientX' | 'clientY'>,
  pixelTolerance = 14,
): GripSnapTarget | null {
  if (!cadDocument.drafting.objectSnapEnabled || cadDocument.drafting.objectSnapModes.length === 0) return null;
  const active = commands.active;
  const referenceValue = active?.data.start ?? active?.data.basePoint ?? active?.data.center;
  const reference = referenceValue && typeof referenceValue === 'object' && 'x' in referenceValue && 'y' in referenceValue
    ? localToWorld(cadDocument.activeWorkPlane, referenceValue as Vec2)
    : null;
  const candidates = cadDocument.drafting.objectSnapModes.flatMap((mode) =>
    objectSnapCandidates(cadDocument, mode, gripController.draggingObjectId, reference));
  if (cadDocument.viewMode === '3d') {
    const rect = viewport.getBoundingClientRect();
    return nearestCandidateProjected(
      candidates,
      { x: event.clientX - rect.left, y: event.clientY - rect.top },
      (point) => renderer3d.projectCadPoint(renderer3d.renderer.domElement, point),
      pixelTolerance,
      cadDocument.activeWorkPlane,
    );
  }
  return nearestCandidate2d(candidates, rawWorldPoint(event), cadDocument.activeWorkPlane, pixelTolerance / renderer2d.zoom);
}

function solidSelectionExclusions(): Set<string> {
  return selectionExclusions(cadDocument, commands.active?.data);
}

function resize(): void {
  const rect = viewport.getBoundingClientRect();
  width = Math.max(1, rect.width);
  height = Math.max(1, rect.height);
  renderer2d.resize(width, height);
  renderer3d.resize(width, height);
  redraw();
}

cadDocument.subscribe(() => {
  redraw();
  if (layerController.isOpen) layerController.render();
  if (propertiesController.isOpen) propertiesController.render();
  if (dimensionStyleController.isOpen) dimensionStyleController.render();
  if (draftingSettingsController.isOpen) draftingSettingsController.render();
});
new ResizeObserver(resize).observe(viewport);

viewport.addEventListener('pointermove', (event) => {
  if (gripMenu.hidden) viewport.classList.remove('context-menu-cursor-pending');
  const rect = viewport.getBoundingClientRect();
  const sx = event.clientX - rect.left;
  const sy = event.clientY - rect.top;
  // Keep the software CAD cursor attached to the pointer even when a mode
  // (selection window, pan, etc.) returns before geometric hover processing.
  crosshair.style.left = `${sx}px`;
  crosshair.style.top = `${sy}px`;
  if (cadDocument.viewMode === '3d' && (commands.active?.name === 'CHAMFER' || commands.active?.name === 'FILLET')) {
    renderer3d.pickSolidEdge(renderer3d.renderer.domElement, cadDocument.solids, event.clientX, event.clientY);
  } else {
    renderer3d.clearEdgeHighlight();
  }
  if (cadDocument.viewMode === '3d' && commands.active?.name === 'PRESSPULL') {
    renderer3d.pickSolidFace(renderer3d.renderer.domElement, event.clientX, event.clientY);
  } else {
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
    ucsHoverPoint = snap;
    if (snap) {
      positionSnapMarker(snap, sx, sy);
      const ucsLabel = commands.active.stepIndex === 0
        ? 'UCS origin'
        : commands.active.stepIndex === 1 ? 'UCS positive X axis' : 'UCS positive Y axis';
      showDimension(ucsLabel, sx, sy);
    } else {
      ucsHoverPoint = null;
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
  if (endpointAnchor) activeEndpointAnchor = endpointAnchor;
  const p = gripController.isDragging ? gripEditingPoint(event, gripSnap, activeEndpointAnchor) : interactionPoint(event);
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
  if (activeTracking) showDimension(`∠ ${activeTracking.angle.toFixed(0)}°`, sx, sy);
  updatePreview(p);
  const active = commands.active;
  if (active?.name === 'ROTATE' && active.stepIndex === 2 && active.data.basePoint) {
    const base = active.data.basePoint as Vec2;
    const angle = Math.atan2(p.y - base.y, p.x - base.x) * 180 / Math.PI;
    showDimension(`Angle ${angle.toFixed(2)}°`, sx, sy);
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
  const rotateSnap = active?.name === 'ROTATE' && active.steps[active.stepIndex]?.kind === 'point'
    ? nearestMeasurementPoint(event)
    : null;
  if (drawingSnap || extrudeSnap || rotateSnap) {
    if (targetedDrawingSnap) positionSnapMarker(targetedDrawingSnap.world, sx, sy, targetedDrawingSnap.mode);
    else if (persistentDrawingSnap) positionSnapMarker(persistentDrawingSnap.world, sx, sy, persistentDrawingSnap.mode);
    else if (rotateSnap) positionSnapMarker(rotateSnap, sx, sy);
    else positionMeasureMarker(snapMarker, sx, sy);
    if (extrudeSnap) {
      const height = worldToLocal(cadDocument.activeWorkPlane, extrudeSnap).z;
      showDimension(`Height ${height.toFixed(2)} mm`, sx, sy);
    }
  } else if (!gripController.isDragging || !gripInteraction.targetSnapMode) {
    snapMarker.hidden = true;
  }
  if (active?.name === 'MEASURE') {
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
      showDimension(`L ${Math.hypot(p.x - start.x, p.y - start.y).toFixed(2)} mm`, sx, sy);
    } else if (active.name === 'RECTANGLE' && active.data.start) {
      const start = active.data.start as Vec2;
      showDimension(`${Math.abs(p.x - start.x).toFixed(2)} × ${Math.abs(p.y - start.y).toFixed(2)} mm`, sx, sy);
    } else if (active.name === 'CIRCLE' && active.data.center) {
      const center = active.data.center as Vec2;
      const radius = Math.hypot(p.x - center.x, p.y - center.y);
      showDimension(`R ${radius.toFixed(2)} mm · Ø ${(radius * 2).toFixed(2)} mm`, sx, sy);
    }
  }
  if (active?.name === 'POLYGON' && active.stepIndex === 2 && active.data.center) {
    const center = active.data.center as Vec2;
    showDimension(`Apothem ${Math.hypot(p.x - center.x, p.y - center.y).toFixed(2)} mm`, sx, sy);
  }
  if (active?.name === 'MOVE' && active.stepIndex === 2 && active.data.basePoint) {
    const base = active.data.basePoint as Vec2;
    const delta = { x: p.x - base.x, y: p.y - base.y };
    const distance = Math.hypot(delta.x, delta.y);
    const label = cadDocument.viewMode === '3d'
      ? renderer3d.formatMoveDelta(delta)
      : `ΔX ${delta.x.toFixed(2)} · ΔY ${delta.y.toFixed(2)} · ${distance.toFixed(2)} mm`;
    showDimension(label, sx, sy);
  }
  void commands.handlePreview(p);
  redraw();
});

viewport.addEventListener('pointerdown', async (event) => {
  const gesture = resolvePointerGesture({
    button: event.button,
    metaKey: event.metaKey,
    altKey: event.altKey,
    onViewToggle: Boolean((event.target as HTMLElement).closest('.view-toggle')),
    zoomWindowArmed: zoomWindowMode,
    gripLatched: gripController.isDragging && gripInteraction.isLatched,
    awaitingPoint: drawingInteraction.isPointStep,
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
  if (commands.active?.name === 'EXTRUDE' && commands.active.stepIndex === 1) {
    const snap = nearestMeasurementPoint(event);
    const height = snap ? worldToLocal(cadDocument.activeWorkPlane, snap).z : 0;
    if (snap && Math.abs(height) > 1e-9) {
      await commands.submitInput(String(height));
      snapMarker.hidden = true;
      input.focus();
      event.preventDefault();
      return;
    }
  }
  if (commands.active?.name === 'MEASURE') {
    const placingDimension = commands.active.stepIndex === 2;
    const point = interactionPoint(event) ?? (placingDimension ? worldPoint(event) : null);
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
      await commands.handleClick(point);
      input.focus();
    } else {
      log('Dimension: move the cursor closer to an endpoint or vertex.');
    }
    event.preventDefault();
    return;
  }
  if (cadDocument.viewMode === '2d') {
    const expectsPoint = commands.active?.steps[commands.active.stepIndex]?.kind === 'point';
    const point = expectsPoint ? interactionPoint(event) ?? worldPoint(event) : worldPoint(event);
    const gripIndex = gripController.nearest2d(rawWorldPoint(event), 10 / renderer2d.zoom);
    const selected = selectedEntity();
    const selectedBody = selectedSolid();
    if (!commands.active && gripIndex >= 0 && (selected || selectedBody)) {
      const exactGrip = gripController.activeGrips().find((grip) => grip.index === gripIndex);
      const gripPoint = exactGrip ? { x: exactGrip.point.x, y: exactGrip.point.y } : gripEditingPoint(event);
      if (!gripPoint) return;
      gripInteraction.begin(selected, selectedBody, gripIndex, gripPoint, event.pointerId);
      event.preventDefault();
      return;
    }
    // Picking asks "what is under the cursor", so it must use the real cursor.
    // `point` is grid-snapped for placing geometry, which would test for a hit
    // at the nearest grid dot instead — only ever landing on snapped endpoints.
    const pickPoint = rawWorldPoint(event);
    const entity = pickEntityAt(cadDocument, pickPoint, 8 / renderer2d.zoom)
      ?? (commands.active?.name === 'EXTRUDE' ? profileContainingPoint(pickPoint) : undefined);
    const solid = hitTestSolid2d(cadDocument, pickPoint, solidSelectionExclusions());
    if (commands.isMultiObjectStep && !entity && !solid) {
      selectionController.beginWindow(event, 'select');
      event.preventDefault();
      return;
    }
    if (commands.active) {
      await drawingInteraction.handleClick(point, entity ?? undefined, solid?.id);
    }
    else if (entity) {
      if (!cadDocument.selectedEntityIds.has(entity.id)) gripController.mode = null;
      selectionController.selectHit(entity, null, event.shiftKey);
    } else if (solid) {
      if (!cadDocument.selectedSolidIds.has(solid.id)) gripController.mode = null;
      selectionController.selectHit(null, solid.id, event.shiftKey);
    } else {
      gripController.mode = null;
      selectionController.beginWindow(event, 'select');
      event.preventDefault();
      return;
    }
  } else {
    const activeStep = commands.active?.steps[commands.active.stepIndex];
    if ((commands.active?.name === 'CHAMFER' || commands.active?.name === 'FILLET') && activeStep?.kind === 'edge') {
      const edge = renderer3d.pickSolidEdge(renderer3d.renderer.domElement, cadDocument.solids, event.clientX, event.clientY);
      if (edge) {
        await commands.handleClick({ x: 0, y: 0 }, undefined, undefined, undefined, edge);
        renderer3d.clearEdgeHighlight();
        input.focus();
      } else log('Move closer to a solid edge.');
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
    const point = interactionPoint(event);
    if (!point) return;
    if (commands.active?.name === 'MOVE' && activeStep?.kind === 'point') {
      await commands.handleClick(point);
      if (!commands.active) previewController.clearPreview();
      input.focus();
      return;
    }
    const pickPoint = rawWorldPoint3d(event);
    if (!pickPoint) return;
    const gripIndex = renderer3d.pickGripIndex(
      renderer3d.renderer.domElement,
      activeGripsInWorld(),
      event.clientX,
      event.clientY
    );
    const selected = selectedEntity();
    const selectedBody = selectedSolid();
    if (!commands.active && gripIndex >= 0 && (selected || selectedBody)) {
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
    ) ?? (commands.active?.name === 'EXTRUDE' ? profileContainingPoint(pickPoint) : undefined);
    const solidId = renderer3d.pickSolid(
      renderer3d.renderer.domElement,
      event.clientX,
      event.clientY,
      solidSelectionExclusions()
    );
    const face = commands.active?.name === 'PRESSPULL'
      ? renderer3d.pickSolidFace(renderer3d.renderer.domElement, event.clientX, event.clientY)
      : null;
    if (commands.active) {
      await drawingInteraction.handleClick(point, entity ?? undefined, solidId ?? undefined, face ?? undefined);
    }
    else if (entity || solidId) selectionController.selectHit(entity, solidId, event.shiftKey);
    else {
      cadDocument.clearSelection();
    }
  }
  if (!commands.active || commands.active.stepIndex === 0) previewController.clearPreview();
  input.focus();
});

window.addEventListener('pointerup', (event) => {
  if (selectionController.finishWindow(event.pointerId)) return;
  // A right-button press that never moved was a click, not a pan, so it opens
  // the menu. Deciding on the movement is what lets a pan start anywhere.
  const wasStillPress = menuOnStillRelease && navigation.isPanning && navigation.panDistance < 4;
  menuOnStillRelease = false;
  navigation.endPan(event.pointerId);
  if (wasStillPress) openContextMenu(event);
  gripInteraction.commitIfNotLatched();
  if (!gripController.isDragging) activeEndpointAnchor = null;
  if (viewport.hasPointerCapture(event.pointerId)) viewport.releasePointerCapture(event.pointerId);
});

function deleteSelectedObjects(): boolean {
  if (cadDocument.selectedEntityIds.size === 0 && cadDocument.selectedSolidIds.size === 0) return false;
  gripInteraction.cancel();
  const entities = cadDocument.getSelectedEntities().map(cloneEntity);
  const solids = cadDocument.getSelectedSolids().map(cloneSolid);
  history.execute(new ReplaceObjectsEdit('Delete selected objects', entities, solids, [], []));
  gripController.mode = null;
  gripController.hoveredGrip = -1;
  previewController.clearPreview();
  log(`Deleted objects: ${entities.length + solids.length}`);
  redraw();
  return true;
}

new InputController(input, commandForm, {
  escape: () => {
    gripInteraction.cancel();
    drawingInteraction.cancel();
    ucsHoverPoint = null;
    zoomWindowMode = false;
    windowDrag.cancel();
    navigation.cancel();
    document.querySelector<HTMLButtonElement>('[data-view-action="zoom-window"]')?.classList.remove('active');
    commands.cancelActive();
    previewController.reset();
    activeTracking = null;
    activeEndpointAnchor = null;
    trackingLine.hidden = true;
    gripController.mode = null;
    gripController.hoveredGrip = -1;
    gripMenu.hidden = true;
    renderer3d.clearFaceHighlight();
    input.value = '';
    currentSuggestions = [];
    suggestionIndex = 0;
    commandSuggestionsElement.replaceChildren();
    commandSuggestionsElement.hidden = true;
    textOptions.hidden = true;
    cadDocument.clearSelection();
    prompt.textContent = 'Command:';
    redraw();
  },
  undo: () => { history.undo(); redraw(); },
  redo: () => { history.redo(); redraw(); },
  save: () => { void projectController.quickSave(); },
  saveAs: () => { void projectController.saveAs(); },
  newProject: () => projectController.newProject(),
  open: () => { void projectController.open(); },
  export: () => { void projectController.exportStl(); },
  deleteSelection: deleteSelectedObjects,
  show2d: () => {
    cadDocument.viewMode = '2d';
    cadDocument.notify();
    redraw();
  },
  toggleObjectSnap: () => toggleDraftingMode('objectSnapEnabled', 'Object Snap'),
  toggleOrtho: () => toggleDraftingMode('orthoEnabled', 'Ortho'),
  toggleGridSnap,
  toggleObjectSnapTracking: () => toggleDraftingMode('objectSnapTrackingEnabled', 'Object Snap Tracking'),
  togglePolar: () => toggleDraftingMode('polarEnabled', 'Polar Tracking'),
  toggleProperties: () => propertiesController.toggle(),
  commandActive: () => Boolean(commands.active),
  commandInputChanged: () => {
    suggestionIndex = 0;
    updateCommandSuggestions();
  },
});

function toggleDraftingMode(mode: 'objectSnapEnabled' | 'orthoEnabled' | 'polarEnabled' | 'objectSnapTrackingEnabled', label: string): void {
  const enabled = !cadDocument.drafting[mode];
  cadDocument.drafting[mode] = enabled;
  if (enabled && mode === 'orthoEnabled') cadDocument.drafting.polarEnabled = false;
  if (enabled && mode === 'polarEnabled') cadDocument.drafting.orthoEnabled = false;
  if (!enabled && (mode === 'orthoEnabled' || mode === 'polarEnabled')) trackingLine.hidden = true;
  log(`${label}: ${cadDocument.drafting[mode] ? 'ON' : 'OFF'}`);
  cadDocument.notify();
}

/** Cursor stepping. It lives on the document rather than in drafting settings,
 *  so it cannot go through toggleDraftingMode with the other three. */
function toggleGridSnap(): void {
  cadDocument.snapEnabled = !cadDocument.snapEnabled;
  log(`Snap: ${cadDocument.snapEnabled ? `ON, step ${cadDocument.snapSize} mm` : 'OFF'}`);
  cadDocument.notify();
}

get('osnap-toggle').addEventListener('click', () => toggleDraftingMode('objectSnapEnabled', 'Object Snap'));
get('snap-toggle').addEventListener('click', () => toggleGridSnap());
get('otrack-toggle').addEventListener('click', () => toggleDraftingMode('objectSnapTrackingEnabled', 'Object Snap Tracking'));
get('ortho-toggle').addEventListener('click', () => toggleDraftingMode('orthoEnabled', 'Ortho'));
get('polar-toggle').addEventListener('click', () => toggleDraftingMode('polarEnabled', 'Polar Tracking'));

commandForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const trimmed = input.value.trim();
  const gripRelativePolar = trimmed.match(/^@([+-]?(?:\d+(?:\.\d*)?|\.\d+))\s*<\s*([+-]?(?:\d+(?:\.\d*)?|\.\d+))$/);
  const gripRelativeCartesian = trimmed.match(/^@([+-]?(?:\d+(?:\.\d*)?|\.\d+))\s*[,;]\s*([+-]?(?:\d+(?:\.\d*)?|\.\d+))$/);
  const gripRelativeDistance = trimmed.match(/^@([+-]?(?:\d+(?:\.\d*)?|\.\d+))$/);
  if (gripController.isDragging && gripInteraction.isLatched && (gripRelativePolar || gripRelativeCartesian || gripRelativeDistance)) {
    input.value = '';
    let applied = false;
    if (gripRelativePolar) {
      const distance = Number(gripRelativePolar[1]);
      const angle = Number(gripRelativePolar[2]);
      applied = gripController.applyRelativePolar(distance, angle);
      if (applied) log(`Grip moved relatively by ${distance.toFixed(3)} mm at ${angle.toFixed(2)}°.`);
    } else if (gripRelativeCartesian) {
      const offset = { x: Number(gripRelativeCartesian[1]), y: Number(gripRelativeCartesian[2]) };
      applied = gripController.applyRelativeOffset(offset);
      if (applied) log(`Grip moved relatively by ${offset.x.toFixed(3)}, ${offset.y.toFixed(3)} mm.`);
    } else if (gripRelativeDistance) {
      const distance = Number(gripRelativeDistance[1]);
      applied = gripInteraction.applyRelativeDistance(distance);
      if (applied) log(`Grip moved relatively by ${distance.toFixed(3)} mm.`);
    }
    updateCommandSuggestions();
    redraw();
    input.focus();
    return;
  }
  const value = !commands.active && currentSuggestions.length > 0
    ? currentSuggestions[suggestionIndex]
    : input.value;
  if (value.trim()) log(`> ${value}`);
  input.value = '';
  await commands.submitInput(value);
  updateCommandSuggestions();
  if (!commands.active) previewController.clearPreview();
  redraw();
});

input.addEventListener('keydown', (event) => {
  if (!commands.active && currentSuggestions.length > 0 && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
    event.preventDefault();
    suggestionIndex = event.key === 'ArrowDown'
      ? (suggestionIndex + 1) % currentSuggestions.length
      : (suggestionIndex - 1 + currentSuggestions.length) % currentSuggestions.length;
    updateCommandSuggestions();
  } else if (event.key === 'ArrowUp') {
    event.preventDefault(); input.value = commands.historyUp() ?? input.value;
  } else if (event.key === 'ArrowDown') {
    event.preventDefault(); input.value = commands.historyDown() ?? input.value;
  }
});
input.addEventListener('input', () => {
  suggestionIndex = 0;
  updateCommandSuggestions();
  if (commands.active?.name === 'TEXT' && commands.active.stepIndex === 3 && commands.active.data.position) {
    previewController.setPreview({ type: 'text', data: { position: commands.active.data.position, text: input.value, font: commands.active.data.font, height: commands.active.data.height } });
    redraw();
  }
});

/**
 * Opens the object menu at the press. Called from the release of a right button
 * that never moved — a press that panned was a pan, and gets no menu.
 */
function openContextMenu(event: PointerEvent): void {
  const menuTitle = gripMenu.querySelector<HTMLElement>('.context-menu-title');
  const oneShotSection = gripMenu.querySelector<HTMLElement>('.one-shot-snaps');
  const showPersistentSnaps = (): void => {
    gripMenu.querySelectorAll<HTMLButtonElement>('[data-persistent-snap]').forEach((button) => {
      const mode = button.dataset.persistentSnap as ObjectSnapMode;
      button.classList.toggle('active', cadDocument.drafting.objectSnapModes.includes(mode));
      button.setAttribute('aria-pressed', String(cadDocument.drafting.objectSnapModes.includes(mode)));
    });
  };
  const showMenu = (): void => {
    gripMenu.style.left = `${event.clientX}px`;
    gripMenu.style.top = `${event.clientY}px`;
    gripMenu.hidden = false;
    viewport.classList.add('context-menu-cursor-pending');
  };
  showPersistentSnaps();
  if (gripController.isDragging && gripInteraction.isLatched) {
    if (oneShotSection) oneShotSection.hidden = false;
    if (menuTitle) menuTitle.textContent = 'Object snap';
    gripMenu.querySelectorAll<HTMLButtonElement>('[data-grip-mode]').forEach((button) => {
      const mode = button.dataset.gripMode as ObjectSnapMode;
      button.hidden = false;
      button.classList.toggle('active', gripInteraction.targetSnapMode === mode);
    });
    showMenu();
    return;
  }
  if (drawingInteraction.isPointStep) {
    if (oneShotSection) oneShotSection.hidden = false;
    if (menuTitle) menuTitle.textContent = 'Object snap';
    gripMenu.querySelectorAll<HTMLButtonElement>('[data-grip-mode]').forEach((button) => {
      const mode = button.dataset.gripMode as ObjectSnapMode;
      button.hidden = false;
      button.classList.toggle('active', drawingInteraction.targetSnapMode === mode);
    });
    showMenu();
    return;
  }
  if (menuTitle) menuTitle.textContent = 'Grip mode';
  const point = cadDocument.viewMode === '2d' ? rawWorldPoint(event) : rawWorldPoint3d(event);
  if (!point) return;
  const tolerance = cadDocument.viewMode === '2d'
    ? 8 / renderer2d.zoom
    : Math.max(0.2, renderer3d.orbitRadius * 0.025);
  const entity = hitTestEntity(cadDocument.entities, point, tolerance);
  const solidId = cadDocument.viewMode === '3d'
    ? renderer3d.pickSolid(renderer3d.renderer.domElement, event.clientX, event.clientY)
    : null;
  const solid = solidId ? cadDocument.getSolid(solidId) : hitTestSolid2d(cadDocument, point);
  const validEntity = entity && cadDocument.selectedEntityIds.has(entity.id) ? entity : null;
  const validSolid = solid && cadDocument.selectedSolidIds.has(solid.id) ? solid : null;
  if (!validEntity && !validSolid) {
    if (oneShotSection) oneShotSection.hidden = true;
    showMenu();
    return;
  }
  if (oneShotSection) oneShotSection.hidden = false;
  const allowed = new Set<GripMode>();
  if (validSolid) {
    allowed.add('end');
    allowed.add('center');
    allowed.add('middle');
  } else if (validEntity?.type === 'line') {
    allowed.add('end');
    allowed.add('middle');
  } else if (validEntity?.type === 'circle') {
    allowed.add('center');
  } else if (validEntity?.type === 'polyline' && !validEntity.closed) {
    allowed.add('end');
  } else if (validEntity?.type === 'rectangle') {
    allowed.add('end');
    allowed.add('center');
  }
  gripMenu.querySelectorAll<HTMLButtonElement>('[data-grip-mode]').forEach((button) => {
    const mode = button.dataset.gripMode as ObjectSnapMode;
    button.hidden = !allowed.has(mode as GripMode);
    button.classList.toggle('active', gripController.mode === mode);
  });
  if (allowed.size === 0) return;
  showMenu();
}

// The browser's own menu never appears; ours is opened from the release above.
viewport.addEventListener('contextmenu', (event) => event.preventDefault());

gripMenu.querySelectorAll<HTMLButtonElement>('[data-grip-mode]').forEach((button) => {
  button.addEventListener('click', () => {
    const mode = button.dataset.gripMode as ObjectSnapMode;
    if (gripController.isDragging && gripInteraction.isLatched) gripInteraction.setTargetSnapMode(mode);
    else if (drawingInteraction.isPointStep) drawingInteraction.setTargetSnapMode(mode);
    else gripController.mode = mode as GripMode;
    gripController.hoveredGrip = -1;
    gripMenu.hidden = true;
    redraw();
  });
});

gripMenu.querySelectorAll<HTMLButtonElement>('[data-persistent-snap]').forEach((button) => {
  button.addEventListener('click', (event) => {
    event.stopPropagation();
    const mode = button.dataset.persistentSnap as ObjectSnapMode;
    const modes = cadDocument.drafting.objectSnapModes;
    cadDocument.drafting.objectSnapModes = modes.includes(mode)
      ? modes.filter((item) => item !== mode)
      : [...modes, mode];
    cadDocument.drafting.objectSnapEnabled = true;
    log(`Running Object Snap ${mode}: ${cadDocument.drafting.objectSnapModes.includes(mode) ? 'ON' : 'OFF'}`);
    cadDocument.notify();
    gripMenu.hidden = true;
  });
});

window.addEventListener('pointerdown', (event) => {
  if (!gripMenu.contains(event.target as Node) && event.button !== 2) gripMenu.hidden = true;
});

document.querySelectorAll<HTMLButtonElement>('[data-command]').forEach((button) => {
  button.addEventListener('pointerdown', (event) => {
    // CAD tools activate on press and never steal keyboard focus from the
    // command input. This also preserves the current drawing selection.
    event.preventDefault();
    const command = button.dataset.command as CommandName;
    if (command === 'ZOOM') renderer2d.zoomExtents(cadDocument, width, height);
    commands.startCommand(command);
    redraw();
    input.focus({ preventScroll: true });
    input.setSelectionRange(input.value.length, input.value.length);
  });
});

const primitiveMain = get<HTMLButtonElement>('primitive-main');
const primitiveFlyoutElement = get<HTMLElement>('primitive-flyout');
let primitiveHoldTimer: ReturnType<typeof setTimeout> | null = null;
let primitiveHoldOpened = false;

function activatePrimitive(command = currentPrimitive): void {
  commands.startCommand(command);
  redraw();
  input.focus({ preventScroll: true });
}

function updatePrimitiveMain(command: CommandName): void {
  currentPrimitive = command;
  localStorage.setItem('mycad.lastPrimitive', command);
  const label = primitiveTools.find(([, value]) => value === command)?.[0] ?? command;
  primitiveMain.dataset.label = label;
  primitiveMain.title = `${label} · hold for more`;
  primitiveMain.setAttribute('aria-label', `${label} · hold for more`);
  primitiveMain.innerHTML = `${toolIcon(command)}<span class="flyout-caret">▾</span>`;
}

primitiveMain.addEventListener('pointerdown', (event) => {
  if (event.button !== 0) return;
  event.preventDefault();
  primitiveHoldOpened = false;
  primitiveHoldTimer = setTimeout(() => {
    primitiveHoldOpened = true;
    primitiveFlyoutElement.hidden = false;
  }, 450);
});
primitiveMain.addEventListener('pointerup', (event) => {
  if (event.button !== 0) return;
  if (primitiveHoldTimer) clearTimeout(primitiveHoldTimer);
  primitiveHoldTimer = null;
  if (!primitiveHoldOpened) activatePrimitive();
});
primitiveMain.addEventListener('pointerleave', () => {
  if (primitiveHoldTimer) clearTimeout(primitiveHoldTimer);
  primitiveHoldTimer = null;
});
primitiveFlyoutElement.querySelectorAll<HTMLButtonElement>('[data-primitive-command]').forEach((button) => {
  button.addEventListener('pointerdown', (event) => {
    event.preventDefault(); event.stopPropagation();
    const command = button.dataset.primitiveCommand as CommandName;
    updatePrimitiveMain(command);
    primitiveFlyoutElement.hidden = true;
    activatePrimitive(command);
  });
});
window.addEventListener('pointerdown', (event) => {
  if (!primitiveFlyoutElement.contains(event.target as Node) && event.target !== primitiveMain) primitiveFlyoutElement.hidden = true;
});

const arrayMain = get<HTMLButtonElement>('array-main');
const arrayFlyoutElement = get<HTMLElement>('array-flyout');
let arrayHoldTimer: ReturnType<typeof setTimeout> | null = null;
let arrayHoldOpened = false;
arrayMain.addEventListener('pointerdown', (event) => {
  if (event.button !== 0) return;
  event.preventDefault();
  arrayHoldOpened = false;
  arrayHoldTimer = setTimeout(() => {
    arrayHoldOpened = true;
    arrayFlyoutElement.hidden = false;
  }, 450);
});
arrayMain.addEventListener('pointerup', (event) => {
  if (event.button !== 0) return;
  if (arrayHoldTimer) clearTimeout(arrayHoldTimer);
  arrayHoldTimer = null;
  if (!arrayHoldOpened) {
    commands.startCommand('ARRAY_RECTANGULAR');
    redraw();
    input.focus({ preventScroll: true });
    input.setSelectionRange(input.value.length, input.value.length);
  }
});
arrayMain.addEventListener('pointerleave', () => {
  if (arrayHoldTimer) clearTimeout(arrayHoldTimer);
  arrayHoldTimer = null;
});
arrayFlyoutElement.querySelectorAll<HTMLButtonElement>('[data-command]').forEach((button) => button.addEventListener('pointerdown', (event) => {
  event.preventDefault(); event.stopPropagation();
  arrayFlyoutElement.hidden = true;
}));
window.addEventListener('pointerdown', (event) => {
  if (!arrayFlyoutElement.contains(event.target as Node) && event.target !== arrayMain) arrayFlyoutElement.hidden = true;
});

const extrudeMain = get<HTMLButtonElement>('extrude-main');
const extrudeFlyoutElement = get<HTMLElement>('extrude-flyout');
let extrudeHoldTimer: ReturnType<typeof setTimeout> | null = null;
let extrudeHoldOpened = false;
extrudeMain.addEventListener('pointerdown', (event) => {
  if (event.button !== 0) return;
  event.preventDefault();
  extrudeHoldOpened = false;
  extrudeHoldTimer = setTimeout(() => {
    extrudeHoldOpened = true;
    extrudeFlyoutElement.hidden = false;
  }, 450);
});
extrudeMain.addEventListener('pointerup', (event) => {
  if (event.button !== 0) return;
  if (extrudeHoldTimer) clearTimeout(extrudeHoldTimer);
  extrudeHoldTimer = null;
  if (!extrudeHoldOpened) {
    commands.startCommand('EXTRUDE');
    redraw();
    input.focus({ preventScroll: true });
    input.setSelectionRange(input.value.length, input.value.length);
  }
});
extrudeMain.addEventListener('pointerleave', () => {
  if (extrudeHoldTimer) clearTimeout(extrudeHoldTimer);
  extrudeHoldTimer = null;
});
extrudeFlyoutElement.querySelectorAll<HTMLButtonElement>('[data-command]').forEach((button) => button.addEventListener('pointerdown', (event) => {
  event.preventDefault(); event.stopPropagation();
  extrudeFlyoutElement.hidden = true;
}));
window.addEventListener('pointerdown', (event) => {
  if (!extrudeFlyoutElement.contains(event.target as Node) && event.target !== extrudeMain) extrudeFlyoutElement.hidden = true;
});

const circleMain = get<HTMLButtonElement>('circle-main');
const circleFlyoutElement = get<HTMLElement>('circle-flyout');
let circleHoldTimer: ReturnType<typeof setTimeout> | null = null;
let circleHoldOpened = false;
circleMain.addEventListener('pointerdown', (event) => {
  if (event.button !== 0) return; event.preventDefault(); circleHoldOpened = false;
  circleHoldTimer = setTimeout(() => { circleHoldOpened = true; circleFlyoutElement.hidden = false; }, 450);
});
circleMain.addEventListener('pointerup', (event) => {
  if (event.button !== 0) return;
  if (circleHoldTimer) clearTimeout(circleHoldTimer); circleHoldTimer = null;
  if (!circleHoldOpened) { commands.startCommand(currentCircle); redraw(); input.focus({ preventScroll: true }); }
});
circleMain.addEventListener('pointerleave', () => { if (circleHoldTimer) clearTimeout(circleHoldTimer); circleHoldTimer = null; });
circleFlyoutElement.querySelectorAll<HTMLButtonElement>('[data-circle-command]').forEach((button) => button.addEventListener('pointerdown', (event) => {
  event.preventDefault(); event.stopPropagation();
  currentCircle = button.dataset.circleCommand as CommandName;
  localStorage.setItem('mycad.lastCircle', currentCircle);
  const label = circleTools.find(([, , command]) => command === currentCircle)?.[0] ?? currentCircle;
  circleMain.dataset.label = label; circleMain.title = `${label} · hold for more`; circleMain.setAttribute('aria-label', `${label} · hold for more`);
  circleMain.innerHTML = `${toolIcon(currentCircle)}<span class="flyout-caret">▾</span>`;
  circleFlyoutElement.hidden = true; commands.startCommand(currentCircle); redraw(); input.focus({ preventScroll: true });
}));
window.addEventListener('pointerdown', (event) => {
  if (!circleFlyoutElement.contains(event.target as Node) && event.target !== circleMain) circleFlyoutElement.hidden = true;
});

const dimensionMain = get<HTMLButtonElement>('dimension-main');
const dimensionFlyoutElement = get<HTMLElement>('dimension-flyout');
let dimensionHoldTimer: ReturnType<typeof setTimeout> | null = null;
let dimensionHoldOpened = false;
dimensionMain.addEventListener('pointerdown', (event) => {
  if (event.button !== 0) return; event.preventDefault(); dimensionHoldOpened = false;
  dimensionHoldTimer = setTimeout(() => { dimensionHoldOpened = true; dimensionFlyoutElement.hidden = false; }, 450);
});
dimensionMain.addEventListener('pointerup', (event) => {
  if (event.button !== 0) return;
  if (dimensionHoldTimer) clearTimeout(dimensionHoldTimer); dimensionHoldTimer = null;
  if (!dimensionHoldOpened) { commands.startCommand(currentDimension); redraw(); input.focus({ preventScroll: true }); }
});
dimensionMain.addEventListener('pointerleave', () => { if (dimensionHoldTimer) clearTimeout(dimensionHoldTimer); dimensionHoldTimer = null; });
dimensionFlyoutElement.querySelectorAll<HTMLButtonElement>('[data-dimension-command]').forEach((button) => button.addEventListener('pointerdown', (event) => {
  event.preventDefault(); event.stopPropagation();
  currentDimension = button.dataset.dimensionCommand as CommandName;
  localStorage.setItem('mycad.lastDimension', currentDimension);
  const label = dimensionTools.find(([, command]) => command === currentDimension)?.[0] ?? currentDimension;
  dimensionMain.dataset.label = label; dimensionMain.title = `${label} · hold for more`; dimensionMain.setAttribute('aria-label', `${label} · hold for more`);
  dimensionMain.innerHTML = `${toolIcon(currentDimension)}<span class="flyout-caret">▾</span>`;
  dimensionFlyoutElement.hidden = true; commands.startCommand(currentDimension); redraw(); input.focus({ preventScroll: true });
}));
window.addEventListener('pointerdown', (event) => {
  if (!dimensionFlyoutElement.contains(event.target as Node) && event.target !== dimensionMain) dimensionFlyoutElement.hidden = true;
});

function activateZoom(action: 'ZOOM_ALL' | 'ZOOM_WINDOW'): void {
  commands.cancelActive(); gripInteraction.cancel();
  if (action === 'ZOOM_ALL') {
    zoomWindowMode = false;
    if (cadDocument.viewMode === '2d') renderer2d.zoomExtents(cadDocument, width, height);
    else renderer3d.frameContent(cadDocument.entities, cadDocument.solids);
    prompt.textContent = 'Command:'; redraw();
  } else {
    zoomWindowMode = true; prompt.textContent = 'Specify first corner of zoom window:';
    viewport.focus({ preventScroll: true }); redraw();
  }
}

const zoomMain = get<HTMLButtonElement>('zoom-main');
const zoomFlyoutElement = get<HTMLElement>('zoom-flyout');
let zoomHoldTimer: ReturnType<typeof setTimeout> | null = null;
let zoomHoldOpened = false;
zoomMain.addEventListener('pointerdown', (event) => {
  if (event.button !== 0) return; event.preventDefault(); zoomHoldOpened = false;
  zoomHoldTimer = setTimeout(() => { zoomHoldOpened = true; zoomFlyoutElement.hidden = false; }, 450);
});
zoomMain.addEventListener('pointerup', (event) => {
  if (event.button !== 0) return;
  if (zoomHoldTimer) clearTimeout(zoomHoldTimer); zoomHoldTimer = null;
  if (!zoomHoldOpened) activateZoom(currentZoom);
});
zoomMain.addEventListener('pointerleave', () => { if (zoomHoldTimer) clearTimeout(zoomHoldTimer); zoomHoldTimer = null; });
zoomFlyoutElement.querySelectorAll<HTMLButtonElement>('[data-zoom-command]').forEach((button) => button.addEventListener('pointerdown', (event) => {
  event.preventDefault(); event.stopPropagation();
  currentZoom = button.dataset.zoomCommand as 'ZOOM_ALL' | 'ZOOM_WINDOW';
  localStorage.setItem('mycad.lastZoom', currentZoom);
  const label = zoomTools.find(([, action]) => action === currentZoom)?.[0] ?? currentZoom;
  zoomMain.dataset.label = label; zoomMain.title = `${label} · hold for more`; zoomMain.setAttribute('aria-label', `${label} · hold for more`);
  zoomMain.innerHTML = `${toolIcon(currentZoom)}<span class="flyout-caret">▾</span>`;
  zoomFlyoutElement.hidden = true; activateZoom(currentZoom);
}));
window.addEventListener('pointerdown', (event) => {
  if (!zoomFlyoutElement.contains(event.target as Node) && event.target !== zoomMain) zoomFlyoutElement.hidden = true;
});

document.querySelectorAll<HTMLButtonElement>('[data-view-action]').forEach((button) => {
  button.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    commands.cancelActive();
    gripInteraction.cancel();
    const action = button.dataset.viewAction;
    if (action === 'zoom-all') {
      zoomWindowMode = false;
      document.querySelector<HTMLButtonElement>('[data-view-action="zoom-window"]')?.classList.remove('active');
      if (cadDocument.viewMode === '2d') renderer2d.zoomExtents(cadDocument, width, height);
      else renderer3d.frameContent(cadDocument.entities, cadDocument.solids);
      prompt.textContent = 'Command:';
      redraw();
    } else if (action === 'zoom-window') {
      zoomWindowMode = true;
      button.classList.add('active');
      prompt.textContent = 'Specify first corner of zoom window:';
      viewport.focus({ preventScroll: true });
    }
  });
});

document.querySelectorAll<HTMLButtonElement>('[data-standard-view]').forEach((button) => {
  button.addEventListener('click', () => {
    const view = button.dataset.standardView as 'top' | 'front' | 'right';
    cadDocument.viewMode = '3d';
    renderer3d.frameContent(cadDocument.entities, cadDocument.solids);
    renderer3d.setStandardView(view);
    cadDocument.notify();
    document.querySelectorAll('[data-standard-view]').forEach((face) => face.classList.toggle('active', face === button));
  });
});
document.querySelectorAll<HTMLButtonElement>('[data-visual-style]').forEach((button) => {
  button.addEventListener('click', () => {
    const style = button.dataset.visualStyle as 'wireframe' | 'shaded' | 'xray';
    renderer3d.setVisualStyle(style);
    document.querySelectorAll('[data-visual-style]').forEach((item) => item.classList.toggle('active', item === button));
    log(`Visual style: ${style === 'wireframe' ? 'Wireframe' : style === 'xray' ? 'X-Ray with Edges' : 'Shaded with Edges'}.`);
    redraw();
  });
});
get<HTMLButtonElement>('wcs-reset').addEventListener('click', () => {
  commands.cancelActive();
  cadDocument.activeWorkPlane = cloneWorkPlane(WORLD_WORK_PLANE);
  renderer3d.setWorkPlane(cadDocument.activeWorkPlane);
  previewController.hideSnap();
  cadDocument.notify();
  log('World Coordinate System restored.');
  redraw();
});
window.addEventListener('beforeunload', () => {
  removeMenuListener?.();
});
log('MyCAD ready. Enter HELP for a list of commands.');
resize();
