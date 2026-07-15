import './styles/app.css';
import { document as cadDocument } from './core/Document';
import { CommandManager, hitTestEntity, type CommandName } from './core/commands/CommandManager';
import { cloneEntity, curvePoints, entityBounds, transformEntityPoints, type Entity, type Solid, type SolidFeature } from './core/entities/types';
import { CommandHistory } from './core/history/CommandHistory';
import { ReplaceObjectsEdit, UpdateEntityEdit, UpdateSolidEdit, cloneSolid } from './core/history/edits';
import { snapPoint2, type Vec2 } from './math/geometry';
import { cloneWorkPlane, localToWorld, WORLD_WORK_PLANE, worldToLocal } from './math/workplane';
import { Canvas2DRenderer } from './render/Canvas2DRenderer';
import { Viewport3D } from './render/Viewport3D';
import { hitTestSolid2d, pickEntityAt, selectionExclusions, solidBounds } from './interaction/PickingService';
import { InputController } from './interaction/InputController';
import { GripController, type GripMode } from './interaction/GripController';
import type { ProjectViewState } from './io/ProjectIO';
import { LayerController } from './ui/LayerController';
import { WindowDragController } from './interaction/WindowDragController';
import { measurementCandidates, nearestCandidate2d, nearestCandidateProjected, objectSnapCandidates, type SnapTarget } from './interaction/SnapService';
import { ViewportNavigationController } from './interaction/ViewportNavigationController';
import { PreviewController } from './ui/PreviewController';
import { ProjectController } from './ui/ProjectController';
import { SelectionController } from './interaction/SelectionController';
import { GripInteractionController } from './interaction/GripInteractionController';
import { DrawingInteractionController } from './interaction/DrawingInteractionController';

const app = document.querySelector<HTMLDivElement>('#app');
if (!app) throw new Error('Missing #app element');

const drawTools: Array<[string, CommandName]> = [
  ['Line', 'LINE'], ['Rectangle', 'RECTANGLE'], ['Circle', 'CIRCLE'], ['Polygon', 'POLYGON'], ['Arc', 'ARC'], ['Bezier', 'BEZIER'], ['Text', 'TEXT'],
];
const modifyTools: Array<[string, CommandName]> = [
  ['Move', 'MOVE'], ['Rotate', 'ROTATE'], ['Measure', 'MEASURE'], ['Extrude', 'EXTRUDE'], ['Union', 'UNION'], ['Subtract', 'SUBTRACT'],
  ['Mirror', 'MIRROR'], ['PressPull', 'PRESSPULL'],
];
const editTools: Array<[string, CommandName]> = [
  ['Extend', 'EXTEND'], ['Trim', 'TRIM'], ['Join', 'JOIN'], ['Offset', 'OFFSET'],
];
const edgeTools: Array<[string, CommandName]> = [['Chamfer', 'CHAMFER'], ['Fillet', 'FILLET']];

type ToolbarIcon = CommandName | 'ZOOM_ALL' | 'ZOOM_WINDOW';

function toolIcon(command: ToolbarIcon): string {
  const paths: Partial<Record<ToolbarIcon, string>> = {
    LINE: '<line x1="4" y1="20" x2="20" y2="4"/><circle cx="4" cy="20" r="1.5"/><circle cx="20" cy="4" r="1.5"/>',
    RECTANGLE: '<rect x="4" y="6" width="16" height="12"/><path d="M4 4v4M2 6h4M20 16v4M18 18h4"/>',
    CIRCLE: '<circle cx="12" cy="12" r="8"/><path d="M12 2v20M2 12h20"/>',
    POLYGON: '<path d="M12 3l8 6-3 10H7L4 9l8-6z"/><circle cx="12" cy="12" r="1"/>',
    ARC: '<path d="M5 18A10 10 0 0119 6"/><circle cx="5" cy="18" r="1.5"/><circle cx="19" cy="6" r="1.5"/>',
    BEZIER: '<path d="M3 18C8 3 16 21 21 6"/><path d="M3 18L8 6M21 6l-5 10" stroke-dasharray="2 2"/>',
    TEXT: '<path d="M4 20L11 4h2l7 16M7 14h10"/>',
    MOVE: '<path d="M12 2v20M2 12h20M12 2l-3 3M12 2l3 3M22 12l-3-3M22 12l-3 3M12 22l-3-3M12 22l3-3M2 12l3-3M2 12l3 3"/>',
    ROTATE: '<path d="M19 8V3l-2 2a8 8 0 10 2.2 10M19 3h-5"/><circle cx="12" cy="12" r="1.5"/>',
    EXTRUDE: '<path d="M3 18h11l4-4H7L3 18zM12 11V2M8 6l4-4 4 4"/>',
    UNION: '<circle cx="9" cy="12" r="6"/><circle cx="15" cy="12" r="6"/><path d="M12 7.2a6 6 0 010 9.6"/>',
    SUBTRACT: '<circle cx="9" cy="12" r="7"/><path d="M12 5.7a7 7 0 010 12.6M14 12h7"/>',
    MIRROR: '<path d="M12 2v20M9 5L3 9v6l6 4V5zM15 5l6 4v6l-6 4" stroke-dasharray="2 2"/>',
    JOIN: '<path d="M3 18l6-7 5 4 7-10M7 11h4M12 15h4"/><circle cx="9" cy="11" r="1.5"/><circle cx="14" cy="15" r="1.5"/>',
    EXTEND: '<path d="M4 19L19 4M3 9h8M8 6l3 3-3 3"/><path d="M14 9l5-5" stroke-dasharray="2 2"/>',
    TRIM: '<path d="M4 20L20 4M4 5l15 15M8 9l3 3"/><circle cx="8" cy="9" r="1.5"/>',
    OFFSET: '<path d="M4 17L17 4M7 20L20 7M8 14l3 3M14 8l3 3"/>',
    CHAMFER: '<path d="M4 19V7h7l9 9v3H4zM11 7v5l5 5"/>',
    FILLET: '<path d="M4 20V5h15M4 20c0-8.3 6.7-15 15-15"/>',
    PRESSPULL: '<path d="M3 17l9 4 9-4-9-4-9 4zM12 13V4M9 7l3-3 3 3M9 10l3 3 3-3"/>',
    ERASE: '<path d="M4 16L14 4l6 5-9 11H7l-3-4zM11 20h10"/>',
    MEASURE: '<path d="M4 19L19 4M3 15l6 6M15 3l6 6M8 14l2 2M11 11l2 2M14 8l2 2"/>',
    UCS: '<path d="M5 19V7M5 19h12M5 19l7-7M5 7l-2 3M5 7l2 3M17 19l-3-2M17 19l-3 2M12 12l-1-4M12 12l4-1"/>',
    ZOOM_ALL: '<circle cx="13" cy="8.5" r="5.5"/><path d="M17 12.5l4.5 4.5"/><text class="tool-icon-label" x="1" y="22">ALL</text>',
    ZOOM_WINDOW: '<circle cx="13" cy="8.5" r="5.5"/><path d="M17 12.5l4.5 4.5"/><text class="tool-icon-label" x="1" y="22">WIN</text>',
  };
  return `<svg viewBox="0 0 24 24" aria-hidden="true">${paths[command] ?? '<circle cx="12" cy="12" r="8"/>'}</svg>`;
}

function toolButtons(tools: Array<[string, CommandName]>): string {
  return tools.map(([label, command]) =>
    `<button class="tool-btn" data-command="${command}" data-label="${label}" title="${label}" aria-label="${label}">${toolIcon(command)}</button>`
  ).join('');
}

app.innerHTML = `
  <main class="app">
    <header class="titlebar">
      <div class="file-menu-wrap">
        <button class="file-menu-button" id="file-menu-button">File</button>
        <div class="file-menu" id="file-menu" hidden>
          <button id="new-project">New project <kbd>⌘N</kbd></button>
          <button id="open-project">Open project… <kbd>⌘O</kbd></button>
          <button id="import-dxf">Import DXF…</button>
          <button id="save-project">Save project… <kbd>⌘S</kbd></button>
          <button id="export-stl">Export STL… <kbd>⌘E</kbd></button>
        </div>
      </div>
      <strong class="brand">MyCAD</strong>
    </header>
    <nav class="toolbar" aria-label="CAD tools">
      <div class="tool-group" role="group" aria-label="Draw">${toolButtons(drawTools)}</div>
      <div class="tool-divider" aria-hidden="true"></div>
      <div class="tool-group" role="group" aria-label="2D edit">${toolButtons(editTools)}</div>
      <div class="tool-divider" aria-hidden="true"></div>
      <div class="tool-group" role="group" aria-label="Edge edit">${toolButtons(edgeTools)}</div>
      <div class="tool-divider" aria-hidden="true"></div>
      <div class="tool-group" role="group" aria-label="Modify">${toolButtons(modifyTools)}</div>
      <div class="tool-divider" aria-hidden="true"></div>
      <div class="tool-group" role="group" aria-label="View and coordinate system">
        <button class="tool-btn" data-view-action="zoom-all" data-label="Zoom All" title="Zoom All" aria-label="Zoom All">${toolIcon('ZOOM_ALL')}</button>
        <button class="tool-btn" data-view-action="zoom-window" data-label="Zoom Window" title="Zoom Window" aria-label="Zoom Window">${toolIcon('ZOOM_WINDOW')}</button>
        ${toolButtons([['UCS', 'UCS']])}
      </div>
    </nav>
    <section class="viewport-wrap" id="viewport">
      <canvas id="canvas2d"></canvas>
      <div id="viewport3d"></div>
      <div class="crosshair" id="crosshair"></div>
      <div class="selection-window" id="selection-window" hidden></div>
      <div class="measure-marker measure-origin" id="measure-origin" hidden></div>
      <div class="measure-marker measure-target" id="measure-target" hidden></div>
      <div class="snap-marker" id="snap-marker" hidden></div>
      <div class="dimension-toast" id="dimension-toast" hidden></div>
      <div class="view-toggle">
        <div id="view-cube" class="view-cube" aria-label="Standard CAD views">
          <button class="cube-face cube-top" data-standard-view="top" title="Top view"><span class="cube-label">TOP</span></button>
          <button class="cube-face cube-right" data-standard-view="right" title="Right view"><span class="cube-label">RIGHT</span></button>
          <button class="cube-face cube-front" data-standard-view="front" title="Front view"><span class="cube-label">FRONT</span></button>
        </div>
        <button class="wcs-reset" id="wcs-reset" title="Return to World Coordinate System" aria-label="Return to World Coordinate System">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v18M3 12h18M12 3l-3 3M12 3l3 3M21 12l-3-3M21 12l-3 3"/><circle cx="12" cy="12" r="2"/></svg>
          <span>WCS</span>
        </button>
      </div>
    </section>
    <footer class="statusbar">
      <span class="coords" id="coords">X: 0.0000 mm Y: 0.0000 mm</span><span id="view-status">2D</span><span id="snap-status">SNAP: 0.5 mm · GRID: 1 mm</span>
      <div class="visual-style" role="group" aria-label="Visual style">
        <button class="active" data-visual-style="wireframe" title="Wireframe" aria-label="Wireframe">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l8 4.5v9L12 21l-8-4.5v-9L12 3zm0 0v9m8-4.5L12 12 4 7.5M12 12v9"/></svg>
        </button>
        <button data-visual-style="shaded" title="Shaded with Edges" aria-label="Shaded with Edges">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path class="shade-top" d="M12 3l8 4.5-8 4.5-8-4.5L12 3z"/><path class="shade-left" d="M4 7.5l8 4.5v9l-8-4.5v-9z"/><path class="shade-right" d="M20 7.5L12 12v9l8-4.5v-9z"/></svg>
        </button>
      </div>
      <button class="layer-toggle" id="layer-toggle" title="Layers" aria-label="Layers">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3L3 8l9 5 9-5-9-5zM3 12l9 5 9-5M3 16l9 5 9-5"/></svg>
        <span id="layer-current">0</span>
      </button>
      <section class="layer-panel" id="layer-panel" hidden>
        <header><strong>Layers</strong><button id="layer-add" title="New layer">+</button></header>
        <div class="layer-list" id="layer-list"></div>
      </section>
    </footer>
    <section class="command-panel">
      <div class="command-resize-handle" id="command-resize-handle" title="Drag to resize command history"></div>
      <div class="command-log" id="command-log"></div>
      <form class="command-input-row" id="command-form">
        <label class="command-prompt" id="command-prompt" for="command-input">Enter command:</label>
        <input class="command-input" id="command-input" autocomplete="off" autofocus />
        <div class="command-suggestions" id="command-suggestions" hidden></div>
      </form>
    </section>
  </main>
  <div class="context-menu" id="grip-menu" hidden>
    <div class="context-menu-title">Grip mode</div>
    <button data-grip-mode="end">End</button>
    <button data-grip-mode="center">Center</button>
    <button data-grip-mode="middle">Middle</button>
  </div>
  <section class="text-options" id="text-options" hidden>
    <strong>Text style</strong>
    <label>Font
      <select id="text-font">
        <option value="Arial">Arial</option>
        <option value="Helvetica">Helvetica</option>
        <option value="Verdana">Verdana</option>
        <option value="Times New Roman">Times New Roman</option>
        <option value="Courier New">Courier New</option>
      </select>
    </label>
    <label>Height (mm)
      <input id="text-height" type="number" min="0.1" step="0.5" value="2.5" />
    </label>
    <button id="text-options-continue" type="button">Specify insertion point</button>
  </section>`;

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
const gripMenu = get<HTMLElement>('grip-menu');
const dimensionToast = get<HTMLElement>('dimension-toast');
const textOptions = get<HTMLElement>('text-options');
const textFont = get<HTMLSelectElement>('text-font');
const textHeight = get<HTMLInputElement>('text-height');
const fileMenu = get<HTMLElement>('file-menu');
const layerPanel = get<HTMLElement>('layer-panel');
const layerList = get<HTMLElement>('layer-list');
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
    selectionChanged: () => { gripController.mode = null; gripController.hoveredGrip = -1; },
    zoomFinished: () => {
      zoomWindowMode = false;
      document.querySelector<HTMLButtonElement>('[data-view-action="zoom-window"]')?.classList.remove('active');
      prompt.textContent = 'Enter command:';
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

let width = 1;
let height = 1;
let ucsHoverPoint: { x: number; y: number; z: number } | null = null;
let suppressNextContextMenu = false;
let zoomWindowMode = false;
let currentSuggestions: CommandName[] = [];

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
  crosshair.style.display = is2d || isObjectPick ? 'block' : 'none';
  viewport.classList.toggle('object-pick', isObjectPick);
  if (is2d) {
    const grips = gripController.visibleGrips().map((grip) => ({ point: grip.point, shape: grip.shape, hot: grip.index === gripController.hoveredGrip }));
    renderer2d.render(cadDocument, width, height, previewController.preview, grips);
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
  document.querySelectorAll<HTMLButtonElement>('[data-command]').forEach((button) => {
    button.classList.toggle('active', button.dataset.command === commands.active?.name);
  });
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
  return snap?.point ?? interactionPoint(event);
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
  moveObject,
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

function worldPoint(event: PointerEvent): Vec2 {
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
  const active = commands.active;
  const drawing = active && ['LINE', 'RECTANGLE', 'CIRCLE', 'POLYGON', 'ARC', 'BEZIER', 'TEXT'].includes(active.name)
    && active.steps[active.stepIndex]?.kind === 'point';
  if (drawing) {
    const targetedSnap = nearestGripTargetSnap(event, drawingInteraction.targetSnapMode);
    if (targetedSnap) return targetedSnap.point;
    const snap = nearestMeasurementPoint(event);
    if (snap) {
      const local = worldToLocal(cadDocument.activeWorkPlane, snap);
      return { x: local.x, y: local.y };
    }
  }
  if ((active?.name === 'ROTATE' || active?.name === 'MOVE') && active.steps[active.stepIndex]?.kind === 'point') {
    const targetedSnap = nearestGripTargetSnap(event, drawingInteraction.targetSnapMode);
    if (targetedSnap) {
      if (active.name === 'MOVE') active.data.pendingMoveWorldPoint = targetedSnap.world;
      return active.name === 'MOVE' && cadDocument.viewMode === '3d'
        ? renderer3d.cadPointToViewPlane(targetedSnap.world)
        : targetedSnap.point;
    }
    const snap = nearestMeasurementPoint(event);
    if (snap) {
      if (active.name === 'MOVE') active.data.pendingMoveWorldPoint = snap;
      if (active.name === 'MOVE' && cadDocument.viewMode === '3d') return renderer3d.cadPointToViewPlane(snap);
      const local = worldToLocal(cadDocument.activeWorkPlane, snap);
      return { x: local.x, y: local.y };
    }
    if (active.name === 'MOVE') delete active.data.pendingMoveWorldPoint;
  }
  if (cadDocument.viewMode === '2d') return worldPoint(event as PointerEvent);
  const step = commands.active?.steps[commands.active.stepIndex];
  if (commands.active?.name === 'MOVE' && step?.kind === 'point') {
    const point = renderer3d.viewPlanePoint(renderer3d.renderer.domElement, event.clientX, event.clientY);
    return point && cadDocument.snapEnabled ? snapPoint2(point, cadDocument.snapSize) : point;
  }
  return worldPoint3d(event);
}

function moveObject(object: Entity | string, screenDelta: Vec2, snappedWorldDelta?: { x: number; y: number; z: number }): void {
  const delta = snappedWorldDelta ?? (cadDocument.viewMode === '2d'
    ? { x: screenDelta.x, y: screenDelta.y, z: 0 }
    : renderer3d.screenDeltaToCad(screenDelta));
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
    } else if (snappedWorldDelta) {
      const plane = object.workPlane ?? WORLD_WORK_PLANE;
      const localDelta = {
        x: delta.x * plane.xAxis.x + delta.y * plane.xAxis.y + delta.z * plane.xAxis.z,
        y: delta.x * plane.yAxis.x + delta.y * plane.yAxis.y + delta.z * plane.yAxis.z,
      };
      after = transformEntityPoints(object, (point) => ({ x: point.x + localDelta.x, y: point.y + localDelta.y }));
    } else {
      after = transformEntityPoints(object, (point) => ({ x: point.x + delta.x, y: point.y + delta.y }));
    }
    history.execute(new UpdateEntityEdit('Move object', before, after));
    return;
  }
  const solid = cadDocument.getSolid(object);
  if (!solid) return;
  const before = cloneSolid(solid);
  const after = cloneSolid(solid);
  for (let i = 0; i < after.mesh.positions.length; i += 3) {
    after.mesh.positions[i] += delta.x;
    after.mesh.positions[i + 1] += delta.y;
    after.mesh.positions[i + 2] += delta.z;
  }
  translateFeature(after.feature, delta);
  after.revision++;
  history.execute(new UpdateSolidEdit('Move solid', before, after));
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

function positionSnapMarker(point: { x: number; y: number; z: number }, fallbackX: number, fallbackY: number): void {
  previewController.showSnap(point, fallbackX, fallbackY);
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
  const candidates = measurementCandidates(cadDocument);
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
  mode: GripMode | null = gripInteraction.targetSnapMode,
  pixelTolerance = 14,
): GripSnapTarget | null {
  if (!mode) return null;
  const candidates = objectSnapCandidates(cadDocument, mode, gripController.draggingObjectId);
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
});
new ResizeObserver(resize).observe(viewport);

viewport.addEventListener('pointermove', (event) => {
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
  const gripSnap = gripController.isDragging ? nearestGripTargetSnap(event) : null;
  const p = gripController.isDragging ? gripEditingPoint(event, gripSnap) : interactionPoint(event);
  if (!p) return;
  if (gripController.isDragging) {
    gripController.update(p);
    if (gripSnap) positionSnapMarker(gripSnap.world, sx, sy);
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
  updatePreview(p);
  const active = commands.active;
  if (active?.name === 'ROTATE' && active.stepIndex === 2 && active.data.basePoint) {
    const base = active.data.basePoint as Vec2;
    const angle = Math.atan2(p.y - base.y, p.x - base.x) * 180 / Math.PI;
    showDimension(`Angle ${angle.toFixed(2)}°`, sx, sy);
  }
  const targetedDrawingSnap = drawingInteraction.isPointStep ? nearestGripTargetSnap(event, drawingInteraction.targetSnapMode) : null;
  const drawingSnap = drawingInteraction.isPointStep
    ? targetedDrawingSnap?.world ?? (drawingInteraction.targetSnapMode ? null : nearestMeasurementPoint(event))
    : null;
  const extrudeSnap = active?.name === 'EXTRUDE' && active.stepIndex === 1
    ? nearestMeasurementPoint(event)
    : null;
  const rotateSnap = active?.name === 'ROTATE' && active.steps[active.stepIndex]?.kind === 'point'
    ? nearestMeasurementPoint(event)
    : null;
  if (drawingSnap || extrudeSnap || rotateSnap) {
    if (targetedDrawingSnap) positionSnapMarker(targetedDrawingSnap.world, sx, sy);
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
  if ((event.target as HTMLElement).closest('.view-toggle')) return;
  if (zoomWindowMode && event.button === 0) {
    selectionController.beginWindow(event, 'zoom');
    event.preventDefault();
    return;
  }
  // Command+click is only the beginning of a possible orbit gesture. The 3D
  // transition is deferred until Viewport3D observes real pointer movement.
  if (event.button === 0 && event.metaKey) {
    event.preventDefault();
    return;
  }
  if (event.button === 2) {
    if (gripController.isDragging && gripInteraction.isLatched) return;
    if (drawingInteraction.isPointStep) return;
    const point = cadDocument.viewMode === '2d' ? rawWorldPoint(event) : rawWorldPoint3d(event);
    const tolerance = cadDocument.viewMode === '2d' ? 8 / renderer2d.zoom : Math.max(0.2, renderer3d.orbitRadius * 0.025);
    const entity = point ? hitTestEntity(cadDocument.entities, point, tolerance) : null;
    const solid = cadDocument.viewMode === '3d'
      ? renderer3d.pickSolid(renderer3d.renderer.domElement, event.clientX, event.clientY)
      : point ? hitTestSolid2d(cadDocument, point)?.id : null;
    const opensObjectMenu = Boolean(
      (entity && cadDocument.selectedEntityIds.has(entity.id))
      || (solid && cadDocument.selectedSolidIds.has(solid))
    );
    if (opensObjectMenu) return;
    suppressNextContextMenu = true;
    window.setTimeout(() => { suppressNextContextMenu = false; }, 800);
  }
  if (event.button === 1 || event.button === 2 || (event.button === 0 && event.altKey)) {
    const rect = viewport.getBoundingClientRect();
    navigation.beginPan({ x: event.clientX - rect.left, y: event.clientY - rect.top }, event.pointerId);
    event.preventDefault();
    return;
  }
  if (event.button !== 0) return;
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
    const point = nearestMeasurementPoint(event);
    if (point) {
      const rect = viewport.getBoundingClientRect();
      const sx = event.clientX - rect.left;
      const sy = event.clientY - rect.top;
      if (commands.active.stepIndex === 0) {
        positionMeasureMarker(measureOrigin, sx, sy);
        measureTarget.hidden = true;
      } else {
        positionMeasureMarker(measureTarget, sx, sy);
      }
      await commands.handleClick(point);
      input.focus();
    } else {
      log('Measure: move the cursor closer to an endpoint or vertex.');
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
    const entity = pickEntityAt(cadDocument, point, 8 / renderer2d.zoom)
      ?? (commands.active?.name === 'EXTRUDE' ? profileContainingPoint(point) : undefined);
    const solid = hitTestSolid2d(cadDocument, rawWorldPoint(event), solidSelectionExclusions());
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
  navigation.endPan(event.pointerId);
  gripInteraction.commitIfNotLatched();
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
    prompt.textContent = 'Enter command:';
    redraw();
  },
  undo: () => { history.undo(); redraw(); },
  redo: () => { history.redo(); redraw(); },
  save: () => { void projectController.quickSave(); },
  newProject: () => { fileMenu.hidden = true; projectController.newProject(); },
  open: () => get<HTMLButtonElement>('open-project').click(),
  export: () => get<HTMLButtonElement>('export-stl').click(),
  deleteSelection: deleteSelectedObjects,
  show2d: () => {
    cadDocument.viewMode = '2d';
    cadDocument.notify();
    redraw();
  },
  commandActive: () => Boolean(commands.active),
  commandInputChanged: () => {
    suggestionIndex = 0;
    updateCommandSuggestions();
  },
});

commandForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const gripDistance = input.value.trim().match(/^@([+-]?(?:\d+(?:\.\d*)?|\.\d+))$/);
  if (gripController.isDragging && gripInteraction.isLatched && gripDistance) {
    const distance = Number(gripDistance[1]);
    input.value = '';
    if (gripInteraction.applyRelativeDistance(distance)) {
      log(`Grip moved relatively by ${distance.toFixed(3)} mm.`);
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

viewport.addEventListener('contextmenu', (event) => {
  event.preventDefault();
  if (suppressNextContextMenu) {
    suppressNextContextMenu = false;
    gripMenu.hidden = true;
    return;
  }
  const menuTitle = gripMenu.querySelector<HTMLElement>('.context-menu-title');
  if (gripController.isDragging && gripInteraction.isLatched) {
    if (menuTitle) menuTitle.textContent = 'Object snap';
    gripMenu.querySelectorAll<HTMLButtonElement>('[data-grip-mode]').forEach((button) => {
      const mode = button.dataset.gripMode as GripMode;
      button.hidden = false;
      button.classList.toggle('active', gripInteraction.targetSnapMode === mode);
    });
    gripMenu.style.left = `${event.clientX}px`;
    gripMenu.style.top = `${event.clientY}px`;
    gripMenu.hidden = false;
    return;
  }
  if (drawingInteraction.isPointStep) {
    if (menuTitle) menuTitle.textContent = 'Object snap';
    gripMenu.querySelectorAll<HTMLButtonElement>('[data-grip-mode]').forEach((button) => {
      const mode = button.dataset.gripMode as GripMode;
      button.hidden = false;
      button.classList.toggle('active', drawingInteraction.targetSnapMode === mode);
    });
    gripMenu.style.left = `${event.clientX}px`;
    gripMenu.style.top = `${event.clientY}px`;
    gripMenu.hidden = false;
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
    gripMenu.hidden = true;
    return;
  }
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
    const mode = button.dataset.gripMode as GripMode;
    button.hidden = !allowed.has(mode);
    button.classList.toggle('active', gripController.mode === mode);
  });
  if (allowed.size === 0) return;
  gripMenu.style.left = `${event.clientX}px`;
  gripMenu.style.top = `${event.clientY}px`;
  gripMenu.hidden = false;
});

gripMenu.querySelectorAll<HTMLButtonElement>('[data-grip-mode]').forEach((button) => {
  button.addEventListener('click', () => {
    const mode = button.dataset.gripMode as GripMode;
    if (gripController.isDragging && gripInteraction.isLatched) gripInteraction.setTargetSnapMode(mode);
    else if (drawingInteraction.isPointStep) drawingInteraction.setTargetSnapMode(mode);
    else gripController.mode = mode;
    gripController.hoveredGrip = -1;
    gripMenu.hidden = true;
    redraw();
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
      prompt.textContent = 'Enter command:';
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
    const style = button.dataset.visualStyle as 'wireframe' | 'shaded';
    renderer3d.setVisualStyle(style);
    document.querySelectorAll('[data-visual-style]').forEach((item) => item.classList.toggle('active', item === button));
    log(`Visual style: ${style === 'wireframe' ? 'Wireframe' : 'Shaded with Edges'}.`);
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
get('file-menu-button').addEventListener('click', (event) => {
  event.stopPropagation();
  fileMenu.hidden = !fileMenu.hidden;
});
get('save-project').addEventListener('click', async () => {
  fileMenu.hidden = true;
  await projectController.save();
});
get('new-project').addEventListener('click', () => { fileMenu.hidden = true; projectController.newProject(); });
get('open-project').addEventListener('click', async () => {
  fileMenu.hidden = true;
  await projectController.open();
});
get('import-dxf').addEventListener('click', async () => {
  fileMenu.hidden = true;
  await projectController.importDxf();
});
get('export-stl').addEventListener('click', async () => {
  fileMenu.hidden = true;
  await projectController.exportStl();
});
window.addEventListener('pointerdown', (event) => {
  if (!fileMenu.contains(event.target as Node) && event.target !== get('file-menu-button')) fileMenu.hidden = true;
});
log('MyCAD ready. Enter HELP for a list of commands.');
resize();
