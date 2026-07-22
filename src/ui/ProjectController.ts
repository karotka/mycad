import type { Document } from '../core/Document';
import type { CommandHistory } from '../core/history/CommandHistory';
import { AddEntitiesEdit } from '../core/history/edits';
import { cloneWorkPlane, WORLD_WORK_PLANE } from '../math/workplane';
import { defaultDimensionStyle, defaultDraftingSettings, defaultGcodeOptions } from '../core/settings';
import { importAsciiDxf } from '../io/DxfImport';
import { exportAsciiDxf } from '../io/DxfExport';
import { ACI_WHITE, aciToRgb } from '../io/DxfAci';
import { DEFAULT_LINE_TYPE, DEFAULT_LINE_WEIGHT_MM } from '../core/lineStyles';
import { exportAsciiStl, loadProject, serializeProject, type ProjectViewState } from '../io/ProjectIO';
import { exportGcode } from '../io/GcodeExport';
import type { Solid } from '../core/entities/types';

export interface ProjectControllerCallbacks {
  captureView(): ProjectViewState;
  cancelInteraction(): void;
  resetView(): void;
  applyView(view: ProjectViewState | undefined): void;
  zoomExtents(): void;
  renderLayers(): void;
  log(message: string): void;
  clearLog(): void;
  redraw(): void;
  focusInput(): void;
}

export class ProjectController {
  private currentPath: string | undefined;
  private currentName = 'model.mycad';

  constructor(
    private readonly doc: Document,
    private readonly history: CommandHistory,
    private readonly callbacks: ProjectControllerCallbacks,
  ) {}

  async saveAs(): Promise<void> {
    try {
      const content = serializeProject(this.doc, this.callbacks.captureView());
      const path = await this.saveText(content, this.currentPath ?? this.currentName, 'MyCAD project', 'mycad');
      if (path) this.setCurrentFile(path);
    } catch (error) { this.report('Save failed', error); }
  }

  async quickSave(): Promise<void> {
    try {
      const content = serializeProject(this.doc, this.callbacks.captureView());
      if (window.mycadAPI?.quickSave) {
        const result = await window.mycadAPI.quickSave({ filePath: this.currentPath, defaultPath: this.currentName, content });
        this.setCurrentFile(result.filePath);
        this.callbacks.log(`Saved: ${result.filePath}`);
      } else if (this.currentPath && window.mycadAPI) {
        await window.mycadAPI.writeFile({ filePath: this.currentPath, content });
        this.callbacks.log(`Saved: ${this.currentPath}`);
      } else {
        const path = await this.saveText(content, this.currentName, 'MyCAD project', 'mycad');
        if (path) this.setCurrentFile(path);
      }
    } catch (error) { this.report('Save failed', error); }
  }

  newProject(confirmDiscard = true): boolean {
    if (confirmDiscard && (this.doc.entities.length > 0 || this.doc.solids.length > 0 || this.doc.namedWorkPlanes.length > 0)
      && !window.confirm('Create a new project? Unsaved changes will be lost.')) return false;
    this.callbacks.cancelInteraction();
    this.doc.transaction(() => {
      this.doc.entities = [];
      this.doc.solids = [];
      this.doc.selectedEntityIds.clear();
      this.doc.selectedSolidIds.clear();
      this.doc.currentLayer = '0';
      this.doc.layers = ['0'];
      this.doc.layerAci = { '0': ACI_WHITE };
      this.doc.layerColors = { '0': aciToRgb(ACI_WHITE)! };
      this.doc.layerLineweight = { '0': DEFAULT_LINE_WEIGHT_MM };
      this.doc.layerLinetype = { '0': DEFAULT_LINE_TYPE };
      this.doc.hiddenLayers.clear();
      this.doc.gridSize = 1;
      this.doc.gridVisible = true;
      this.doc.snapSize = 0.5;
      this.doc.snapEnabled = true;
      this.doc.drafting = defaultDraftingSettings();
      this.doc.dimensionStyle = defaultDimensionStyle();
      this.doc.gcode = defaultGcodeOptions();
      this.doc.viewMode = '2d';
      this.doc.activeWorkPlane = cloneWorkPlane(WORLD_WORK_PLANE);
      this.doc.namedWorkPlanes = [];
      this.doc.activeNamedWorkPlaneId = null;
      this.doc.notify();
    });
    this.history.clear();
    this.currentPath = undefined;
    this.currentName = 'model.mycad';
    this.callbacks.resetView();
    this.callbacks.clearLog();
    this.callbacks.log('New project created.');
    this.callbacks.redraw();
    this.callbacks.focusInput();
    return true;
  }

  async open(): Promise<void> {
    try {
      const file = await this.pickFile('.mycad,application/json', 'MyCAD project', 'mycad');
      if (!file) return;
      if (!file.content) throw new Error('The file is empty.');
      this.callbacks.cancelInteraction();
      const savedView = loadProject(this.doc, file.content);
      this.setCurrentFile(file.path ?? file.name);
      this.callbacks.applyView(savedView);
      this.history.clear();
      if (!savedView) this.callbacks.zoomExtents();
      this.callbacks.log(`Opened: ${file.name}`);
      this.callbacks.redraw();
    } catch (error) { this.report('Open failed', error); }
  }

  async importDxf(): Promise<void> {
    try {
      const file = await this.pickFile('.dxf,application/dxf', 'AutoCAD DXF', 'dxf');
      if (!file) return;
      if (!file.content) throw new Error('The file is empty.');
      this.callbacks.cancelInteraction();
      const result = importAsciiDxf(this.doc, file.content);
      if (result.entities.length === 0) throw new Error('No supported 2D entities were found.');
      result.layers.forEach((layer) => {
        if (!this.doc.layers.includes(layer)) this.doc.layers.push(layer);
        this.doc.layerAci[layer] ??= result.layerAci[layer] ?? ACI_WHITE;
        if (result.layerLineweight[layer] !== undefined) this.doc.layerLineweight[layer] ??= result.layerLineweight[layer];
        if (result.layerLinetype[layer] !== undefined) this.doc.layerLinetype[layer] ??= result.layerLinetype[layer];
      });
      this.doc.viewMode = '2d';
      this.doc.transaction(() => {
        this.doc.clearSelection();
        this.doc.recolour();
        this.history.execute(new AddEntitiesEdit('Import DXF', result.entities));
      });
      this.callbacks.zoomExtents();
      this.callbacks.renderLayers();
      this.callbacks.log(`Imported DXF: ${file.name} · ${result.entities.length} object(s).`);
      // Name what was dropped and what was only approximated: a silently
      // straightened arc looks like a valid drawing but is not the same one.
      const skipped = Object.entries(result.ignoredTypes)
        .sort((a, b) => b[1] - a[1])
        .map(([type, count]) => `${type}×${count}`)
        .join(', ');
      if (skipped) this.callbacks.log(`Not supported, skipped: ${skipped}.`);
      if (result.approximated > 0) {
        this.callbacks.log(`${result.approximated} object(s) approximated: arcs in polylines expanded to segments, any Z flattened.`);
      }
      this.callbacks.redraw();
    } catch (error) { this.report('DXF import failed', error); }
  }

  async exportStl(solids: readonly Solid[]): Promise<void> {
    if (solids.length === 0) {
      this.callbacks.log('STL export: no 3D solids were selected.');
      return;
    }
    this.callbacks.log(`STL: ${solids.length} selected solid(s).`);
    await this.saveText(exportAsciiStl(solids), 'model.stl', 'STL model', 'stl');
  }

  async exportDxf(): Promise<void> {
    if (this.doc.entities.length === 0) {
      this.callbacks.log('DXF export: the document contains no 2D geometry.');
      return;
    }
    const result = exportAsciiDxf(this.doc);
    const note = result.dimensionsDecomposed > 0
      ? ` (${result.dimensionsDecomposed} dimension(s) exploded to lines and text)`
      : '';
    this.callbacks.log(`DXF: ${result.entityCount} object(s)${note}.`);
    await this.saveText(result.dxf, 'model.dxf', 'AutoCAD DXF', 'dxf');
  }

  async exportGcode(): Promise<void> {
    const result = exportGcode(this.doc);
    if (result.layers.length === 0) {
      this.callbacks.log('G-code export: no visible 2D geometry to cut.');
      return;
    }
    // What came out, in the order it came out, because that order is the thing
    // the layer panel is for and the thing a wrong file gets wrong.
    this.callbacks.log(`G-code: ${result.moveCount} moves over ${result.layers.length} layer(s): ${result.layers.join(' → ')}.`);
    const skipped = Object.entries(result.skipped).map(([type, count]) => `${type}×${count}`).join(', ');
    if (skipped) this.callbacks.log(`No tool path for: ${skipped}. Text needs a single-stroke font.`);
    if (result.offPlane > 0) {
      this.callbacks.log(`${result.offPlane} object(s) skipped: they do not lie on the world XY plane, and Z belongs to the tool.`);
    }
    await this.saveText(result.gcode, 'model.gcode', 'G-code', 'gcode');
  }

  private async pickFile(accept: string, name: string, extension: string): Promise<{ content: string; name: string; path?: string } | undefined> {
    if (window.mycadAPI) {
      const result = await window.mycadAPI.openFile({ filters: [{ name, extensions: [extension] }] });
      if (result.canceled) return undefined;
      return { content: result.content ?? '', name: result.filePath ?? `file.${extension}`, path: result.filePath };
    }
    const picker = document.createElement('input');
    picker.type = 'file';
    picker.accept = accept;
    const file = await new Promise<File | undefined>((resolve) => {
      picker.addEventListener('change', () => resolve(picker.files?.[0]), { once: true });
      picker.click();
    });
    return file ? { content: await file.text(), name: file.name } : undefined;
  }

  private async saveText(content: string, defaultPath: string, name: string, extension: string): Promise<string | undefined> {
    if (window.mycadAPI) {
      const result = await window.mycadAPI.saveFile({ content, defaultPath, filters: [{ name, extensions: [extension] }] });
      if (!result.canceled) this.callbacks.log(`Saved: ${result.filePath ?? defaultPath}`);
      return result.canceled ? undefined : result.filePath;
    }
    const blob = new Blob([content], { type: extension === 'stl' ? 'model/stl' : 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url; link.download = defaultPath; link.click();
    URL.revokeObjectURL(url);
    this.callbacks.log(`Downloaded: ${defaultPath}`);
    return undefined;
  }

  private setCurrentFile(filePathOrName: string): void {
    this.currentPath = filePathOrName.includes('/') || filePathOrName.includes('\\') ? filePathOrName : undefined;
    this.currentName = this.basename(filePathOrName);
  }

  private basename(filePathOrName: string): string {
    const normalized = filePathOrName.replaceAll('\\', '/');
    const name = normalized.split('/').filter(Boolean).pop();
    return name && name.trim() ? name : 'model.mycad';
  }

  private report(prefix: string, error: unknown): void {
    this.callbacks.log(`${prefix}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
