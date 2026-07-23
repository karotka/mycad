import './styles/app.css';
import { document as cadDocument } from './core/Document';
import { CommandManager, hitTestEntity, type ActiveCommand, type CommandName } from './core/commands/CommandManager';
import { boxLikePrimitiveFeature, radialLikePrimitiveFeature, torusPrimitiveFeature } from './core/commands/steps/solids';
import { extrusionFeature } from './core/solids/extrusion';
import { takesPointInput, transformsObjects } from './core/commands/registry';
import { cloneEntity, curvePoints, entityBounds, transformEntityPoints, type Entity, type Solid, type SolidFaceSelection, type SolidMesh } from './core/entities/types';
import { CommandHistory } from './core/history/CommandHistory';
import { CompositeEdit, ReplaceObjectsEdit, UpdateEntityEdit, UpdateSolidEdit, cloneSolid } from './core/history/edits';
import type { DocumentEdit } from './core/history/CommandHistory';
import { snapPoint2, worldToScreen, type Vec2 } from './math/geometry';
import { cloneWorkPlane, isWorldWorkPlane, localToWorld, WORLD_WORK_PLANE, worldToLocal } from './math/workplane';
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
import { DynamicUcsController, preferredDynamicFacePlane } from './interaction/DynamicUcsController';
import { PropertiesController } from './ui/PropertiesController';
import { DimensionStyleController } from './ui/DimensionStyleController';
import { ModelTreeController } from './ui/ModelTreeController';
import { GcodeSettingsController } from './ui/GcodeSettingsController';
import { SettingsController } from './ui/SettingsController';
import { NamedUcsController } from './ui/NamedUcsController';
import { primitiveMesh, regenerateSolidFeature } from './core/solids/ManifoldEngine';
import { translatedFeature } from './core/solids/featureTransform';
import { axisOffsetUnderRay } from './interaction/AxisDrag';
import { DraftingSettingsController } from './ui/DraftingSettingsController';
import {
  arrayFlyout, circleFlyout, circleTools, dimensionFlyout, dimensionTools, drawTools, editTools,
  extrudeFlyout, modifyTools, primitiveFlyout, primitiveTools, solidTools, toolButtons, zoomFlyout, zoomTools,
} from './ui/toolbar';
import { toolIcon } from './ui/toolIcons';
import { shellHtml } from './ui/shell';
import { FlyoutTool } from './ui/FlyoutTool';
import { resolveDraftingPoint } from './interaction/DraftingService';
import { resolvePointerGesture } from './interaction/PointerGesture';
import { grabsGrip, resolveViewportAction } from './interaction/ViewportAction';

const app = document.querySelector<HTMLDivElement>('#app');
if (!app) throw new Error('Missing #app element');

// What each flyout last used, validated against the tools that still exist. Only
// a starting point: the FlyoutTool owns the choice from here on.
const savedPrimitive = localStorage.getItem('mycad.lastPrimitive') as CommandName | null;
const initialPrimitive: CommandName = primitiveTools.some(([, command]) => command === savedPrimitive) ? savedPrimitive! : 'BOX';
const savedCircle = localStorage.getItem('mycad.lastCircle') as CommandName | null;
const initialCircle: CommandName = circleTools.some(([, , command]) => command === savedCircle) ? savedCircle! : 'CIRCLE';
const savedDimension = localStorage.getItem('mycad.lastDimension') as CommandName | null;
const initialDimension: CommandName = dimensionTools.some(([, , command]) => command === savedDimension) ? savedDimension! : 'MEASURE';
const savedZoom = localStorage.getItem('mycad.lastZoom') as 'ZOOM_ALL' | 'ZOOM_WINDOW' | null;
const initialZoom: 'ZOOM_ALL' | 'ZOOM_WINDOW' = zoomTools.some(([, action]) => action === savedZoom) ? savedZoom! : 'ZOOM_ALL';
const dynamicUcsController = new DynamicUcsController(localStorage.getItem('mycad.dynamicUcs') !== 'off');

const DYNAMIC_UCS_COMMANDS = new Set<CommandName>([
  'LINE', 'POLYLINE', 'RECTANGLE', 'CIRCLE', 'CIRCLE_DIAMETER', 'OCTAGON',
  'ELLIPSE', 'POLYGON', 'ARC', 'BEZIER', 'TEXT',
  'BOX', 'WEDGE', 'SPHERE', 'CONE', 'CYLINDER', 'PYRAMID', 'TORUS',
  // A linear dimension belongs to a plane. DUCS lets the first picked face
  // supply that plane, then the ordinary first-point lock keeps every
  // remaining dimension step in it. DIMALIGNED builds its own spatial plane.
  'MEASURE', 'DIMANGULAR',
]);

app.innerHTML = shellHtml({
  primitive: initialPrimitive,
  circle: initialCircle,
  dimension: initialDimension,
  zoom: initialZoom,
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
  (delta) => cadDocument.viewMode === '3d' ? ucsPlaneWorldDelta(delta) : undefined,
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
  get('layer-close'),
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
  get<HTMLFormElement>('drafting-settings-form'),
  redraw,
);
const dimensionStyleController = new DimensionStyleController(
  cadDocument,
  get<HTMLFormElement>('dimension-style-form'),
  redraw,
);
const gcodeSettingsController = new GcodeSettingsController(
  cadDocument,
  get<HTMLFormElement>('gcode-settings-form'),
  redraw,
);
const settingsController = new SettingsController(
  get('settings-window'),
  get('settings-close'),
  [
    { button: get('settings-tab-drafting'), panel: get('drafting-settings-form'), render: () => draftingSettingsController.render() },
    { button: get('settings-tab-dimension'), panel: get('dimension-style-form'), render: () => dimensionStyleController.render() },
    { button: get('settings-tab-gcode'), panel: get('gcode-settings-form'), render: () => gcodeSettingsController.render() },
  ],
);
const modelTreeController = new ModelTreeController(
  cadDocument,
  history,
  get('model-tree-panel'),
  get('model-tree-list'),
  get('model-tree-toggle'),
  get('model-tree-close'),
  redraw,
  log,
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

// The command-panel height lives as a custom property on the grid <main.app>,
// which defines its own default — so it must be set on that same element, not on
// the outer #app div, or the local default shadows it and nothing moves.
const gridApp = app.querySelector<HTMLElement>('.app') ?? app;

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
  gridApp.style.setProperty('--command-panel-height', `${nextHeight}px`);
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

let framePending = false;

/**
 * Asks for a frame rather than drawing one.
 *
 * This is called from every pointer move, and a trackpad delivers those faster
 * than anything can be drawn — so the work piled up behind the pointer instead
 * of keeping up with it. Now the calls coalesce: however many arrive, one frame
 * is drawn, when the browser is ready to show it.
 */
function redraw(): void {
  if (framePending) return;
  framePending = true;
  requestAnimationFrame(() => {
    framePending = false;
    drawFrame();
  });
}

/**
 * The parts of the chrome that only change when the command or the document
 * does — which is to say, never while the camera is moving. Writing them anyway
 * meant a document-wide querySelectorAll, thirteen getElementById lookups and a
 * textContent assignment per pointer move, each one inviting the browser to
 * recompute style and layout for an answer identical to the last.
 */
let chromeState = '';

const FINAL_DRAG_PRIMITIVES = new Set<CommandName>([
  'BOX', 'WEDGE', 'CYLINDER', 'CONE', 'PYRAMID', 'TORUS',
]);

function framePrimitiveBaseForHeight(): void {
  const active = commands.active;
  if (!active
    || !FINAL_DRAG_PRIMITIVES.has(active.name)
    || active.stepIndex !== 2
    || !active.data.framePrimitiveBase) return;
  const plane = cadDocument.activeWorkPlane;
  if (active.name === 'BOX' || active.name === 'WEDGE') {
    const start = active.data.start as Vec2;
    const end = active.data.end as Vec2;
    renderer3d.framePoints([
      localToWorld(plane, start),
      localToWorld(plane, { x: end.x, y: start.y }),
      localToWorld(plane, end),
      localToWorld(plane, { x: start.x, y: end.y }),
    ]);
  } else {
    const center = active.data.center as Vec2;
    const radiusPoint = active.data.radiusPoint as Vec2;
    const radius = Math.hypot(radiusPoint.x - center.x, radiusPoint.y - center.y);
    renderer3d.framePoints(Array.from({ length: 32 }, (_value, index) => {
      const angle = index / 32 * Math.PI * 2;
      return localToWorld(plane, {
        x: center.x + Math.cos(angle) * radius,
        y: center.y + Math.sin(angle) * radius,
      });
    }));
  }
  delete active.data.framePrimitiveBase;
}

function activePromptText(): string {
  const active = commands.active;
  if (
    (active?.name === 'MEASURE' && active.stepIndex === 0
      || active?.name === 'DIMANGULAR' && active.stepIndex === 2 && active.data.angularPointMode === true)
    && active.data.dynamicUcsConfirmed === true
  ) {
    return active.name === 'DIMANGULAR'
      ? 'DUCS plane locked. Specify angle vertex:'
      : 'DUCS plane locked. Select first measurement point:';
  }
  return commands.currentPrompt();
}

function syncChrome(): void {
  const state = [
    commands.active?.name ?? '',
    activePromptText(),
    cadDocument.viewMode,
    renderer3d.activeStandardView ?? '',
    cadDocument.snapEnabled, cadDocument.snapSize, cadDocument.gridSize, cadDocument.gridVisible,
    cadDocument.drafting.objectSnapEnabled, cadDocument.drafting.orthoEnabled,
    cadDocument.drafting.polarEnabled, cadDocument.drafting.objectSnapTrackingEnabled,
    dynamicUcsController.enabled, dynamicUcsController.isTemporary,
    cadDocument.gcode.frameVisible,
    zoomWindowMode,
  ].join('|');
  if (state === chromeState) return;
  chromeState = state;
  drawChrome();
}

function drawFrame(): void {
  syncDynamicUcsLifecycle();
  const is2d = cadDocument.viewMode === '2d';
  renderer3d.setGridVisible(cadDocument.gridVisible);
  renderer3d.syncCutAreaFrame(cadDocument.gcode);
  if (!is2d) framePrimitiveBaseForHeight();
  const activeStepKind = commands.active?.steps[commands.active.stepIndex]?.kind;
  const isObjectPick = activeStepKind === 'entity' || activeStepKind === 'solid' || activeStepKind === 'edge' || activeStepKind === 'plane';
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
  // The view cube turns with the camera, so it is the one piece of chrome that
  // genuinely belongs in every frame.
  updateViewCubeOrientation();
  syncChrome();
}

function drawChrome(): void {
  get<HTMLButtonElement>('osnap-toggle').classList.toggle('active', cadDocument.drafting.objectSnapEnabled);
  get<HTMLButtonElement>('ortho-toggle').classList.toggle('active', cadDocument.drafting.orthoEnabled);
  get<HTMLButtonElement>('polar-toggle').classList.toggle('active', cadDocument.drafting.polarEnabled);
  get<HTMLButtonElement>('grid-toggle').classList.toggle('active', cadDocument.gridVisible);
  get<HTMLButtonElement>('snap-toggle').classList.toggle('active', cadDocument.snapEnabled);
  get<HTMLButtonElement>('otrack-toggle').classList.toggle('active', cadDocument.drafting.objectSnapTrackingEnabled);
  get<HTMLButtonElement>('ducs-toggle').classList.toggle('active', dynamicUcsController.enabled);
  get<HTMLButtonElement>('ducs-save').hidden = !dynamicUcsController.isTemporary;
  get<HTMLButtonElement>('area-toggle').classList.toggle('active', cadDocument.gcode.frameVisible);
  document.querySelectorAll<HTMLButtonElement>('[data-command]').forEach((button) => {
    button.classList.toggle('active', button.dataset.command === commands.active?.name);
  });
  get<HTMLButtonElement>('primitive-main').classList.toggle('active', primitiveTools.some(([, command]) => command === commands.active?.name));
  get<HTMLButtonElement>('array-main').classList.toggle('active', commands.active?.name === 'ARRAY_RECTANGULAR' || commands.active?.name === 'ARRAY_POLAR');
  get<HTMLButtonElement>('extrude-main').classList.toggle('active', commands.active?.name === 'EXTRUDE' || commands.active?.name === 'SWEEP');
  get<HTMLButtonElement>('circle-main').classList.toggle('active', circleTools.some(([, , command]) => command === commands.active?.name));
  get<HTMLButtonElement>('dimension-main').classList.toggle('active', dimensionTools.some(([, command]) => command === commands.active?.name));
  get<HTMLButtonElement>('zoom-main').classList.toggle('active', zoomWindowMode);
  prompt.textContent = activePromptText();
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
  // The cube turns to face the camera the way the scene does: tilted down by the
  // camera's elevation, spun round by its azimuth. The exact signs and offset
  // were worked out against the viewport, not derived.
  const { azimuth, elevation } = renderer3d.viewCubeAngles();
  // Tilt down from straight-on by how far the camera is above the ground, and
  // spin round by its azimuth. rotateY, not rotateZ: the spin is about the
  // upright axis, which turns the side faces past the camera; rotateZ would only
  // twist the picture in its own plane.
  const tilt = -elevation * 180 / Math.PI;
  const spin = -(azimuth * 180 / Math.PI) - 90;
  get<HTMLElement>('cube3d').style.transform = `rotateX(${tilt}deg) rotateY(${spin}deg)`;
}

const commands = new CommandManager({
  doc: cadDocument,
  history,
  moveObjects,
  copyWorldDelta: (delta) => cadDocument.viewMode === '3d' ? ucsPlaneWorldDelta(delta) : undefined,
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
let dynamicUcsCommand: ActiveCommand | null = null;

function useWorkPlaneWithoutDocumentEvent(plane: typeof WORLD_WORK_PLANE): void {
  cadDocument.activeWorkPlane = cloneWorkPlane(plane);
  renderer3d.setWorkPlane(cadDocument.activeWorkPlane);
}

/** Restores the named/manual UCS that was active before a face was acquired. */
function releaseDynamicUcs(restored = dynamicUcsController.release()): boolean {
  dynamicUcsCommand = null;
  if (!restored) return false;
  useWorkPlaneWithoutDocumentEvent(restored);
  renderer3d.clearFaceHighlight();
  namedUcsController.render();
  return true;
}

function syncDynamicUcsLifecycle(): void {
  if (!dynamicUcsController.isTemporary) return;
  if (cadDocument.viewMode !== '3d'
    || commands.active !== dynamicUcsCommand
    || !commands.active
    || !DYNAMIC_UCS_COMMANDS.has(commands.active.name)) {
    releaseDynamicUcs();
  }
}

function canAcquireDynamicUcs(): boolean {
  const active = commands.active;
  return Boolean(
    dynamicUcsController.enabled
    && !dynamicUcsController.isLocked
    && cadDocument.viewMode === '3d'
    && active
    && DYNAMIC_UCS_COMMANDS.has(active.name)
    && active.steps[active.stepIndex]?.kind === 'point'
  );
}

/** A boundary snap still belongs to the face whose interior acquired DUCS. */
function snapKeepsDynamicUcs(event: Pick<PointerEvent, 'clientX' | 'clientY'>): boolean {
  if (!dynamicUcsController.isTemporary) return false;
  const snap = nearestMeasurementPoint(event);
  return Boolean(snap && dynamicUcsController.containsPoint(snap));
}

function acquireDynamicUcs(face: SolidFaceSelection, event: Pick<PointerEvent, 'clientX' | 'clientY'>): void {
  if (!face.region) return;
  const facePlane = preferredDynamicFacePlane(face.region);
  const snap = nearestMeasurementPoint(event);
  const snapOnFacePlane = snap && Math.abs(worldToLocal(facePlane, snap).z) < 1e-5 ? snap : null;
  const origin = snapOnFacePlane ?? face.hitPoint ?? face.region.plane.origin;
  const key = `${face.solidId}:${[...face.vertexIndices].sort((a, b) => a - b).join(',')}`;
  const temporary = dynamicUcsController.acquire(cadDocument.activeWorkPlane, facePlane, origin, key);
  if (!temporary) return;
  dynamicUcsCommand = commands.active;
  useWorkPlaneWithoutDocumentEvent(temporary);
  namedUcsController.render();
}

interface DynamicUcsAnswer {
  command: ActiveCommand;
  data: Record<string, unknown>;
  stepIndex: number;
  stepKind: string;
}

function beforeDynamicUcsAnswer(): DynamicUcsAnswer | null {
  const active = commands.active;
  if (!dynamicUcsController.isTemporary || !active || active !== dynamicUcsCommand) return null;
  return {
    command: active,
    data: active.data,
    stepIndex: active.stepIndex,
    stepKind: active.steps[active.stepIndex]?.kind ?? '',
  };
}

/** Locks after the first point, or restores after the object/command finishes. */
function afterDynamicUcsAnswer(before: DynamicUcsAnswer | null): void {
  if (!before || !dynamicUcsController.isTemporary) return;
  const active = commands.active;
  if (active !== before.command || active.data !== before.data) {
    releaseDynamicUcs();
    return;
  }
  if (before.stepKind === 'point' && active.stepIndex !== before.stepIndex) dynamicUcsController.lock();
}

function toggleDynamicUcs(): void {
  const restored = dynamicUcsController.toggle();
  if (restored) releaseDynamicUcs(restored);
  localStorage.setItem('mycad.dynamicUcs', dynamicUcsController.enabled ? 'on' : 'off');
  log(`Dynamic UCS: ${dynamicUcsController.enabled ? 'ON' : 'OFF'}`);
  if (!dynamicUcsController.enabled) renderer3d.clearFaceHighlight();
  redraw();
}

/** Promotes the live face plane to the same named-UCS list as manual UCS. */
function saveDynamicUcs(): void {
  if (!dynamicUcsController.isTemporary) return;
  const plane = cloneWorkPlane(cadDocument.activeWorkPlane);
  dynamicUcsController.release();
  dynamicUcsCommand = null;
  const named = cadDocument.addNamedWorkPlane(plane);
  renderer3d.setWorkPlane(cadDocument.activeWorkPlane);
  log(`${named.name} saved from Dynamic UCS.`);
  redraw();
}

const namedUcsController = new NamedUcsController(
  cadDocument,
  get('named-ucs-list'),
  get<HTMLButtonElement>('wcs-reset'),
  {
    beforeWorkPlaneChange: () => {
      releaseDynamicUcs();
      commands.cancelActive();
      previewController.hideSnap();
    },
    isTemporaryWorkPlane: () => dynamicUcsController.isTemporary,
    workPlaneChanged: () => {
      renderer3d.setWorkPlane(cadDocument.activeWorkPlane);
      redraw();
    },
    log,
  },
);

const projectController = new ProjectController(cadDocument, history, {
  captureView: captureProjectView,
  cancelInteraction: () => {
    releaseDynamicUcs();
    commands.cancelActive();
    gripInteraction.cancel();
    gripController.clear();
    previewController.reset();
  },
  resetView: () => {
    applyDefaultTwoDView();
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
commands.updateContext({ exportStl: (solids) => projectController.exportStl(solids) });

function startStlExport(): void {
  if (cadDocument.solids.length === 0) {
    log('STL export: the document contains no 3D solids.');
    return;
  }
  commands.startCommand('EXPORTSTL');
}

/** The native menu owns these on Electron; each maps to an action the app already had. */
const menuActions: Record<string, () => void> = {
  new: () => projectController.newProject(),
  open: () => { void projectController.open(); },
  'import-dxf': () => { void projectController.importDxf(); },
  save: () => { void projectController.quickSave(); },
  'save-as': () => { void projectController.saveAs(); },
  'export-stl': startStlExport,
  'export-dxf': () => { void projectController.exportDxf(); },
  'export-gcode': () => { void projectController.exportGcode(); },
  settings: () => settingsController.toggle(),
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
  const angularPlane = active?.name === 'DIMANGULAR'
    && active.stepIndex >= 5
    ? active.data.angularSource as { workPlane?: typeof cadDocument.activeWorkPlane } | undefined
    : undefined;
  if (angularPlane?.workPlane) {
    const targetedSnap = drawingInteraction.targetSnapMode
      ? nearestGripTargetSnap(event, drawingInteraction.targetSnapMode)
      : nearestPersistentSnap(event);
    if (targetedSnap) {
      const local = worldToLocal(angularPlane.workPlane, targetedSnap.world);
      return { x: local.x, y: local.y };
    }
    if (cadDocument.viewMode === '3d') {
      return renderer3d.workPlanePoint(
        renderer3d.renderer.domElement,
        event.clientX,
        event.clientY,
        angularPlane.workPlane,
      );
    }
    const world = localToWorld(cadDocument.activeWorkPlane, worldPoint(event));
    const local = worldToLocal(angularPlane.workPlane, world);
    return { x: local.x, y: local.y };
  }
  let radialPlane = cadDocument.viewMode === '3d'
    && (active?.name === 'DIMRADIUS' || active?.name === 'DIMDIAMETER')
    && active.stepIndex === 1
    ? active.data.radialSource as { workPlane?: typeof cadDocument.activeWorkPlane } | undefined
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
      if (acquired) activeEndpointAnchor = acquired;
      // Carry how far the snap sits off the active plane, not just its shadow on
      // it, so a line drawn in 3D lands on the point it snapped to even when that
      // point belongs to another UCS. The line keeps the active plane; only the
      // endpoint's z rides along.
      return { ...targetedSnap.point, z: worldToLocal(cadDocument.activeWorkPlane, targetedSnap.world).z } as Vec2;
    }
  }
  // Defining a cutting plane by points must not depend on whether End happens
  // to be enabled in persistent OSNAP. A nearby 3D vertex is an explicit plane
  // point and therefore wins over the planar face underneath it.
  const sliceStep = active?.name === 'SLICE' ? active.steps[active.stepIndex] : undefined;
  if (sliceStep?.kind === 'plane' || sliceStep?.kind === 'point') {
    const vertex = nearestMeasurementPoint(event);
    if (vertex) {
      const local = worldToLocal(cadDocument.activeWorkPlane, vertex);
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
  if (cadDocument.viewMode === '2d') return constrainedPoint(worldPoint(event));
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
  after.feature = translatedFeature(after.feature, delta) ?? { kind: 'mesh' };
  after.revision++;
  return new UpdateSolidEdit('Move solid', before, after);
}

/**
 * A drag measured in the active UCS plane, turned into a world vector. Only X
 * and Y move; the UCS height is untouched — dragging a solid across the floor of
 * its coordinate system rather than across the screen, which is what "move it,
 * keep the same height" means. A snapped point-to-point hop overrides this with
 * its own full-3D delta.
 */
function ucsPlaneWorldDelta(local: Vec2): { x: number; y: number; z: number } {
  const plane = cadDocument.activeWorkPlane;
  return {
    x: plane.xAxis.x * local.x + plane.yAxis.x * local.y,
    y: plane.xAxis.y * local.x + plane.yAxis.y * local.y,
    z: plane.xAxis.z * local.x + plane.yAxis.z * local.y,
  };
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
    : ucsPlaneWorldDelta(screenDelta));
  const edits = objects
    .map((object) => moveObjectEdit(object, delta, Boolean(snappedWorldDelta)))
    .filter((edit): edit is DocumentEdit => edit !== null);
  if (edits.length === 0) return;
  history.execute(edits.length === 1 ? edits[0] : new CompositeEdit('Move objects', edits));
}

function updatePreview(cursor: Vec2): void {
  previewController.update(commands.active, cursor, ucsHoverPoint);
}

function showDimension(text: string | null, x: number, y: number): void {
  previewController.showDimension(text, x, y);
}

/**
 * A measurement of the preview that is being drawn — its length, its radius,
 * its angle. In 2D the canvas already writes one beside the geometry, so saying
 * it again in the toast only printed every number twice, one above the other,
 * and then made one of them fade away. The 3D view draws no such label, so
 * there the toast is the only one there is.
 */
/**
 * PRESSPULL waiting for its distance, with the cursor dragging the face it was
 * given. Builds the solid as it would be, so the shape is what you steer by
 * rather than a number typed at a stationary picture — and returns the distance
 * so the click that ends it commits exactly what was on screen.
 */
function pressPullDrag(event: PointerEvent): { delta: number } | null {
  const active = commands.active;
  if (cadDocument.viewMode !== '3d' || active?.name !== 'PRESSPULL' || active.stepIndex !== 1) return null;
  const face = active.data.face as SolidFaceSelection | undefined;
  const solid = cadDocument.getSolid(active.data.solidId as string);
  if (!face?.region || !solid) return null;
  const delta = renderer3d.faceDragDelta(renderer3d.renderer.domElement, solid, face, event.clientX, event.clientY);
  if (delta === null || Math.abs(delta) < 1e-6) return null;
  previewController.setPreview({ type: 'presspull-region', data: { region: face.region, distance: delta } });
  return { delta };
}

/** Which way the profile is being pulled, and how far. Null when it is neither. */
function extrudeHeightUnderCursor(event: PointerEvent): { height: number; profile: Entity } | null {
  const active = commands.active;
  if (cadDocument.viewMode !== '3d' || active?.name !== 'EXTRUDE' || active.stepIndex !== 1) return null;
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

interface PrimitiveFinalDrag {
  value: number;
  mesh: SolidMesh;
  snap: { x: number; y: number; z: number } | null;
  label: string;
}

/**
 * Final size of a primitive after its base has been placed. A nearby vertex
 * wins; elsewhere the cursor ray is measured along the current UCS Z axis.
 * For every height-based primitive this is its height; for TORUS it is the
 * tube radius, giving its third input the same live 3D workflow.
 */
function primitiveFinalUnderCursor(event: PointerEvent): PrimitiveFinalDrag | null {
  const active = commands.active;
  if (cadDocument.viewMode !== '3d'
    || !active
    || !FINAL_DRAG_PRIMITIVES.has(active.name)
    || active.stepIndex !== 2) return null;

  const plane = cadDocument.activeWorkPlane;
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
    mesh: primitiveMesh(feature),
    snap,
    label: `${name} ${active.name === 'TORUS' ? 'tube radius' : 'height'}`,
  };
}

function updatePrimitiveFinalPreview(event: PointerEvent, sx: number, sy: number): PrimitiveFinalDrag | null {
  const drag = primitiveFinalUnderCursor(event);
  if (!drag) return null;
  previewController.setPreview({ type: 'solid', data: { solidId: '', mesh: drag.mesh } });
  showDimension(`${drag.label} ${drag.value.toFixed(2)} mm`, sx, sy);
  return drag;
}

/** Guards against a slow frame's preview landing on top of a newer one. */
let extrudePreviewToken = 0;

function updateExtrudePreview(event: PointerEvent, sx: number, sy: number): void {
  const drag = extrudeHeightUnderCursor(event);
  if (!drag) return;
  showDimension(`Extrude ${drag.height.toFixed(2)} mm`, sx, sy);
  const token = ++extrudePreviewToken;
  // Built by the engine that will build the real one, so the preview cannot
  // promise a shape the command then declines to make. The await settles in a
  // microtask, before anything is painted, so this does not flicker.
  void regenerateSolidFeature(extrusionFeature(drag.profile, drag.height)).then((mesh) => {
    if (!mesh || token !== extrudePreviewToken) return;
    previewController.setPreview({ type: 'solid', data: { solidId: '', mesh } });
    redraw();
  });
}

function showPreviewLabel(text: string | null, x: number, y: number): void {
  if (cadDocument.viewMode === '2d') return;
  showDimension(text, x, y);
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

/**
 * The starting 2D view: the origin sits near the lower-left corner rather than
 * dead centre, so a fresh drawing grows up and to the right into the positive
 * quadrant. The margin keeps the origin axes clear of the very corner.
 */
const TWO_D_ORIGIN_MARGIN = 0.08;
function applyDefaultTwoDView(): void {
  renderer2d.zoom = 20;
  renderer2d.pan = {
    x: (0.5 - TWO_D_ORIGIN_MARGIN) * width / renderer2d.zoom,
    y: (0.5 - TWO_D_ORIGIN_MARGIN) * height / renderer2d.zoom,
  };
}

cadDocument.subscribe(() => {
  redraw();
  namedUcsController.render();
  if (layerController.isOpen) layerController.render();
  if (propertiesController.isOpen) propertiesController.render();
  settingsController.renderActive();
  modelTreeController.render();
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
  const primitiveFinalSnap = primitiveFinalDrag?.snap ?? null;
  const rotateSnap = active?.name === 'ROTATE' && active.steps[active.stepIndex]?.kind === 'point'
    ? nearestMeasurementPoint(event)
    : null;
  const sliceVertexSnap = active?.name === 'SLICE'
    && (active.steps[active.stepIndex]?.kind === 'plane' || active.steps[active.stepIndex]?.kind === 'point')
    ? nearestMeasurementPoint(event)
    : null;
  if (drawingSnap || extrudeSnap || primitiveFinalSnap || rotateSnap || sliceVertexSnap) {
    if (targetedDrawingSnap) positionSnapMarker(targetedDrawingSnap.world, sx, sy, targetedDrawingSnap.mode);
    else if (persistentDrawingSnap) positionSnapMarker(persistentDrawingSnap.world, sx, sy, persistentDrawingSnap.mode);
    else if (primitiveFinalSnap) positionSnapMarker(primitiveFinalSnap, sx, sy);
    else if (rotateSnap) positionSnapMarker(rotateSnap, sx, sy);
    else if (sliceVertexSnap) positionSnapMarker(sliceVertexSnap, sx, sy);
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
      showPreviewLabel(`${Math.abs(p.x - start.x).toFixed(2)} × ${Math.abs(p.y - start.y).toFixed(2)} mm`, sx, sy);
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
  const gesture = resolvePointerGesture({
    button: event.button,
    metaKey: event.metaKey,
    altKey: event.altKey,
    onViewToggle: Boolean((event.target as HTMLElement).closest('.view-toggle')),
    zoomWindowArmed: zoomWindowMode,
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
    if (dynamicUcsController.isTemporary && dynamicUcsCommand === commands.active) {
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
      && dynamicUcsController.isTemporary
      && dynamicUcsCommand === commands.active
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
      const exactGrip = gripController.activeGrips().find((grip) => grip.index === gripIndex);
      const gripPoint = exactGrip ? { x: exactGrip.point.x, y: exactGrip.point.y } : gripEditingPoint(event);
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
      if (!cadDocument.selectedEntityIds.has(entity.id)) gripController.mode = null;
      selectionController.selectHit(entity, null, true);
    } else if (action.kind === 'selectSolid' && solid) {
      if (!cadDocument.selectedSolidIds.has(solid.id)) gripController.mode = null;
      selectionController.selectHit(null, solid.id, true);
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
    if ((commands.active?.name === 'CHAMFER' || commands.active?.name === 'FILLET') && activeStep?.kind === 'edge') {
      const edge = renderer3d.pickCircularSolidEdge(
        renderer3d.renderer.domElement,
        cadDocument.solids,
        event.clientX,
        event.clientY,
      ) ?? renderer3d.pickSolidEdge(
        renderer3d.renderer.domElement,
        cadDocument.solids,
        event.clientX,
        event.clientY,
      );
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
    const face = commands.active?.name === 'PRESSPULL'
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
      selectionController.selectHit(entity, solidId, true);
    } else if (action.kind === 'clearSelection') {
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
    releaseDynamicUcs();
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
  export: startStlExport,
  deleteSelection: deleteSelectedObjects,
  show2d: () => {
    releaseDynamicUcs();
    cadDocument.viewMode = '2d';
    cadDocument.notify();
    redraw();
  },
  toggleObjectSnap: () => toggleDraftingMode('objectSnapEnabled', 'Object Snap'),
  toggleDynamicUcs,
  toggleGridDisplay,
  toggleCutArea,
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

function toggleGridDisplay(): void {
  cadDocument.gridVisible = !cadDocument.gridVisible;
  log(`Grid: ${cadDocument.gridVisible ? 'ON' : 'OFF'}`);
  cadDocument.notify();
}

function toggleCutArea(): void {
  const options = cadDocument.gcode;
  options.frameVisible = !options.frameVisible;
  if (options.frameVisible) {
    const first = { x: options.frameOriginX, y: options.frameOriginY };
    const opposite = { x: first.x + options.frameWidth, y: first.y + options.frameHeight };
    if (cadDocument.viewMode === '2d') renderer2d.zoomWindow(first, opposite, width, height);
    else renderer3d.framePoints([
      { ...first, z: 0 },
      { x: opposite.x, y: first.y, z: 0 },
      { ...opposite, z: 0 },
      { x: first.x, y: opposite.y, z: 0 },
    ]);
  }
  log(`Print/cut area: ${options.frameVisible ? `ON, ${options.frameWidth} × ${options.frameHeight} mm` : 'OFF'}`);
  cadDocument.notify();
}

get('osnap-toggle').addEventListener('click', () => toggleDraftingMode('objectSnapEnabled', 'Object Snap'));
get('ducs-toggle').addEventListener('click', () => toggleDynamicUcs());
get('ducs-save').addEventListener('click', () => saveDynamicUcs());
get('grid-toggle').addEventListener('click', () => toggleGridDisplay());
get('area-toggle').addEventListener('click', () => toggleCutArea());
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
  const dynamicAnswer = beforeDynamicUcsAnswer();
  await commands.submitInput(value);
  afterDynamicUcsAnswer(dynamicAnswer);
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

/** Starts a tool from the toolbar without taking focus off the command line. */
function runTool(command: CommandName): void {
  commands.startCommand(command);
  redraw();
  input.focus({ preventScroll: true });
}

const primitiveFlyoutTool = new FlyoutTool<CommandName>({
  main: get<HTMLButtonElement>('primitive-main'),
  flyout: get('primitive-flyout'),
  initial: initialPrimitive,
  run: runTool,
  memory: {
    attribute: 'data-primitive-command',
    storageKey: 'mycad.lastPrimitive',
    labelOf: (value) => primitiveTools.find((tool) => tool[1] === value)?.[0] ?? value,
    iconOf: toolIcon,
  },
});

const arrayFlyoutTool = new FlyoutTool<CommandName>({
  main: get<HTMLButtonElement>('array-main'),
  flyout: get('array-flyout'),
  initial: 'ARRAY_RECTANGULAR',
  run: runTool,
});

const extrudeFlyoutTool = new FlyoutTool<CommandName>({
  main: get<HTMLButtonElement>('extrude-main'),
  flyout: get('extrude-flyout'),
  initial: 'EXTRUDE',
  run: runTool,
});

const circleFlyoutTool = new FlyoutTool<CommandName>({
  main: get<HTMLButtonElement>('circle-main'),
  flyout: get('circle-flyout'),
  initial: initialCircle,
  run: runTool,
  memory: {
    attribute: 'data-circle-command',
    storageKey: 'mycad.lastCircle',
    labelOf: (value) => circleTools.find((tool) => tool[2] === value)?.[0] ?? value,
    iconOf: toolIcon,
  },
});

const dimensionFlyoutTool = new FlyoutTool<CommandName>({
  main: get<HTMLButtonElement>('dimension-main'),
  flyout: get('dimension-flyout'),
  initial: initialDimension,
  run: runTool,
  memory: {
    attribute: 'data-dimension-command',
    storageKey: 'mycad.lastDimension',
    labelOf: (value) => dimensionTools.find((tool) => tool[2] === value)?.[0] ?? value,
    iconOf: toolIcon,
  },
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

const zoomFlyoutTool = new FlyoutTool<'ZOOM_ALL' | 'ZOOM_WINDOW'>({
  main: get<HTMLButtonElement>('zoom-main'),
  flyout: get('zoom-flyout'),
  initial: initialZoom,
  run: (action) => activateZoom(action),
  memory: {
    attribute: 'data-zoom-command',
    storageKey: 'mycad.lastZoom',
    labelOf: (value) => zoomTools.find((tool) => tool[1] === value)?.[0] ?? value,
    iconOf: toolIcon,
  },
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
    const view = button.dataset.standardView;
    document.querySelectorAll('[data-standard-view]').forEach((face) => face.classList.toggle('active', face === button));
    // The plan (TOP) view IS the 2D drawing mode here: a 3D top-down camera looks
    // identical but silently disables window selection and grid snap — that was
    // the "clicking TOP stopped the selection window from working" report.
    if (view === 'top') {
      renderer3d.setStandardView('top');
      // Under the WCS the plan view is the flat 2D drawing plane — where window
      // selection and grid snap live. A custom UCS has no 2D plane of its own,
      // so TOP there means looking straight down that UCS's Z, still in 3D.
      cadDocument.viewMode = isWorldWorkPlane(cadDocument.activeWorkPlane) ? '2d' : '3d';
      cadDocument.notify();
      redraw();
      return;
    }
    cadDocument.viewMode = '3d';
    renderer3d.frameContent(cadDocument.entities, cadDocument.solids);
    renderer3d.setStandardView(view as 'front' | 'left' | 'right');
    cadDocument.notify();
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
window.addEventListener('beforeunload', () => {
  removeMenuListener?.();
});
log('MyCAD ready. Enter HELP for a list of commands.');
resize();
applyDefaultTwoDView();
namedUcsController.render();
redraw();
