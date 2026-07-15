import './styles/app.css';
import { document as cadDocument } from './core/Document';
import { CommandManager, hitTestEntity, type CommandName } from './core/commands/CommandManager';
import { cloneEntity, curvePoints, entityBounds, getEntityPoints, transformEntityPoints, type Entity, type Solid, type SolidFeature } from './core/entities/types';
import { CommandHistory } from './core/history/CommandHistory';
import { AddEntitiesEdit, DeleteLayerEdit, ReplaceObjectsEdit, UpdateEntityEdit, UpdateSolidEdit, cloneSolid } from './core/history/edits';
import { snapPoint2, type Vec2 } from './math/geometry';
import { cloneWorkPlane, localToWorld, WORLD_WORK_PLANE, worldToLocal } from './math/workplane';
import { Canvas2DRenderer, Viewport3D } from './render/Viewport';
import { hitTestSolid2d, pickEntityAt, selectionExclusions, solidBounds } from './interaction/PickingService';
import { InputController } from './interaction/InputController';
import { GripController, type GripMode } from './interaction/GripController';
import { exportAsciiStl, loadProject, serializeProject, type ProjectViewState } from './io/ProjectIO';
import { importAsciiDxf } from './io/DxfImport';

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
const history = new CommandHistory(cadDocument);
const gripController = new GripController(cadDocument, history);

let width = 1;
let height = 1;
let panning = false;
let gripEditLatched = false;
let gripTargetSnapMode: GripMode | null = null;
let drawingTargetSnapMode: GripMode | null = null;
let ucsHoverPoint: { x: number; y: number; z: number } | null = null;
let suppressNextContextMenu = false;
let lastPointer = { x: 0, y: 0 };
let preview: { type: string; data: unknown } | undefined;
let dimensionTimer: ReturnType<typeof setTimeout> | undefined;
let selectionWindow: { start: Vec2; current: Vec2; additive: boolean; pointerId: number; purpose?: 'select' | 'zoom' } | null = null;
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
let currentProjectPath: string | undefined;

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
    renderer2d.render(cadDocument, width, height, preview, grips);
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
    renderer3d.syncPreview(preview);
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

function renderLayers(): void {
  get('layer-current').textContent = cadDocument.currentLayer;
  const selectedLayers = new Set([
    ...cadDocument.getSelectedEntities().map((entity) => entity.layer),
    ...cadDocument.getSelectedSolids().map((solid) => solid.layer),
  ]);
  const highlightedLayer = selectedLayers.size === 1 ? [...selectedLayers][0] : cadDocument.currentLayer;
  layerList.replaceChildren(...cadDocument.layers.map((name) => {
    const row = document.createElement('div');
    row.className = `layer-row${name === highlightedLayer ? ' active' : ''}`;
    const visible = !cadDocument.hiddenLayers.has(name);
    const count = cadDocument.entities.filter((entity) => entity.layer === name).length
      + cadDocument.solids.filter((solid) => solid.layer === name).length;
    const color = cadDocument.layerColors[name] ?? 0xffffff;
    row.innerHTML = `<button class="layer-eye" title="${visible ? 'Hide' : 'Show'} layer">${visible ? 'Hide' : 'Show'}</button><input class="layer-color" type="color" value="#${color.toString(16).padStart(6, '0')}" title="Layer color"><button class="layer-current-mark${name === cadDocument.currentLayer ? ' active' : ''}" title="Set current layer">${name === cadDocument.currentLayer ? '●' : '○'}</button><input class="layer-name" value="${name.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}" maxlength="32" aria-label="Layer name" ${name === '0' ? 'readonly' : ''}><span>${count}</span><button class="layer-delete" title="${name === '0' ? 'Layer 0 cannot be deleted' : `Delete layer and ${count} object(s)`}" aria-label="Delete layer" ${name === '0' ? 'disabled' : ''}>×</button>`;
    row.querySelector<HTMLButtonElement>('.layer-eye')!.addEventListener('click', (event) => {
      event.stopPropagation();
      if (visible) cadDocument.hiddenLayers.add(name); else cadDocument.hiddenLayers.delete(name);
      cadDocument.clearSelection();
      cadDocument.notify();
      renderLayers();
    });
    row.addEventListener('click', () => {
      cadDocument.currentLayer = name;
      cadDocument.hiddenLayers.delete(name);
      const entities = cadDocument.getSelectedEntities();
      const solids = cadDocument.getSelectedSolids();
      const layerColor = cadDocument.layerColors[name] ?? 0xffffff;
      entities.forEach((entity) => { entity.layer = name; entity.color = layerColor; });
      solids.forEach((solid) => { solid.layer = name; solid.color = layerColor; });
      if (entities.length + solids.length > 0) log(`Moved ${entities.length + solids.length} object(s) to layer ${name}.`);
      cadDocument.notify();
      renderLayers();
      redraw();
    });
    const nameInput = row.querySelector<HTMLInputElement>('.layer-name')!;
    const rename = (): void => {
      const nextName = nameInput.value.trim();
      if (!nextName || nextName === name) { nameInput.value = name; return; }
      if (cadDocument.layers.includes(nextName)) {
        nameInput.setCustomValidity('Layer already exists.');
        nameInput.reportValidity();
        nameInput.value = name;
        return;
      }
      nameInput.setCustomValidity('');
      const index = cadDocument.layers.indexOf(name);
      cadDocument.layers[index] = nextName;
      cadDocument.layerColors[nextName] = cadDocument.layerColors[name] ?? 0xffffff;
      delete cadDocument.layerColors[name];
      if (cadDocument.currentLayer === name) cadDocument.currentLayer = nextName;
      if (cadDocument.hiddenLayers.delete(name)) cadDocument.hiddenLayers.add(nextName);
      cadDocument.entities.filter((entity) => entity.layer === name).forEach((entity) => { entity.layer = nextName; });
      cadDocument.solids.filter((solid) => solid.layer === name).forEach((solid) => { solid.layer = nextName; });
      cadDocument.notify();
      renderLayers();
    };
    nameInput.addEventListener('change', rename);
    nameInput.addEventListener('click', (event) => event.stopPropagation());
    nameInput.addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); nameInput.blur(); } });
    const colorInput = row.querySelector<HTMLInputElement>('.layer-color')!;
    colorInput.addEventListener('click', (event) => event.stopPropagation());
    colorInput.addEventListener('input', (event) => {
      const nextColor = Number.parseInt((event.currentTarget as HTMLInputElement).value.slice(1), 16);
      cadDocument.layerColors[name] = nextColor;
      cadDocument.entities.filter((entity) => entity.layer === name).forEach((entity) => { entity.color = nextColor; });
      cadDocument.solids.filter((solid) => solid.layer === name).forEach((solid) => { solid.color = nextColor; });
      cadDocument.notify();
    });
    const deleteButton = row.querySelector<HTMLButtonElement>('.layer-delete')!;
    deleteButton.addEventListener('click', (event) => {
      event.stopPropagation();
      if (name === '0') return;
      history.execute(new DeleteLayerEdit(cadDocument, name));
      gripController.clear();
      log(`Deleted layer ${name} and ${count} object(s).`);
      renderLayers();
      redraw();
    });
    return row;
  }));
}

get('layer-toggle').addEventListener('click', () => {
  layerPanel.hidden = !layerPanel.hidden;
  if (!layerPanel.hidden) renderLayers();
});
get('layer-add').addEventListener('click', () => {
  let number = 1;
  while (cadDocument.layers.includes(`Layer ${number}`)) number++;
  const name = `Layer ${number}`;
  cadDocument.layers.push(name);
  cadDocument.layerColors[name] = 0xffffff;
  cadDocument.currentLayer = name;
  renderLayers();
  redraw();
  const inputs = layerList.querySelectorAll<HTMLInputElement>('.layer-name');
  const input = inputs[inputs.length - 1];
  input?.focus();
  input?.select();
});
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
  getCursor: () => renderer2d.screenToWorld(lastPointer.x, lastPointer.y, width, height),
  redraw,
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
    const targetedSnap = nearestGripTargetSnap(event, drawingTargetSnapMode);
    if (targetedSnap) return targetedSnap.point;
    const snap = nearestMeasurementPoint(event);
    if (snap) {
      const local = worldToLocal(cadDocument.activeWorkPlane, snap);
      return { x: local.x, y: local.y };
    }
  }
  if ((active?.name === 'ROTATE' || active?.name === 'MOVE') && active.steps[active.stepIndex]?.kind === 'point') {
    const targetedSnap = nearestGripTargetSnap(event, drawingTargetSnapMode);
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

function isDrawingPointStep(): boolean {
  const active = commands.active;
  return Boolean(active
    && (['LINE', 'RECTANGLE', 'CIRCLE', 'POLYGON', 'ARC', 'BEZIER', 'TEXT'].includes(active.name) || active.name === 'ROTATE' || active.name === 'MOVE')
    && active.steps[active.stepIndex]?.kind === 'point');
}

function rotatePreviewEntity(entity: Entity, base: Vec2, angle: number): Entity {
  const rotate = (point: Vec2): Vec2 => {
    const dx = point.x - base.x, dy = point.y - base.y;
    return {
      x: base.x + dx * Math.cos(angle) - dy * Math.sin(angle),
      y: base.y + dx * Math.sin(angle) + dy * Math.cos(angle),
    };
  };
  if (entity.type === 'rectangle') {
    const corners = [entity.first, { x: entity.opposite.x, y: entity.first.y }, entity.opposite, { x: entity.first.x, y: entity.opposite.y }];
    return {
      id: entity.id, type: 'polyline', layer: entity.layer, color: 0xe6f4ff, selected: false,
      workPlane: entity.workPlane, vertices: corners.map(rotate), closed: true,
    };
  }
  const result = cloneEntity(entity);
  result.color = 0xe6f4ff;
  result.selected = false;
  switch (result.type) {
    case 'line': result.start = rotate(result.start); result.end = rotate(result.end); break;
    case 'circle': result.center = rotate(result.center); break;
    case 'octagon': result.center = rotate(result.center); result.vertices = result.vertices.map(rotate); break;
    case 'polyline': result.vertices = result.vertices.map(rotate); break;
    case 'arc': result.center = rotate(result.center); result.startAngle += angle; break;
    case 'bezier': result.start = rotate(result.start); result.control1 = rotate(result.control1); result.control2 = rotate(result.control2); result.end = rotate(result.end); break;
    case 'text': result.position = rotate(result.position); result.rotation = (result.rotation ?? 0) + angle; break;
    case 'rectangle': break;
  }
  return result;
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
  const active = commands.active;
  preview = undefined;
  if (!active) return;
  if (active.name === 'UCS') {
    preview = {
      type: 'ucs',
      data: {
        origin: active.data.origin,
        xPoint: active.data.xPoint,
        yPoint: active.data.yPoint,
        hover: ucsHoverPoint,
        step: active.stepIndex,
      },
    };
    return;
  }
  if (active.name === 'POLYGON' && active.stepIndex === 2 && active.data.center && active.data.sides) {
    preview = { type: 'polygon', data: { center: active.data.center, cursor, sides: active.data.sides } };
    return;
  }
  if (active.name === 'ARC') {
    if (active.stepIndex === 1 && active.data.center) preview = { type: 'circle', data: { center: active.data.center, cursor } };
    else if (active.stepIndex === 2 && active.data.center && active.data.start) preview = { type: 'arc', data: { center: active.data.center, start: active.data.start, cursor } };
    return;
  }
  if (active.name === 'BEZIER' && active.data.start) {
    preview = { type: 'bezier', data: { start: active.data.start, control1: active.data.control1 ?? cursor, control2: active.data.control2 ?? cursor, end: cursor } };
    return;
  }
  if (active.name === 'MOVE' && active.stepIndex === 2 && active.data.basePoint) {
    preview = { type: 'line', data: { start: active.data.basePoint, end: cursor } };
    return;
  }
  if (active.name === 'ROTATE' && active.stepIndex === 2 && active.data.basePoint) {
    const base = active.data.basePoint as Vec2;
    const angle = Math.atan2(cursor.y - base.y, cursor.x - base.x);
    const entities = (active.data.entities as Entity[]).map((entity) => rotatePreviewEntity(entity, base, angle));
    preview = { type: 'rotate', data: { start: base, end: cursor, entities } };
    return;
  }
  if (active.stepIndex !== 1) return;
  if (active.name === 'LINE' && active.data.start) {
    preview = { type: 'line', data: { start: active.data.start, end: cursor } };
  } else if (active.name === 'RECTANGLE' && active.data.start) {
    preview = { type: 'rectangle', data: { start: active.data.start, end: cursor } };
  } else if (active.name === 'CIRCLE' && active.data.center) {
    preview = { type: 'circle', data: { center: active.data.center, cursor } };
  } else if (active.name === 'OCTAGON' && active.data.center) {
    preview = { type: 'octagon', data: { center: active.data.center, cursor } };
  }
}

function showDimension(text: string | null, x: number, y: number): void {
  if (!text) return;
  dimensionToast.textContent = text;
  dimensionToast.style.left = `${x + 16}px`;
  dimensionToast.style.top = `${y - 34}px`;
  dimensionToast.hidden = false;
  if (dimensionTimer) clearTimeout(dimensionTimer);
  dimensionTimer = setTimeout(() => { dimensionToast.hidden = true; }, 1200);
}

function positionMeasureMarker(marker: HTMLElement, x: number, y: number): void {
  marker.style.left = `${x}px`;
  marker.style.top = `${y}px`;
  marker.hidden = false;
}

function positionSnapMarker(point: { x: number; y: number; z: number }, fallbackX: number, fallbackY: number): void {
  if (cadDocument.viewMode === '3d') {
    const projected = renderer3d.projectCadPoint(renderer3d.renderer.domElement, point);
    if (projected) {
      positionMeasureMarker(snapMarker, projected.x, projected.y);
      return;
    }
  }
  positionMeasureMarker(snapMarker, fallbackX, fallbackY);
}

async function saveTextFile(content: string, defaultPath: string, name: string, extension: string): Promise<string | undefined> {
  if (window.mycadAPI) {
    const result = await window.mycadAPI.saveFile({
      content,
      defaultPath,
      filters: [{ name, extensions: [extension] }],
    });
    if (!result.canceled) log(`Saved: ${result.filePath ?? defaultPath}`);
    return result.canceled ? undefined : result.filePath;
  }
  const blob = new Blob([content], { type: extension === 'stl' ? 'model/stl' : 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = defaultPath;
  link.click();
  URL.revokeObjectURL(url);
  log(`Downloaded: ${defaultPath}`);
  return undefined;
}

async function saveProject(): Promise<void> {
  try {
    const content = serializeProject(cadDocument, captureProjectView());
    if (window.mycadAPI && currentProjectPath) {
      await window.mycadAPI.writeFile({ filePath: currentProjectPath, content });
      log(`Saved: ${currentProjectPath}`);
      return;
    }
    const filePath = await saveTextFile(content, 'model.mycad', 'MyCAD project', 'mycad');
    if (filePath) currentProjectPath = filePath;
  } catch (error) {
    log(`Save failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function quickSaveProject(): Promise<void> {
  try {
    const content = serializeProject(cadDocument, captureProjectView());
    if (window.mycadAPI?.quickSave) {
      const result = await window.mycadAPI.quickSave({ filePath: currentProjectPath, content });
      currentProjectPath = result.filePath;
      log(`Saved: ${result.filePath}`);
      return;
    }
    if (currentProjectPath && window.mycadAPI) {
      await window.mycadAPI.writeFile({ filePath: currentProjectPath, content });
      log(`Saved: ${currentProjectPath}`);
      return;
    }
    await saveTextFile(content, 'model.mycad', 'MyCAD project', 'mycad');
  } catch (error) {
    log(`Save failed: ${error instanceof Error ? error.message : String(error)}`);
  }
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
  if (cadDocument.viewMode === '3d') {
    return renderer3d.nearestMeasurementPoint(
      renderer3d.renderer.domElement, cadDocument.entities, cadDocument.solids,
      event.clientX, event.clientY, pixelTolerance,
    );
  }
  const cursor = rawWorldPoint(event);
  const tolerance = pixelTolerance / renderer2d.zoom;
  let best = tolerance;
  let result: { x: number; y: number; z: number } | null = null;
  const consider = (point: { x: number; y: number; z?: number }): void => {
    const distance = Math.hypot(cursor.x - point.x, cursor.y - point.y);
    if (distance <= best) {
      best = distance;
      result = { x: point.x, y: point.y, z: point.z ?? 0 };
    }
  };
  cadDocument.entities.forEach((entity) => getEntityPoints(entity).forEach(consider));
  cadDocument.solids.forEach((solid) => {
    for (let i = 0; i < solid.mesh.positions.length; i += 3) {
      consider({ x: solid.mesh.positions[i], y: solid.mesh.positions[i + 1], z: solid.mesh.positions[i + 2] });
    }
  });
  return result;
}

type GripSnapTarget = { point: Vec2; world: { x: number; y: number; z: number } };

function nearestGripTargetSnap(
  event: Pick<PointerEvent, 'clientX' | 'clientY'>,
  mode: GripMode | null = gripTargetSnapMode,
  pixelTolerance = 14,
): GripSnapTarget | null {
  if (!mode) return null;
  const draggedId = gripController.draggingObjectId;
  const candidates: Array<{ x: number; y: number; z: number }> = [];
  const addLocal = (entity: Entity, point: Vec2): void => {
    candidates.push(localToWorld(entity.workPlane ?? WORLD_WORK_PLANE, point));
  };
  const midpoint = (a: Vec2, b: Vec2): Vec2 => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

  for (const entity of cadDocument.entities) {
    if (entity.id === draggedId) continue;
    if (mode === 'end') {
      if (entity.type === 'line') [entity.start, entity.end].forEach((point) => addLocal(entity, point));
      else if (entity.type === 'rectangle') {
        [entity.first, { x: entity.opposite.x, y: entity.first.y }, entity.opposite, { x: entity.first.x, y: entity.opposite.y }]
          .forEach((point) => addLocal(entity, point));
      } else if (entity.type === 'polyline' || entity.type === 'octagon') {
        entity.vertices.forEach((point) => addLocal(entity, point));
      } else if (entity.type === 'arc' || entity.type === 'bezier') {
        const points = curvePoints(entity, 2);
        addLocal(entity, points[0]);
        addLocal(entity, points[2]);
      } else if (entity.type === 'text') addLocal(entity, entity.position);
    } else if (mode === 'center') {
      if (entity.type === 'circle' || entity.type === 'arc' || entity.type === 'octagon') addLocal(entity, entity.center);
      else if (entity.type === 'rectangle') addLocal(entity, midpoint(entity.first, entity.opposite));
      else if (entity.type === 'bezier') addLocal(entity, curvePoints(entity, 2)[1]);
      else if (entity.type === 'text') addLocal(entity, entity.position);
    } else {
      if (entity.type === 'line') addLocal(entity, midpoint(entity.start, entity.end));
      else if (entity.type === 'arc' || entity.type === 'bezier') addLocal(entity, curvePoints(entity, 2)[1]);
      else if (entity.type === 'rectangle') {
        const corners = [entity.first, { x: entity.opposite.x, y: entity.first.y }, entity.opposite, { x: entity.first.x, y: entity.opposite.y }];
        corners.forEach((point, index) => addLocal(entity, midpoint(point, corners[(index + 1) % corners.length])));
      } else if (entity.type === 'polyline' || entity.type === 'octagon') {
        const last = entity.type === 'octagon' || entity.closed ? entity.vertices.length : entity.vertices.length - 1;
        for (let index = 0; index < last; index++) {
          addLocal(entity, midpoint(entity.vertices[index], entity.vertices[(index + 1) % entity.vertices.length]));
        }
      }
    }
  }

  for (const solid of cadDocument.solids) {
    if (solid.id === draggedId) continue;
    const positions = solid.mesh.positions;
    if (mode === 'end') {
      for (let index = 0; index < positions.length; index += 3) {
        candidates.push({ x: positions[index], y: positions[index + 1], z: positions[index + 2] });
      }
    } else if (mode === 'center') {
      const bounds = solidBounds(solid);
      candidates.push({ x: (bounds.minX + bounds.maxX) / 2, y: (bounds.minY + bounds.maxY) / 2, z: (bounds.minZ + bounds.maxZ) / 2 });
    } else {
      const indices = solid.mesh.indices;
      const seen = new Set<string>();
      for (let index = 0; index < indices.length; index += 3) {
        const triangle = [indices[index], indices[index + 1], indices[index + 2]];
        for (const [a, b] of [[triangle[0], triangle[1]], [triangle[1], triangle[2]], [triangle[2], triangle[0]]]) {
          const key = a < b ? `${a}:${b}` : `${b}:${a}`;
          if (seen.has(key)) continue;
          seen.add(key);
          candidates.push({
            x: (positions[a * 3] + positions[b * 3]) / 2,
            y: (positions[a * 3 + 1] + positions[b * 3 + 1]) / 2,
            z: (positions[a * 3 + 2] + positions[b * 3 + 2]) / 2,
          });
        }
      }
    }
  }

  let bestDistance = pixelTolerance;
  let bestWorld: { x: number; y: number; z: number } | null = null;
  if (cadDocument.viewMode === '3d') {
    const rect = viewport.getBoundingClientRect();
    const cursor = { x: event.clientX - rect.left, y: event.clientY - rect.top };
    for (const candidate of candidates) {
      const projected = renderer3d.projectCadPoint(renderer3d.renderer.domElement, candidate);
      if (!projected) continue;
      const distance = Math.hypot(projected.x - cursor.x, projected.y - cursor.y);
      if (distance <= bestDistance) { bestDistance = distance; bestWorld = candidate; }
    }
  } else {
    const cursor = rawWorldPoint(event);
    const tolerance = pixelTolerance / renderer2d.zoom;
    let bestLocalDistance = tolerance;
    for (const candidate of candidates) {
      const local = worldToLocal(cadDocument.activeWorkPlane, candidate);
      const distance = Math.hypot(local.x - cursor.x, local.y - cursor.y);
      if (distance <= bestLocalDistance) { bestLocalDistance = distance; bestWorld = candidate; }
    }
  }
  if (!bestWorld) return null;
  const local = worldToLocal(cadDocument.activeWorkPlane, bestWorld);
  return { point: { x: local.x, y: local.y }, world: bestWorld };
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
  if (!layerPanel.hidden) renderLayers();
});
new ResizeObserver(resize).observe(viewport);

viewport.addEventListener('pointermove', (event) => {
  const rect = viewport.getBoundingClientRect();
  const sx = event.clientX - rect.left;
  const sy = event.clientY - rect.top;
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
  if (selectionWindow) {
    selectionWindow.current = { x: sx, y: sy };
    const left = Math.min(selectionWindow.start.x, sx);
    const top = Math.min(selectionWindow.start.y, sy);
    selectionWindowElement.style.left = `${left}px`;
    selectionWindowElement.style.top = `${top}px`;
    selectionWindowElement.style.width = `${Math.abs(sx - selectionWindow.start.x)}px`;
    selectionWindowElement.style.height = `${Math.abs(sy - selectionWindow.start.y)}px`;
    selectionWindowElement.classList.toggle('crossing', selectionWindow.purpose !== 'zoom' && sx < selectionWindow.start.x);
    if (selectionWindow.purpose === 'zoom') prompt.textContent = 'Specify opposite corner of zoom window:';
    return;
  }
  if (panning) {
    if (cadDocument.viewMode === '2d') {
      renderer2d.pan.x -= (sx - lastPointer.x) / renderer2d.zoom;
      renderer2d.pan.y += (sy - lastPointer.y) / renderer2d.zoom;
    } else {
      renderer3d.panByScreenDelta(sx - lastPointer.x, sy - lastPointer.y);
    }
    redraw();
  }
  lastPointer = { x: sx, y: sy };
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
    else if (gripTargetSnapMode) snapMarker.hidden = true;
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
  crosshair.style.left = `${sx}px`;
  crosshair.style.top = `${sy}px`;
  updatePreview(p);
  const active = commands.active;
  if (active?.name === 'ROTATE' && active.stepIndex === 2 && active.data.basePoint) {
    const base = active.data.basePoint as Vec2;
    const angle = Math.atan2(p.y - base.y, p.x - base.x) * 180 / Math.PI;
    showDimension(`Angle ${angle.toFixed(2)}°`, sx, sy);
  }
  const targetedDrawingSnap = isDrawingPointStep() ? nearestGripTargetSnap(event, drawingTargetSnapMode) : null;
  const drawingSnap = isDrawingPointStep()
    ? targetedDrawingSnap?.world ?? (drawingTargetSnapMode ? null : nearestMeasurementPoint(event))
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
  } else if (!gripController.isDragging || !gripTargetSnapMode) {
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
    const rect = viewport.getBoundingClientRect();
    const point = { x: event.clientX - rect.left, y: event.clientY - rect.top };
    selectionWindow = { start: point, current: point, additive: false, pointerId: event.pointerId, purpose: 'zoom' };
    selectionWindowElement.hidden = false;
    selectionWindowElement.classList.remove('crossing');
    viewport.setPointerCapture(event.pointerId);
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
    if (gripController.isDragging && gripEditLatched) return;
    if (isDrawingPointStep()) return;
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
    panning = true;
    const rect = viewport.getBoundingClientRect();
    lastPointer = { x: event.clientX - rect.left, y: event.clientY - rect.top };
    viewport.classList.add('is-panning');
    viewport.setPointerCapture(event.pointerId);
    event.preventDefault();
    return;
  }
  if (event.button !== 0) return;
  if (gripController.isDragging && gripEditLatched) {
    const snap = nearestGripTargetSnap(event);
    const point = gripEditingPoint(event, snap);
    if (point) gripController.update(point);
    gripController.commit();
    gripEditLatched = false;
    gripTargetSnapMode = null;
    snapMarker.hidden = true;
    gripController.hoveredGrip = -1;
    if (viewport.hasPointerCapture(event.pointerId)) viewport.releasePointerCapture(event.pointerId);
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
      gripController.begin(selected, selectedBody, gripIndex, gripPoint);
      gripEditLatched = true;
      viewport.setPointerCapture(event.pointerId);
      event.preventDefault();
      return;
    }
    const entity = pickEntityAt(cadDocument, point, 8 / renderer2d.zoom)
      ?? (commands.active?.name === 'EXTRUDE' ? profileContainingPoint(point) : undefined);
    const solid = hitTestSolid2d(cadDocument, rawWorldPoint(event), solidSelectionExclusions());
    if (commands.active) {
      const consumeDrawingSnap = isDrawingPointStep() && drawingTargetSnapMode !== null;
      await commands.handleClick(point, entity ?? undefined, solid?.id);
      if (consumeDrawingSnap) drawingTargetSnapMode = null;
    }
    else if (entity) {
      if (!cadDocument.selectedEntityIds.has(entity.id)) gripController.mode = null;
      cadDocument.selectEntity(entity.id, event.shiftKey);
    } else if (solid) {
      if (!cadDocument.selectedSolidIds.has(solid.id)) gripController.mode = null;
      cadDocument.selectSolid(solid.id, event.shiftKey);
    } else {
      gripController.mode = null;
      const rect = viewport.getBoundingClientRect();
      selectionWindow = {
        start: { x: event.clientX - rect.left, y: event.clientY - rect.top },
        current: { x: event.clientX - rect.left, y: event.clientY - rect.top },
        additive: event.shiftKey,
        pointerId: event.pointerId,
        purpose: 'select',
      };
      selectionWindowElement.hidden = false;
      selectionWindowElement.classList.remove('crossing');
      viewport.setPointerCapture(event.pointerId);
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
      if (!commands.active) preview = undefined;
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
      gripController.begin(selected, selectedBody, gripIndex, gripPoint);
      gripEditLatched = true;
      viewport.setPointerCapture(event.pointerId);
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
      const consumeDrawingSnap = isDrawingPointStep() && drawingTargetSnapMode !== null;
      await commands.handleClick(point, entity ?? undefined, solidId ?? undefined, face ?? undefined);
      if (consumeDrawingSnap) drawingTargetSnapMode = null;
    }
    else if (entity) cadDocument.selectEntity(entity.id, event.shiftKey);
    else if (solidId) cadDocument.selectSolid(solidId, event.shiftKey);
    else {
      cadDocument.clearSelection();
    }
  }
  if (!commands.active || commands.active.stepIndex === 0) preview = undefined;
  input.focus();
});

window.addEventListener('pointerup', (event) => {
  if (selectionWindow && event.pointerId === selectionWindow.pointerId) {
    const selection = selectionWindow;
    selectionWindow = null;
    selectionWindowElement.hidden = true;
    const moved = Math.hypot(selection.current.x - selection.start.x, selection.current.y - selection.start.y);
    if (selection.purpose === 'zoom') {
      zoomWindowMode = false;
      document.querySelector<HTMLButtonElement>('[data-view-action="zoom-window"]')?.classList.remove('active');
      if (moved >= 4) {
        if (cadDocument.viewMode === '2d') {
          const a = renderer2d.screenToWorld(selection.start.x, selection.start.y, width, height);
          const b = renderer2d.screenToWorld(selection.current.x, selection.current.y, width, height);
          renderer2d.zoomWindow(a, b, width, height);
        } else {
          renderer3d.zoomScreenWindow(
            selection.start.x, selection.start.y,
            selection.current.x, selection.current.y,
            width, height,
          );
        }
      }
      if (viewport.hasPointerCapture(event.pointerId)) viewport.releasePointerCapture(event.pointerId);
      prompt.textContent = 'Enter command:';
      redraw();
      return;
    }
    if (moved < 4) {
      if (!selection.additive) cadDocument.clearSelection();
    } else {
      const a = renderer2d.screenToWorld(selection.start.x, selection.start.y, width, height);
      const b = renderer2d.screenToWorld(selection.current.x, selection.current.y, width, height);
      const box = { minX: Math.min(a.x, b.x), maxX: Math.max(a.x, b.x), minY: Math.min(a.y, b.y), maxY: Math.max(a.y, b.y) };
      const crossing = selection.current.x < selection.start.x;
      if (!selection.additive) {
        cadDocument.selectedEntityIds.clear();
        cadDocument.selectedSolidIds.clear();
      }
      for (const entity of cadDocument.entities) {
        const bounds = entityBounds(entity);
        const inside = bounds.min.x >= box.minX && bounds.max.x <= box.maxX && bounds.min.y >= box.minY && bounds.max.y <= box.maxY;
        const intersects = bounds.max.x >= box.minX && bounds.min.x <= box.maxX && bounds.max.y >= box.minY && bounds.min.y <= box.maxY;
        if (inside || (crossing && intersects)) cadDocument.selectedEntityIds.add(entity.id);
      }
      for (const solid of cadDocument.solids) {
        const bounds = solidBounds(solid);
        const inside = bounds.minX >= box.minX && bounds.maxX <= box.maxX && bounds.minY >= box.minY && bounds.maxY <= box.maxY;
        const intersects = bounds.maxX >= box.minX && bounds.minX <= box.maxX && bounds.maxY >= box.minY && bounds.minY <= box.maxY;
        if (inside || (crossing && intersects)) cadDocument.selectedSolidIds.add(solid.id);
      }
      cadDocument.pruneSelection();
      cadDocument.notify();
    }
    gripController.mode = null;
    gripController.hoveredGrip = -1;
    if (viewport.hasPointerCapture(event.pointerId)) viewport.releasePointerCapture(event.pointerId);
    redraw();
    return;
  }
  panning = false;
  viewport.classList.remove('is-panning');
  if (!gripEditLatched) gripController.commit();
  if (viewport.hasPointerCapture(event.pointerId)) viewport.releasePointerCapture(event.pointerId);
});
new InputController({
  escape: () => {
    gripController.cancel();
    gripEditLatched = false;
    gripTargetSnapMode = null;
    drawingTargetSnapMode = null;
    ucsHoverPoint = null;
    zoomWindowMode = false;
    selectionWindow = null;
    selectionWindowElement.hidden = true;
    document.querySelector<HTMLButtonElement>('[data-view-action="zoom-window"]')?.classList.remove('active');
    commands.cancelActive();
    preview = undefined;
    gripController.mode = null;
    gripController.hoveredGrip = -1;
    gripMenu.hidden = true;
    renderer3d.clearFaceHighlight();
    measureOrigin.hidden = true;
    measureTarget.hidden = true;
    snapMarker.hidden = true;
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
});
canvas2d.addEventListener('wheel', (event) => {
  event.preventDefault();
  event.stopPropagation();
  if (event.metaKey) {
    if (Math.abs(event.deltaX) > 0.01 || Math.abs(event.deltaY) > 0.01) {
      enter3dForOrbit();
      renderer3d.orbitByScreenDelta(event.deltaX * 0.6, event.deltaY * 0.6);
      renderer3d.render();
    }
    return;
  }
  const before = renderer2d.screenToWorld(event.offsetX, event.offsetY, width, height);
  // macOS trackpad: two fingers up zooms in, two fingers down zooms out.
  // Large imported drawings can legitimately need far less than 2 px/mm to fit.
  // Use the gesture magnitude for smooth zooming and keep only numerical limits.
  const zoomFactor = Math.exp(-event.deltaY * 0.0025);
  renderer2d.zoom = Math.max(1e-6, Math.min(100_000, renderer2d.zoom * zoomFactor));
  const after = renderer2d.screenToWorld(event.offsetX, event.offsetY, width, height);
  renderer2d.pan.x += before.x - after.x;
  renderer2d.pan.y += before.y - after.y;
  redraw();
}, { passive: false });

get<HTMLFormElement>('command-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const gripDistance = input.value.trim().match(/^@([+-]?(?:\d+(?:\.\d*)?|\.\d+))$/);
  if (gripController.isDragging && gripEditLatched && gripDistance) {
    const distance = Number(gripDistance[1]);
    input.value = '';
    if (gripController.applyRelativeDistance(distance)) {
      gripController.commit();
      gripEditLatched = false;
      gripTargetSnapMode = null;
      gripController.hoveredGrip = -1;
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
  if (!commands.active) preview = undefined;
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
    preview = { type: 'text', data: { position: commands.active.data.position, text: input.value, font: commands.active.data.font, height: commands.active.data.height } };
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
  if (gripController.isDragging && gripEditLatched) {
    if (menuTitle) menuTitle.textContent = 'Object snap';
    gripMenu.querySelectorAll<HTMLButtonElement>('[data-grip-mode]').forEach((button) => {
      const mode = button.dataset.gripMode as GripMode;
      button.hidden = false;
      button.classList.toggle('active', gripTargetSnapMode === mode);
    });
    gripMenu.style.left = `${event.clientX}px`;
    gripMenu.style.top = `${event.clientY}px`;
    gripMenu.hidden = false;
    return;
  }
  if (isDrawingPointStep()) {
    if (menuTitle) menuTitle.textContent = 'Object snap';
    gripMenu.querySelectorAll<HTMLButtonElement>('[data-grip-mode]').forEach((button) => {
      const mode = button.dataset.gripMode as GripMode;
      button.hidden = false;
      button.classList.toggle('active', drawingTargetSnapMode === mode);
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
    if (gripController.isDragging && gripEditLatched) gripTargetSnapMode = mode;
    else if (isDrawingPointStep()) drawingTargetSnapMode = mode;
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
    gripController.cancel();
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
  snapMarker.hidden = true;
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
  await saveProject();
});
function newProject(): void {
  fileMenu.hidden = true;
  if ((cadDocument.entities.length > 0 || cadDocument.solids.length > 0)
    && !window.confirm('Create a new project? Unsaved changes will be lost.')) return;
  commands.cancelActive();
  gripController.clear();
  cadDocument.transaction(() => {
    cadDocument.entities = [];
    cadDocument.solids = [];
    cadDocument.selectedEntityIds.clear();
    cadDocument.selectedSolidIds.clear();
    cadDocument.currentLayer = '0';
    cadDocument.layers = ['0'];
    cadDocument.layerColors = { '0': 0xffffff };
    cadDocument.hiddenLayers.clear();
    cadDocument.gridSize = 1;
    cadDocument.snapSize = 0.5;
    cadDocument.snapEnabled = true;
    cadDocument.viewMode = '2d';
    cadDocument.activeWorkPlane = cloneWorkPlane(WORLD_WORK_PLANE);
    cadDocument.notify();
  });
  history.clear();
  currentProjectPath = undefined;
  preview = undefined;
  renderer2d.pan = { x: 0, y: 0 };
  renderer2d.zoom = 20;
  renderer3d.clearFaceHighlight();
  renderer3d.clearEdgeHighlight();
  renderer3d.setWorkPlane(cadDocument.activeWorkPlane);
  renderer3d.frameContent([], []);
  snapMarker.hidden = true;
  measureOrigin.hidden = true;
  measureTarget.hidden = true;
  logElement.replaceChildren();
  log('New project created.');
  redraw();
  input.focus();
}
get('new-project').addEventListener('click', newProject);
get('open-project').addEventListener('click', async () => {
  fileMenu.hidden = true;
  try {
    let content: string | undefined;
    let fileName = 'project.mycad';
    if (window.mycadAPI) {
      const result = await window.mycadAPI.openFile({ filters: [{ name: 'MyCAD project', extensions: ['mycad'] }] });
      if (result.canceled) return;
      content = result.content;
      fileName = result.filePath ?? fileName;
      currentProjectPath = result.filePath;
    } else {
      const picker = document.createElement('input');
      picker.type = 'file';
      picker.accept = '.mycad,application/json';
      const file = await new Promise<File | undefined>((resolve) => {
        picker.addEventListener('change', () => resolve(picker.files?.[0]), { once: true });
        picker.click();
      });
      if (!file) return;
      content = await file.text();
      fileName = file.name;
    }
    if (!content) throw new Error('The file is empty.');
    commands.cancelActive();
    gripController.clear();
    const savedView = loadProject(cadDocument, content);
    renderer3d.setWorkPlane(cadDocument.activeWorkPlane);
    if (savedView) {
      renderer2d.pan = { ...savedView.twoD.pan };
      renderer2d.zoom = savedView.twoD.zoom;
      renderer3d.restoreViewState(savedView.threeD);
    }
    history.clear();
    preview = undefined;
    if (!savedView) renderer2d.zoomExtents(cadDocument, width, height);
    log(`Opened: ${fileName}`);
    redraw();
  } catch (error) {
    log(`Open failed: ${error instanceof Error ? error.message : String(error)}`);
  }
});
get('import-dxf').addEventListener('click', async () => {
  fileMenu.hidden = true;
  try {
    let content: string | undefined;
    let fileName = 'drawing.dxf';
    if (window.mycadAPI) {
      const result = await window.mycadAPI.openFile({ filters: [{ name: 'AutoCAD DXF', extensions: ['dxf'] }] });
      if (result.canceled) return;
      content = result.content;
      fileName = result.filePath ?? fileName;
    } else {
      const picker = document.createElement('input');
      picker.type = 'file';
      picker.accept = '.dxf,application/dxf';
      const file = await new Promise<File | undefined>((resolve) => {
        picker.addEventListener('change', () => resolve(picker.files?.[0]), { once: true });
        picker.click();
      });
      if (!file) return;
      content = await file.text();
      fileName = file.name;
    }
    if (!content) throw new Error('The file is empty.');
    commands.cancelActive();
    gripController.clear();
    const result = importAsciiDxf(cadDocument, content);
    if (result.entities.length === 0) throw new Error('No supported 2D entities were found.');
    result.layers.forEach((layer) => {
      if (!cadDocument.layers.includes(layer)) cadDocument.layers.push(layer);
      cadDocument.layerColors[layer] ??= 0xffffff;
    });
    // Switch before the history edit notifies subscribers. Otherwise importing
    // from a 3D view needlessly constructs a Three.js object for every DXF item.
    cadDocument.viewMode = '2d';
    cadDocument.transaction(() => {
      cadDocument.clearSelection();
      history.execute(new AddEntitiesEdit('Import DXF', result.entities));
    });
    renderer2d.zoomExtents(cadDocument, width, height);
    renderLayers();
    log(`Imported DXF: ${fileName} · ${result.entities.length} object(s)${result.ignored ? ` · ${result.ignored} unsupported object(s) skipped` : ''}.`);
    redraw();
  } catch (error) {
    log(`DXF import failed: ${error instanceof Error ? error.message : String(error)}`);
  }
});
get('export-stl').addEventListener('click', async () => {
  fileMenu.hidden = true;
  if (cadDocument.solids.length === 0) {
    log('STL export: the document contains no 3D solids.');
    return;
  }
  await saveTextFile(exportAsciiStl(cadDocument), 'model.stl', 'STL model', 'stl');
});
window.addEventListener('pointerdown', (event) => {
  if (!fileMenu.contains(event.target as Node) && event.target !== get('file-menu-button')) fileMenu.hidden = true;
});
window.addEventListener('keydown', (event) => {
  if (event.target instanceof HTMLInputElement && event.target !== input) return;
  if ((event.key === 'Delete' || event.key === 'Backspace')
    && (cadDocument.selectedEntityIds.size > 0 || cadDocument.selectedSolidIds.size > 0)) {
    event.preventDefault();
    event.stopPropagation();
    gripController.cancel();
    const entities = cadDocument.getSelectedEntities().map(cloneEntity);
    const solids = cadDocument.getSelectedSolids().map(cloneSolid);
    history.execute(new ReplaceObjectsEdit('Delete selected objects', entities, solids, [], []));
    gripController.mode = null;
    gripController.hoveredGrip = -1;
    preview = undefined;
    log(`Deleted objects: ${entities.length + solids.length}`);
    redraw();
    return;
  }
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
    event.preventDefault();
    void quickSaveProject();
    return;
  }
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'n') {
    event.preventDefault();
    newProject();
    return;
  }
  if (event.metaKey && event.key.toLowerCase() === 'o') {
    event.preventDefault();
    get<HTMLButtonElement>('open-project').click();
    return;
  }
  if (event.metaKey && event.key.toLowerCase() === 'e') {
    event.preventDefault();
    get<HTMLButtonElement>('export-stl').click();
    return;
  }
});

// Capture typing before a toolbar button or the WebGL canvas can consume it.
// This makes numeric command entry independent of the currently focused UI node.
window.addEventListener('keydown', (event) => {
  const target = event.target as HTMLElement | null;
  const isTextEntry = target instanceof HTMLInputElement
    || target instanceof HTMLTextAreaElement
    || target instanceof HTMLSelectElement
    || Boolean(target?.isContentEditable);
  if ((event.key === ' ' || event.code === 'Space') && !isTextEntry && !event.metaKey && !event.ctrlKey && !event.altKey) {
    event.preventDefault();
    event.stopPropagation();
    if (event.repeat) return;
    cadDocument.viewMode = '2d';
    cadDocument.notify();
    redraw();
    return;
  }
  if (isTextEntry || event.metaKey || event.ctrlKey || event.altKey) return;
  if (event.key === 'Enter') {
    event.preventDefault();
    event.stopPropagation();
    input.focus({ preventScroll: true });
    get<HTMLFormElement>('command-form').requestSubmit();
  } else if (event.key === 'Backspace') {
    if (!commands.active && input.value.length === 0) return;
    event.preventDefault();
    event.stopPropagation();
    input.value = input.value.slice(0, -1);
    input.focus({ preventScroll: true });
  } else if (event.key.length === 1) {
    event.preventDefault();
    event.stopPropagation();
    input.value += event.key;
    input.focus({ preventScroll: true });
    input.setSelectionRange(input.value.length, input.value.length);
    suggestionIndex = 0;
    updateCommandSuggestions();
  }
}, { capture: true });
log('MyCAD ready. Enter HELP for a list of commands.');
resize();
