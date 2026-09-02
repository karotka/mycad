import './styles/app.css';
import { document as cadDocument } from './core/Document';
import { CommandManager, type CommandName } from './core/commands/CommandManager';
import { entityBounds, type Entity, type Solid, type TextEntity } from './core/entities/types';
import { CommandHistory } from './core/history/CommandHistory';
import { worldToScreen, type Vec2 } from './math/geometry';
import { isWorldWorkPlane, localToWorld, WORLD_WORK_PLANE, worldToLocal } from './math/workplane';
import { Canvas2DRenderer } from './render/Canvas2DRenderer';
import { Viewport3D } from './render/Viewport3D';
import { viewCubeTransform } from './render/ViewportCoordinates';
import { selectionExclusions } from './interaction/PickingService';
import { InputController } from './interaction/InputController';
import { GripController, type GripMode } from './interaction/GripController';
import type { ProjectViewState } from './io/ProjectIO';
import { LayerController } from './ui/LayerController';
import { BlockController } from './ui/BlockController';
import { WindowDragController } from './interaction/WindowDragController';
import { type ObjectSnapMode, type SnapTarget } from './interaction/SnapService';
import { ViewportNavigationController } from './interaction/ViewportNavigationController';
import { PreviewController } from './ui/PreviewController';
import { ProjectController } from './ui/ProjectController';
import { SelectionController } from './interaction/SelectionController';
import { GripInteractionController } from './interaction/GripInteractionController';
import { DrawingInteractionController } from './interaction/DrawingInteractionController';
import { DynamicUcsController } from './interaction/DynamicUcsController';
import { PropertiesController } from './ui/PropertiesController';
import { DimensionStyleController } from './ui/DimensionStyleController';
import { ModelTreeController } from './ui/ModelTreeController';
import { GcodeSettingsController } from './ui/GcodeSettingsController';
import { SettingsController } from './ui/SettingsController';
import { HatchSettingsController } from './ui/HatchSettingsController';
import { NamedUcsController } from './ui/NamedUcsController';
import { DraftingSettingsController } from './ui/DraftingSettingsController';
import {
  arrayFlyout, circleFlyout, circleTools, curveTools, dimensionFlyout, dimensionTools, drawTools, editTools,
  extrudeFlyout, modifyTools, primitiveFlyout, primitiveTools, solidTools, toolButtons, zoomFlyout, zoomTools,
} from './ui/toolbar';
import { toolIcon } from './ui/toolIcons';
import { shellHtml } from './ui/shell';
import { FlyoutTool } from './ui/FlyoutTool';
import { createPointResolver, type PointResolverState } from './interaction/PointResolver';
import { createMoveEditing, createSolidDragPreview, FINAL_DRAG_PRIMITIVES, ucsPlaneWorldDelta } from './interaction/DragEditing';
import { createDynamicUcsCoordinator, type DynamicUcsState } from './interaction/DynamicUcsCoordinator';
import { createToolActions } from './interaction/ToolActions';
import { createDynamicRectangleInput } from './interaction/DynamicRectangleInputController';
import { createDynamicLengthInput } from './interaction/DynamicLengthInputController';
import { attachViewportPointerHandlers } from './interaction/ViewportPointerHandler';
import { CadModelApi, type EdgeModifyInput, type ExtrudeInput, type LineSegmentInput, type PressPullInput, type PrimitiveInput, type SelectionMode, type SliceInput, type TransformInput, type UcsInput } from './mcp/CadModelApi';
import type { PrintColorMode } from './render/SvgExport';
import { defaultDimensionStyle, defaultDraftingSettings, defaultGcodeOptions, defaultHatchSettings } from './core/settings';
import { loadStoredDefault, SETTINGS_DEFAULT_KEYS } from './ui/settingsDefaults';

const app = document.querySelector<HTMLDivElement>('#app');
if (!app) throw new Error('Missing #app element');

// What each flyout last used, validated against the tools that still exist. Only
// a starting point: the FlyoutTool owns the choice from here on.
const savedPrimitive = localStorage.getItem('mycad.lastPrimitive') as CommandName | null;
const initialPrimitive: CommandName = primitiveTools.some(([, command]) => command === savedPrimitive) ? savedPrimitive! : 'BOX';
const savedCircle = localStorage.getItem('mycad.lastCircle') as CommandName | null;
const initialCircle: CommandName = circleTools.some(([, , command]) => command === savedCircle) ? savedCircle! : 'CIRCLE';
const savedCurve = localStorage.getItem('mycad.lastCurve') as CommandName | null;
const initialCurve: CommandName = curveTools.some(([, , command]) => command === savedCurve) ? savedCurve! : 'SPLINE';
const savedDimension = localStorage.getItem('mycad.lastDimension') as CommandName | null;
const initialDimension: CommandName = dimensionTools.some(([, , command]) => command === savedDimension) ? savedDimension! : 'MEASURE';
const savedZoom = localStorage.getItem('mycad.lastZoom') as 'ZOOM_ALL' | 'ZOOM_WINDOW' | null;
const initialZoom: 'ZOOM_ALL' | 'ZOOM_WINDOW' = zoomTools.some(([, action]) => action === savedZoom) ? savedZoom! : 'ZOOM_ALL';
const dynamicUcsController = new DynamicUcsController(localStorage.getItem('mycad.dynamicUcs') !== 'off');

// A brand new document starts from whatever Settings was last changed to, not
// always the hardcoded factory defaults — opening a project right after this
// still overwrites every one of these with what that file itself carries.
const startupDrafting = loadStoredDefault(SETTINGS_DEFAULT_KEYS.drafting, () => ({
  snapSize: cadDocument.snapSize, gridSize: cadDocument.gridSize, polarAngles: defaultDraftingSettings().polarAngles,
}));
cadDocument.snapSize = startupDrafting.snapSize;
cadDocument.gridSize = startupDrafting.gridSize;
cadDocument.drafting = { ...defaultDraftingSettings(), polarAngles: startupDrafting.polarAngles };
cadDocument.dimensionStyle = loadStoredDefault(SETTINGS_DEFAULT_KEYS.dimensionStyle, defaultDimensionStyle);
cadDocument.gcode = loadStoredDefault(SETTINGS_DEFAULT_KEYS.gcode, defaultGcodeOptions);
cadDocument.hatch = loadStoredDefault(SETTINGS_DEFAULT_KEYS.hatch, defaultHatchSettings);

app.innerHTML = shellHtml({
  primitive: initialPrimitive,
  circle: initialCircle,
  curve: initialCurve,
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
const mtextEditor = get<HTMLElement>('mtext-editor');
const mtextInput = get<HTMLTextAreaElement>('mtext-input');
const mtextEditorHeight = get<HTMLInputElement>('mtext-editor-height');
const mtextEditorFont = get<HTMLSelectElement>('mtext-editor-font');
const dynDimWidthInput = get<HTMLInputElement>('dyn-dim-width');
const dynDimHeightInput = get<HTMLInputElement>('dyn-dim-height');
const dynDimLengthInput = get<HTMLInputElement>('dyn-dim-length');
const dynDimAngleInput = get<HTMLInputElement>('dyn-dim-angle');
const dynDimSeparatorLabel = get<HTMLElement>('dyn-dim-length-angle-separator');
const dynDimDegreeLabel = get<HTMLElement>('dyn-dim-angle-degree');
const layerPanel = get<HTMLElement>('layer-panel');
const layerList = get<HTMLElement>('layer-list');
const blockPanel = get<HTMLElement>('block-panel');
const blockList = get<HTMLElement>('block-list');
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
  (delta) => cadDocument.viewMode === '3d' ? ucsPlaneWorldDelta(cadDocument.activeWorkPlane, delta) : undefined,
);
const navigation = new ViewportNavigationController(
  cadDocument,
  viewport,
  renderer2d,
  renderer3d,
  { enter3dForOrbit, redraw },
);
const history = new CommandHistory(cadDocument);
const { moveObjects } = createMoveEditing({ doc: cadDocument, history });
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
const hatchSettingsController = new HatchSettingsController(
  cadDocument,
  get<HTMLFormElement>('hatch-settings-form'),
  redraw,
);
const printTab = { button: get('settings-tab-print'), panel: get('print-settings-form'), render: () => {} };
const settingsController = new SettingsController(
  get('settings-window'),
  get('settings-close'),
  [
    { button: get('settings-tab-drafting'), panel: get('drafting-settings-form'), render: () => draftingSettingsController.render() },
    { button: get('settings-tab-dimension'), panel: get('dimension-style-form'), render: () => dimensionStyleController.render() },
    { button: get('settings-tab-hatch'), panel: get('hatch-settings-form'), render: () => hatchSettingsController.render() },
    { button: get('settings-tab-gcode'), panel: get('gcode-settings-form'), render: () => gcodeSettingsController.render() },
    printTab,
  ],
);
get('print-select').addEventListener('click', () => {
  settingsController.hide();
  commands.startCommand('PRINTAREA');
});
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
const hoverState: { ucsHoverPoint: { x: number; y: number; z: number } | null } = { ucsHoverPoint: null };
/** Set by a right-button press: a release that never moved opens the menu. */
let menuOnStillRelease = false;
let zoomWindowMode = false;
let currentSuggestions: CommandName[] = [];
const pointerState: PointResolverState = { activeTracking: null, activeEndpointAnchor: null };

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
  dynamicRectangleInput.sync();
  dynamicLengthInput.sync();
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
    // A grip is computed in the selected entity's own work plane (its vertices,
    // control points, ...) — the same as any other geometry drawn on a plane
    // that isn't the world's. Skipping this lifted it to the screen as a raw
    // local coordinate instead, which is invisible on a world-plane object (the
    // two coincide) but warps a grip badly on anything drawn on a fitted plane,
    // such as what JOIN produces.
    const grips = visibleGripsInWorld().map((grip) => ({
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
    const visibleEntities = cadDocument.entities.filter((entity) => !cadDocument.hiddenLayers.has(entity.layer) && !cadDocument.hiddenObjects.has(entity.id));
    const visibleSolids = cadDocument.solids.filter((solid) => !cadDocument.hiddenLayers.has(solid.layer) && !cadDocument.hiddenObjects.has(solid.id));
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
  get<HTMLButtonElement>('curve-main').classList.toggle('active', curveTools.some(([, , command]) => command === commands.active?.name));
  get<HTMLButtonElement>('dimension-main').classList.toggle('active', dimensionTools.some(([, command]) => command === commands.active?.name));
  get<HTMLButtonElement>('zoom-main').classList.toggle('active', zoomWindowMode);
  prompt.textContent = activePromptText();
}

function visibleGripsInWorld(): Array<{ point: Vec2 & { z?: number }; index: number; shape?: 'square' | 'edge'; angle?: number }> {
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
  // The cube turns to face the camera the way the scene does: tilted down by
  // the camera's elevation, spun round by its azimuth (see viewCubeTransform
  // for why 2D mode overrides this with a plain TOP pose instead). rotateY,
  // not rotateZ: the spin is about the upright axis, which turns the side
  // faces past the camera; rotateZ would only twist the picture in its own
  // plane. The exact signs and offset were worked out against the viewport,
  // not derived.
  const { tilt, spin } = viewCubeTransform(cadDocument.viewMode, renderer3d.viewCubeAngles());
  get<HTMLElement>('cube3d').style.transform = `rotateX(${tilt}deg) rotateY(${spin}deg)`;
}

/**
 * UCSFOLLOW: adopting an explicit UCS reorients the view to look straight down
 * the new construction plane — a plan view of the UCS — so the nav cube, the
 * standard views and picking all line up with the plane just defined. Resetting
 * to the world plane keeps the current view. Dynamic (temporary) UCS changes
 * flow through their own path and never reach here, so hovering never spins the
 * camera; only committing a UCS does.
 */
function followWorkPlaneView(): void {
  renderer3d.setWorkPlane(cadDocument.activeWorkPlane);
  if (!isWorldWorkPlane(cadDocument.activeWorkPlane)) {
    // Changing the UCS moves the construction plane, not the camera. Keep the
    // current 3D view so switching UCS does not force a re-orbit and re-zoom
    // every time — the coordinates change under a still camera. Only when
    // stepping up from the flat 2D view, where there is no meaningful 3D camera
    // yet, do we frame the content and face it once.
    const steppingUpFrom2D = cadDocument.viewMode === '2d';
    cadDocument.viewMode = '3d';
    if (steppingUpFrom2D) {
      // Frame first: setStandardView reuses orbitTarget/orbitRadius, so without a
      // fresh frame the plan view keeps the old centre and zoom and the content
      // lands off-screen at the wrong scale (the "TOP looks broken" report).
      renderer3d.frameContent(cadDocument.entities, cadDocument.solids);
      renderer3d.setStandardView('top');
    }
  }
  redraw();
}

const commands = new CommandManager({
  doc: cadDocument,
  history,
  moveObjects,
  copyWorldDelta: (delta) => cadDocument.viewMode === '3d' ? ucsPlaneWorldDelta(cadDocument.activeWorkPlane, delta) : undefined,
  workPlaneChanged: followWorkPlaneView,
  log,
  prompt: (message) => {
    prompt.textContent = message;
    queueMicrotask(syncTextOptions);
    queueMicrotask(syncMtextEditor);
  },
  getCursor: () => {
    const cursor = navigation.cursor;
    return renderer2d.screenToWorld(cursor.x, cursor.y, width, height);
  },
  redraw,
  prefillCommandInput: (value) => {
    input.value = value;
    input.focus({ preventScroll: true });
    input.select();
  },
});
const dynamicRectangleInput = createDynamicRectangleInput({
  widthInput: dynDimWidthInput,
  heightInput: dynDimHeightInput,
  project: (point) => worldToScreen(point, width, height, renderer2d.pan, renderer2d.zoom),
  isActive: () => {
    const active = commands.active;
    if (active?.name === 'RECTANGLE' && active.stepIndex === 1 && cadDocument.viewMode === '2d') return true;
    if (cadDocument.viewMode !== '2d') return false;
    return gripController.draggingRectangleFixedCorner() !== null || gripController.draggingRectangleFixedEdge() !== null;
  },
  onCommit: (point) => {
    if (commands.active?.name === 'RECTANGLE') void commands.handleClick(point);
    else gripInteraction.commitTypedPoint(point);
    redraw();
    input.focus({ preventScroll: true });
  },
});
const dynamicLengthInput = createDynamicLengthInput({
  lengthInput: dynDimLengthInput,
  angleInput: dynDimAngleInput,
  separatorLabel: dynDimSeparatorLabel,
  degreeLabel: dynDimDegreeLabel,
  project: (point) => worldToScreen(point, width, height, renderer2d.pan, renderer2d.zoom),
  isActive: () => {
    const active = commands.active;
    if (active && (active.name === 'LINE' || active.name === 'POLYLINE' || active.name === 'CIRCLE') && active.stepIndex === 1 && cadDocument.viewMode === '2d') return true;
    if (cadDocument.viewMode !== '2d') return false;
    return gripController.draggingLineFixedEnd() !== null || gripController.draggingCircleFixedCenter() !== null;
  },
  onCommit: (point) => {
    const active = commands.active;
    if (active?.name === 'LINE' || active?.name === 'POLYLINE' || active?.name === 'CIRCLE') void commands.handleClick(point);
    else gripInteraction.commitTypedPoint(point);
    redraw();
    input.focus({ preventScroll: true });
  },
  onEmptyCommit: () => {
    void commands.submitInput('');
    redraw();
    input.focus({ preventScroll: true });
  },
});
const blockController = new BlockController(
  cadDocument,
  history,
  blockPanel,
  blockList,
  get('block-count'),
  get('block-toggle'),
  get('block-create'),
  get('block-close'),
  {
    startCreate: () => {
      commands.startCommand('BLOCK');
      input.focus();
    },
    startInsert: (name) => {
      commands.startCommand('INSERT');
      void commands.submitInput(name);
      input.focus();
    },
    log,
    redraw,
  },
);
get('block-purge').addEventListener('click', () => commands.startCommand('PURGEBLOCKS'));
const drawingInteraction = new DrawingInteractionController(commands);
const pointResolver = createPointResolver({
  doc: cadDocument,
  commands,
  gripController,
  gripInteraction,
  drawingInteraction,
  renderer2d,
  renderer3d,
  viewport,
  trackingLine,
  size: () => ({ width, height }),
  state: pointerState,
});
const {
  worldPoint, rawWorldPoint, worldPoint3d, rawWorldPoint3d,
  interactionPoint, constrainedPoint, resolvePoint,
  endpointAnchorFromSnap, updateTrackingGuide,
  nearestMeasurementPoint, nearestGripTargetSnap, nearestPersistentSnap,
} = pointResolver;
const solidDragPreview = createSolidDragPreview({
  doc: cadDocument,
  commands,
  renderer3d,
  previewController,
  nearestMeasurementPoint,
  redraw,
});
const {
  pressPullDrag, extrudeHeightUnderCursor, primitiveFinalUnderCursor,
  updatePrimitiveFinalPreview, updateExtrudePreview,
} = solidDragPreview;

const ducsState: DynamicUcsState = { command: null };
const ducs = createDynamicUcsCoordinator({
  doc: cadDocument,
  commands,
  renderer3d,
  controller: dynamicUcsController,
  nearestMeasurementPoint,
  renderNamedUcs: () => namedUcsController.render(),
  log,
  redraw,
  state: ducsState,
});
const {
  releaseDynamicUcs, syncDynamicUcsLifecycle, canAcquireDynamicUcs,
  snapKeepsDynamicUcs, acquireDynamicUcs, beforeDynamicUcsAnswer,
  afterDynamicUcsAnswer, toggleDynamicUcs, saveDynamicUcs, ownsActiveCommand,
} = ducs;
const toolActions = createToolActions({
  doc: cadDocument,
  history,
  gripController,
  gripInteraction,
  drawingInteraction,
  previewController,
  renderer2d,
  renderer3d,
  rawWorldPoint,
  rawWorldPoint3d,
  gripMenu,
  viewport,
  trackingLine,
  size: () => ({ width, height }),
  log,
  redraw,
});
const {
  deleteSelectedObjects, copySelectedObjects, pasteClipboard, toggleDraftingMode, toggleGridSnap,
  toggleGridDisplay, toggleCutArea, openContextMenu, deletePendingNode,
} = toolActions;

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
    workPlaneChanged: followWorkPlaneView,
    log,
  },
);

function cancelCurrentInteraction(): void {
  releaseDynamicUcs();
  commands.cancelActive();
  gripInteraction.cancel();
  gripController.clear();
  previewController.reset();
}

const projectController = new ProjectController(cadDocument, history, {
  captureView: captureProjectView,
  cancelInteraction: cancelCurrentInteraction,
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
commands.updateContext({
  exportStl: (solids) => projectController.exportStl(solids),
  exportStep: (solids) => projectController.exportStep(solids),
  exportPdf: (win) => projectController.exportPdf(
    win,
    get<HTMLSelectElement>('print-paper').value,
    get<HTMLSelectElement>('print-orientation').value === 'landscape',
    {
      colorMode: get<HTMLSelectElement>('print-color-mode').value as PrintColorMode,
      keepLineweights: get<HTMLInputElement>('print-keep-lineweights').checked,
    },
  ),
});

const cadMcp = new CadModelApi(cadDocument, history, () => projectController.currentFilePath ?? null);

const mcpMutations = new Set([
  'new_document', 'open_project', 'select_objects', 'create_primitive', 'create_lines', 'extrude', 'boolean_solids',
  'delete_feature', 'delete_objects', 'transform_solids', 'press_pull', 'fillet_edge', 'chamfer_edge', 'slice_solid',
  'set_ucs', 'restore_wcs', 'create_layer', 'set_current_layer', 'set_object_layer', 'undo', 'redo',
]);

const stringArray = (value: unknown, label: string): string[] => {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) throw new Error(`${label} must be an array of object IDs.`);
  return value;
};

async function dispatchMcpRequest(request: { id: string; method: string; params: Record<string, unknown> }): Promise<void> {
  const api = window.mycadAPI;
  if (!api) return;
  try {
    if (mcpMutations.has(request.method)) cancelCurrentInteraction();
    const params = request.params;
    let result: unknown;
    switch (request.method) {
      case 'new_document':
        projectController.newProject(false);
        result = cadMcp.summary();
        break;
      case 'open_project': {
        if (typeof params.path !== 'string') throw new Error('A .mycad project path is required.');
        const file = await api.mcpReadProject(request.id, params.path);
        projectController.openProjectContent(file.content, file.filePath);
        result = cadMcp.summary();
        break;
      }
      case 'get_document': result = cadMcp.summary(); break;
      case 'list_objects': result = cadMcp.listObjects(params.selectedOnly === true); break;
      case 'get_object':
        if (typeof params.id !== 'string') throw new Error('An object ID is required.');
        result = cadMcp.getObject(params.id);
        break;
      case 'select_objects':
        result = cadMcp.selectObjects(
          stringArray(params.ids, 'ids'),
          (params.mode ?? 'replace') as SelectionMode,
        );
        break;
      case 'create_primitive': result = await cadMcp.createPrimitive(params as unknown as PrimitiveInput); break;
      case 'create_lines':
        if (!Array.isArray(params.segments)) throw new Error('Line segments are required.');
        result = cadMcp.createLines(params.segments as LineSegmentInput[]);
        break;
      case 'extrude': result = await cadMcp.extrude(params as unknown as ExtrudeInput); break;
      case 'describe_solid':
        if (typeof params.id !== 'string') throw new Error('A solid ID is required.');
        result = cadMcp.describeSolid(params.id);
        break;
      case 'transform_solids': result = cadMcp.transformSolids(params as unknown as TransformInput); break;
      case 'press_pull': result = await cadMcp.pressPull(params as unknown as PressPullInput); break;
      case 'fillet_edge': result = await cadMcp.modifyEdge(params as unknown as EdgeModifyInput, true); break;
      case 'chamfer_edge': result = await cadMcp.modifyEdge(params as unknown as EdgeModifyInput, false); break;
      case 'slice_solid': result = await cadMcp.sliceSolid(params as unknown as SliceInput); break;
      case 'set_ucs': result = cadMcp.setUcs(params as unknown as UcsInput); break;
      case 'restore_wcs': result = cadMcp.restoreWcs(); break;
      case 'create_layer':
        if (typeof params.name !== 'string') throw new Error('A layer name is required.');
        result = cadMcp.createLayer(params.name, params.makeCurrent === true);
        break;
      case 'set_current_layer':
        if (typeof params.name !== 'string') throw new Error('A layer name is required.');
        result = cadMcp.setCurrentLayer(params.name);
        break;
      case 'set_object_layer':
        if (typeof params.layer !== 'string') throw new Error('A layer name is required.');
        result = cadMcp.setObjectLayer(stringArray(params.ids, 'ids'), params.layer);
        break;
      case 'boolean_solids':
        if (params.operation !== 'union' && params.operation !== 'subtract' && params.operation !== 'intersect') {
          throw new Error('Boolean operation must be union, subtract or intersect.');
        }
        result = await cadMcp.booleanOperation(
          params.operation,
          stringArray(params.solidIds, 'solidIds'),
          typeof params.name === 'string' ? params.name : undefined,
        );
        break;
      case 'delete_feature':
        if (typeof params.solidId !== 'string') throw new Error('A solid ID is required.');
        result = await cadMcp.deleteFeature(
          params.solidId,
          params.point as { x: number; y: number; z: number },
          params.normal as { x: number; y: number; z: number },
        );
        break;
      case 'delete_objects': result = cadMcp.deleteObjects(stringArray(params.ids, 'ids')); break;
      case 'undo': result = cadMcp.undo(); break;
      case 'redo': result = cadMcp.redo(); break;
      case 'save_project': {
        const requestedPath = typeof params.path === 'string' ? params.path : undefined;
        const filePath = requestedPath ?? projectController.currentFilePath;
        if (!filePath) throw new Error('Pass a .mycad path because the open document has not been saved yet.');
        const content = projectController.serializeCurrentProject();
        if (requestedPath) await api.mcpWriteFile(request.id, filePath, content);
        else await api.writeFile({ filePath, content });
        projectController.markProjectSaved(filePath);
        result = { path: filePath, summary: cadMcp.summary() };
        break;
      }
      case 'export_stl': {
        if (typeof params.path !== 'string') throw new Error('A .stl output path is required.');
        const output = cadMcp.exportStlContent(
          params.solidIds === undefined ? undefined : stringArray(params.solidIds, 'solidIds'),
        );
        await api.mcpWriteFile(request.id, params.path, output.content);
        result = { path: params.path, solidIds: output.solidIds };
        break;
      }
      default: throw new Error(`Unsupported MCP operation: ${request.method}.`);
    }
    if (mcpMutations.has(request.method)) log(`MCP: ${request.method} complete.`);
    await api.mcpRespond({ id: request.id, ok: true, result });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(`MCP failed: ${message}`);
    try {
      await api.mcpRespond({ id: request.id, ok: false, error: message });
    } catch (responseError) {
      log(`MCP bridge response failed: ${responseError instanceof Error ? responseError.message : String(responseError)}`);
    }
  }
}

let mcpRequestQueue = Promise.resolve();
const removeMcpListener = window.mycadEvents?.onMcpRequest((request) => {
  // Booleans and feature healing are asynchronous. Serialising requests keeps
  // a later edit from reading the document halfway through an earlier one.
  mcpRequestQueue = mcpRequestQueue.then(() => dispatchMcpRequest(request));
});
if (removeMcpListener) void window.mycadAPI?.mcpReady();

function startStlExport(): void {
  if (cadDocument.solids.length === 0) {
    log('STL export: the document contains no 3D solids.');
    return;
  }
  commands.startCommand('EXPORTSTL');
}

function startStepExport(): void {
  if (cadDocument.solids.length === 0) {
    log('STEP export: the document contains no 3D solids.');
    return;
  }
  commands.startCommand('EXPORTSTEP');
}

/** The native menu owns these on Electron; each maps to an action the app already had. */
const menuActions: Record<string, () => void> = {
  new: () => projectController.newProject(),
  open: () => { void projectController.open(); },
  'import-dxf': () => { void projectController.importDxf(); },
  'import-excellon': () => { void projectController.importExcellon(); },
  'import-step': () => { void projectController.importStep(); },
  'import-pdf': () => { void projectController.importPdf(); },
  save: () => { void projectController.quickSave(); },
  'save-as': () => { void projectController.saveAs(); },
  'export-stl': startStlExport,
  'export-step': startStepExport,
  'export-dxf': () => { void projectController.exportDxf(); },
  'export-gcode': () => { void projectController.exportGcode(); },
  print: () => settingsController.openTab(printTab),
  settings: () => settingsController.toggle(),
  undo: () => { log(history.undo() ? 'Undo complete.' : 'Nothing to undo.'); redraw(); },
  redo: () => { log(history.redo() ? 'Redo complete.' : 'Nothing to redo.'); redraw(); },
  // Copy/paste act on the drawing, unless a text field owns focus — then they
  // fall back to the native clipboard so the command line and property inputs
  // keep working. Electron's execCommand handles that text case in the renderer.
  copy: () => { if (isTextFieldFocused()) document.execCommand('copy'); else copySelectedObjects(); },
  cut: () => { if (isTextFieldFocused()) document.execCommand('cut'); else if (copySelectedObjects()) deleteSelectedObjects(); },
  // execCommand('paste') is blocked in current Chromium even for a genuine
  // user action, unlike copy/cut — the reliable path is the browser process
  // performing the edit command itself.
  paste: () => { if (isTextFieldFocused()) void window.mycadAPI?.pasteNative(); else pasteClipboard(); },
};

function isTextFieldFocused(): boolean {
  const element = document.activeElement;
  // The command line holds focus the whole time you draw — AutoCAD-style — so it
  // is canvas mode, not a text field: Cmd+C/Cmd+V there act on objects. Only the
  // property and value inputs (and any contenteditable) count as text editing.
  if (element === input) return false;
  return element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement
    || (element instanceof HTMLElement && element.isContentEditable);
}

const removeMenuListener = window.mycadEvents?.onMenuAction((action) => {
  menuActions[action]?.();
});

// Intercept the clipboard events themselves — not just the keystroke — so an
// object copy/paste wins no matter how it is triggered (native shortcut or the
// Edit menu), and the browser's own text paste is cancelled before it can land
// in the command line. A focused property/value input still keeps the native
// clipboard, since it is a genuine text field.
function handleClipboardEvent(kind: 'copy' | 'cut' | 'paste', event: Event): void {
  if (isTextFieldFocused()) return;
  event.preventDefault();
  event.stopPropagation();
  if (kind === 'copy') copySelectedObjects();
  else if (kind === 'cut') { if (copySelectedObjects()) deleteSelectedObjects(); }
  else pasteClipboard();
}
window.addEventListener('copy', (event) => handleClipboardEvent('copy', event), { capture: true });
window.addEventListener('cut', (event) => handleClipboardEvent('cut', event), { capture: true });
window.addEventListener('paste', (event) => handleClipboardEvent('paste', event), { capture: true });

function syncTextOptions(): void {
  const active = commands.active;
  const selectingStyle = (active?.name === 'TEXT' || active?.name === 'MTEXT') && active.stepIndex < 2;
  textOptions.hidden = !selectingStyle;
}

/**
 * TEXT, MTEXT and TEXTEDIT all gather their content the same way now — this is
 * the one window for it, so typing "a line" or "several lines" is the same
 * gesture whichever command asked. Positioned once, at the world point the
 * step itself carries, rather than tracked live through pan/zoom while open.
 */
function syncMtextEditor(): void {
  const active = commands.active;
  const creating = (active?.name === 'TEXT' || active?.name === 'MTEXT') && active.stepIndex === 3;
  const editing = active?.name === 'TEXTEDIT' && active.stepIndex === 1;
  if (!creating && !editing) {
    mtextEditor.hidden = true;
    return;
  }
  if (!mtextEditor.hidden) return; // already open for this step — don't steal focus back
  const worldPosition = creating
    ? active.data.position as Vec2 | undefined
    : (active.data.textEntity as TextEntity | undefined)?.position;
  if (!worldPosition) { mtextEditor.hidden = true; return; }
  const screen = worldToScreen(worldPosition, width, height, renderer2d.pan, renderer2d.zoom);
  mtextEditor.style.left = `${screen.x}px`;
  mtextEditor.style.top = `${screen.y}px`;
  mtextEditor.hidden = false;
  mtextInput.value = editing ? (active.data.textEntity as TextEntity).text : '';
  mtextEditorHeight.value = String(editing ? (active.data.textEntity as TextEntity).height : active!.data.height ?? 2.5);
  mtextEditorFont.value = editing ? ((active.data.textEntity as TextEntity).font ?? 'Arial') : (active!.data.font as string ?? 'Arial');
  mtextInput.focus();
  mtextInput.select();
  updateMtextPreview();
}

/** Shows what the overlay currently holds on the canvas itself, as it is typed,
 *  resized and refonted — not just once Done is pressed. */
function updateMtextPreview(): void {
  const active = commands.active;
  const creating = active && (active.name === 'TEXT' || active.name === 'MTEXT') && active.stepIndex === 3;
  const editing = active && active.name === 'TEXTEDIT' && active.stepIndex === 1;
  if (!creating && !editing) return;
  const entity = editing ? active!.data.textEntity as TextEntity : undefined;
  const position = creating ? active!.data.position as Vec2 | undefined : entity?.position;
  if (!position) return;
  const typedHeight = Number(mtextEditorHeight.value);
  const height = Number.isFinite(typedHeight) && typedHeight > 0 ? typedHeight : (creating ? active!.data.height as number : entity!.height);
  previewController.setPreview({ type: 'text', data: { position, text: mtextInput.value, font: mtextEditorFont.value, height } });
  redraw();
}
mtextInput.addEventListener('input', updateMtextPreview);
mtextEditorHeight.addEventListener('input', updateMtextPreview);
mtextEditorFont.addEventListener('input', updateMtextPreview);

async function submitMtext(): Promise<void> {
  if (mtextEditor.hidden) return;
  const value = mtextInput.value;
  const height = Number(mtextEditorHeight.value);
  const font = mtextEditorFont.value;
  mtextEditor.hidden = true;
  await commands.submitText(value, Number.isFinite(height) && height > 0 ? height : undefined, font);
  if (!commands.active) previewController.clearPreview();
  redraw();
}

mtextInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
    event.preventDefault();
    void submitMtext();
  }
});
get<HTMLButtonElement>('mtext-done').addEventListener('click', () => void submitMtext());
get<HTMLButtonElement>('mtext-cancel').addEventListener('click', () => {
  mtextEditor.hidden = true;
  commands.cancelActive();
  previewController.clearPreview();
  redraw();
});

get<HTMLButtonElement>('text-options-continue').addEventListener('click', async () => {
  const activeName = commands.active?.name;
  if ((activeName !== 'TEXT' && activeName !== 'MTEXT') || commands.active!.stepIndex >= 2) return;
  const height = Number(textHeight.value);
  if (!Number.isFinite(height) || height <= 0) {
    textHeight.focus();
    return;
  }
  if (commands.active!.stepIndex === 0) await commands.submitInput(textFont.value);
  if ((commands.active?.name === 'TEXT' || commands.active?.name === 'MTEXT') && commands.active.stepIndex === 1) await commands.submitInput(String(height));
  syncTextOptions();
  redraw();
  input.focus();
});


/** The edit that moves one object, without running it — so many can share a step. */

function updatePreview(cursor: Vec2): void {
  previewController.update(commands.active, cursor, hoverState.ucsHoverPoint);
}

function showDimension(text: string | null, x: number, y: number): void {
  previewController.showDimension(text, x, y);
}


function showPreviewLabel(text: string | null, x: number, y: number): void {
  if (cadDocument.viewMode === '2d') return;
  showDimension(text, x, y);
}

function updateDynamicRectangleInput(start: Vec2, cursor: Vec2): Vec2 {
  return dynamicRectangleInput.update(start, cursor);
}

function updateDynamicRectangleEdge(axis: 'x' | 'y', fixed: number, perpendicular: [number, number], cursor: Vec2): Vec2 {
  return dynamicRectangleInput.updateEdge(axis, fixed, perpendicular, cursor);
}

function updateDynamicLengthInput(start: Vec2, cursor: Vec2, options: { emptyFinishes: boolean; autoFocus?: boolean }): Vec2 {
  return dynamicLengthInput.update(start, cursor, options);
}

function updateDynamicDiameterInput(center: Vec2, cursor: Vec2, autoFocus = false): Vec2 {
  return dynamicLengthInput.updateDiameter(center, cursor, autoFocus);
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

type GripSnapTarget = SnapTarget;


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
  blockController.render();
  if (propertiesController.isOpen) propertiesController.render();
  settingsController.renderActive();
  modelTreeController.render();
});
new ResizeObserver(resize).observe(viewport);

attachViewportPointerHandlers({
  cadDocument,
  commands,
  renderer2d,
  renderer3d,
  navigation,
  windowDrag,
  gripController,
  gripInteraction,
  drawingInteraction,
  selectionController,
  dynamicUcsController,
  previewController,
  viewport,
  gripMenu,
  crosshair,
  prompt,
  snapMarker,
  coords,
  trackingLine,
  measureTarget,
  measureOrigin,
  input,
  resolver: pointResolver,
  dragPreview: solidDragPreview,
  ducs,
  toolActions,
  helpers: {
    gripEditingPoint,
    updatePreview,
    showDimension,
    showPreviewLabel,
    updateDynamicRectangleInput,
    updateDynamicRectangleEdge,
    updateDynamicLengthInput,
    updateDynamicDiameterInput,
    positionMeasureMarker,
    positionSnapMarker,
    selectedEntity,
    selectedSolid,
    profileContainingPoint,
    solidSelectionExclusions,
    activeGripsInWorld,
  },
  pointerState,
  hoverState,
  zoomWindowMode: () => zoomWindowMode,
  redraw,
  log,
});

new InputController(input, commandForm, {
  escape: () => {
    gripInteraction.cancel();
    drawingInteraction.cancel();
    releaseDynamicUcs();
    hoverState.ucsHoverPoint = null;
    zoomWindowMode = false;
    windowDrag.cancel();
    navigation.cancel();
    document.querySelector<HTMLButtonElement>('[data-view-action="zoom-window"]')?.classList.remove('active');
    commands.cancelActive();
    previewController.reset();
    pointerState.activeTracking = null;
    pointerState.activeEndpointAnchor = null;
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
    mtextEditor.hidden = true;
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
  importDxf: () => { void projectController.importDxf(); },
  export: startStlExport,
  deleteSelection: deleteSelectedObjects,
  copySelection: copySelectedObjects,
  pasteClipboard,
  nativePaste: () => { void window.mycadAPI?.pasteNative(); },
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
  toggleTree: () => modelTreeController.toggle(),
  toggleLayers: () => layerController.toggle(),
  toggleBlocks: () => blockController.toggle(),
  commandActive: () => Boolean(commands.active),
  commandInputChanged: () => {
    suggestionIndex = 0;
    updateCommandSuggestions();
  },
});


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
});

/**
 * Opens the object menu at the press. Called from the release of a right button
 * that never moved — a press that panned was a pan, and gets no menu.
 */

// The browser's own menu never appears; ours is opened from the release above.
viewport.addEventListener('contextmenu', (event) => event.preventDefault());

// A click on the drawing dismisses the floating side panels — they overlay the
// canvas, and reopen from their toolbar button or Ctrl+1..4. The panels sit
// outside the viewport element, so clicking one never reaches this listener.
viewport.addEventListener('pointerdown', () => {
  modelTreeController.close();
  layerController.close();
  blockController.close();
  propertiesController.close();
});

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

gripMenu.querySelector<HTMLButtonElement>('[data-grip-action="delete-vertex"]')?.addEventListener('click', () => {
  deletePendingNode();
  gripMenu.hidden = true;
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

const curveFlyoutTool = new FlyoutTool<CommandName>({
  main: get<HTMLButtonElement>('curve-main'),
  flyout: get('curve-flyout'),
  initial: initialCurve,
  run: runTool,
  memory: {
    attribute: 'data-curve-command',
    storageKey: 'mycad.lastCurve',
    labelOf: (value) => curveTools.find((tool) => tool[2] === value)?.[0] ?? value,
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
      // Under the WCS the plan view is the flat 2D drawing plane — where window
      // selection and grid snap live. A custom UCS has no 2D plane of its own,
      // so TOP there means looking straight down that UCS's Z, still in 3D — and
      // it must reframe the content, or it inherits a stale centre and scale.
      if (!isWorldWorkPlane(cadDocument.activeWorkPlane)) {
        renderer3d.frameContent(cadDocument.entities, cadDocument.solids);
      }
      renderer3d.setStandardView('top');
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
    log(`Visual style: ${style === 'wireframe' ? 'Wireframe (design edges only)' : style === 'xray' ? 'X-Ray with Edges' : 'Shaded with Edges'}.`);
    redraw();
  });
});
window.addEventListener('beforeunload', () => {
  removeMenuListener?.();
  removeMcpListener?.();
});
log('MyCAD ready. Enter HELP for a list of commands.');
resize();
applyDefaultTwoDView();
namedUcsController.render();
redraw();
