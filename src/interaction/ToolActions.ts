import type { Vec2 } from '../math/geometry';
import type { Document } from '../core/Document';
import type { CommandHistory } from '../core/history/CommandHistory';
import { ReplaceObjectsEdit, cloneSolid } from '../core/history/edits';
import { cloneEntity } from '../core/entities/types';
import { hitTestEntity } from '../core/commands/CommandManager';
import { hitTestSolid2d } from './PickingService';
import { type GripMode } from './GripController';
import type { GripController } from './GripController';
import type { GripInteractionController } from './GripInteractionController';
import type { DrawingInteractionController } from './DrawingInteractionController';
import type { ObjectSnapMode } from './SnapService';
import type { Canvas2DRenderer } from '../render/Canvas2DRenderer';
import type { Viewport3D } from '../render/Viewport3D';
import type { PreviewController } from '../ui/PreviewController';

export interface ToolActionsContext {
  doc: Document;
  history: CommandHistory;
  gripController: GripController;
  gripInteraction: GripInteractionController;
  drawingInteraction: DrawingInteractionController;
  previewController: PreviewController;
  renderer2d: Canvas2DRenderer;
  renderer3d: Viewport3D;
  rawWorldPoint: (event: Pick<PointerEvent, 'clientX' | 'clientY'>) => Vec2;
  rawWorldPoint3d: (event: Pick<PointerEvent, 'clientX' | 'clientY'>) => Vec2 | null;
  gripMenu: HTMLElement;
  viewport: HTMLElement;
  trackingLine: HTMLElement;
  size(): { width: number; height: number };
  log: (message: string) => void;
  redraw: () => void;
}

/**
 * Document- and view-level actions the toolbar, menus and keyboard fire:
 * deleting the selection, the drafting/grid/area toggles, and the object-snap
 * context menu. Extracted from main.ts verbatim; shared bindings arrive through
 * `ctx`. The toolbar and InputController read these eagerly, so the factory is
 * wired before those listeners are registered.
 */
export function createToolActions(ctx: ToolActionsContext) {
  const {
    doc, history, gripController, gripInteraction, drawingInteraction, previewController,
    renderer2d, renderer3d, rawWorldPoint, rawWorldPoint3d, gripMenu, viewport, trackingLine, log, redraw,
  } = ctx;

  function deleteSelectedObjects(): boolean {
    if (doc.selectedEntityIds.size === 0 && doc.selectedSolidIds.size === 0) return false;
    gripInteraction.cancel();
    const entities = doc.getSelectedEntities().map(cloneEntity);
    const solids = doc.getSelectedSolids().map(cloneSolid);
    history.execute(new ReplaceObjectsEdit('Delete selected objects', entities, solids, [], []));
    gripController.mode = null;
    gripController.hoveredGrip = -1;
    previewController.clearPreview();
    log(`Deleted objects: ${entities.length + solids.length}`);
    redraw();
    return true;
  }

  function toggleDraftingMode(mode: 'objectSnapEnabled' | 'orthoEnabled' | 'polarEnabled' | 'objectSnapTrackingEnabled', label: string): void {
    const enabled = !doc.drafting[mode];
    doc.drafting[mode] = enabled;
    if (enabled && mode === 'orthoEnabled') doc.drafting.polarEnabled = false;
    if (enabled && mode === 'polarEnabled') doc.drafting.orthoEnabled = false;
    if (!enabled && (mode === 'orthoEnabled' || mode === 'polarEnabled')) trackingLine.hidden = true;
    log(`${label}: ${doc.drafting[mode] ? 'ON' : 'OFF'}`);
    doc.notify();
  }

  /** Cursor stepping. It lives on the document rather than in drafting settings,
   *  so it cannot go through toggleDraftingMode with the other three. */
  function toggleGridSnap(): void {
    doc.snapEnabled = !doc.snapEnabled;
    log(`Snap: ${doc.snapEnabled ? `ON, step ${doc.snapSize} mm` : 'OFF'}`);
    doc.notify();
  }

  function toggleGridDisplay(): void {
    doc.gridVisible = !doc.gridVisible;
    log(`Grid: ${doc.gridVisible ? 'ON' : 'OFF'}`);
    doc.notify();
  }

  function toggleCutArea(): void {
    const options = doc.gcode;
    options.frameVisible = !options.frameVisible;
    if (options.frameVisible) {
      const { width, height } = ctx.size();
      const first = { x: options.frameOriginX, y: options.frameOriginY };
      const opposite = { x: first.x + options.frameWidth, y: first.y + options.frameHeight };
      if (doc.viewMode === '2d') renderer2d.zoomWindow(first, opposite, width, height);
      else renderer3d.framePoints([
        { ...first, z: 0 },
        { x: opposite.x, y: first.y, z: 0 },
        { ...opposite, z: 0 },
        { x: first.x, y: opposite.y, z: 0 },
      ]);
    }
    log(`Print/cut area: ${options.frameVisible ? `ON, ${options.frameWidth} × ${options.frameHeight} mm` : 'OFF'}`);
    doc.notify();
  }

  function openContextMenu(event: PointerEvent): void {
    const menuTitle = gripMenu.querySelector<HTMLElement>('.context-menu-title');
    const oneShotSection = gripMenu.querySelector<HTMLElement>('.one-shot-snaps');
    const showPersistentSnaps = (): void => {
      gripMenu.querySelectorAll<HTMLButtonElement>('[data-persistent-snap]').forEach((button) => {
        const mode = button.dataset.persistentSnap as ObjectSnapMode;
        button.classList.toggle('active', doc.drafting.objectSnapModes.includes(mode));
        button.setAttribute('aria-pressed', String(doc.drafting.objectSnapModes.includes(mode)));
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
    const point = doc.viewMode === '2d' ? rawWorldPoint(event) : rawWorldPoint3d(event);
    if (!point) return;
    const tolerance = doc.viewMode === '2d'
      ? 8 / renderer2d.zoom
      : Math.max(0.2, renderer3d.orbitRadius * 0.025);
    const entity = hitTestEntity(doc.entities, point, tolerance);
    const solidId = doc.viewMode === '3d'
      ? renderer3d.pickSolid(renderer3d.renderer.domElement, event.clientX, event.clientY)
      : null;
    const solid = solidId ? doc.getSolid(solidId) : hitTestSolid2d(doc, point);
    const validEntity = entity && doc.selectedEntityIds.has(entity.id) ? entity : null;
    const validSolid = solid && doc.selectedSolidIds.has(solid.id) ? solid : null;
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

  return {
    deleteSelectedObjects,
    toggleDraftingMode,
    toggleGridSnap,
    toggleGridDisplay,
    toggleCutArea,
    openContextMenu,
  };
}
