import type { Document } from '../core/Document';
import type { CommandHistory } from '../core/history/CommandHistory';
import { AddEntitiesEdit } from '../core/history/edits';
import { cloneWorkPlane, WORLD_WORK_PLANE } from '../math/workplane';
import { defaultDimensionStyle, defaultDraftingSettings } from '../core/settings';
import { importAsciiDxf } from '../io/DxfImport';
import { exportAsciiStl, loadProject, serializeProject, type ProjectViewState } from '../io/ProjectIO';

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
    if (confirmDiscard && (this.doc.entities.length > 0 || this.doc.solids.length > 0)
      && !window.confirm('Create a new project? Unsaved changes will be lost.')) return false;
    this.callbacks.cancelInteraction();
    this.doc.transaction(() => {
      this.doc.entities = [];
      this.doc.solids = [];
      this.doc.selectedEntityIds.clear();
      this.doc.selectedSolidIds.clear();
      this.doc.currentLayer = '0';
      this.doc.layers = ['0'];
      this.doc.layerColors = { '0': 0xffffff };
      this.doc.hiddenLayers.clear();
      this.doc.gridSize = 1;
      this.doc.snapSize = 0.5;
      this.doc.snapEnabled = true;
      this.doc.drafting = defaultDraftingSettings();
      this.doc.dimensionStyle = defaultDimensionStyle();
      this.doc.viewMode = '2d';
      this.doc.activeWorkPlane = cloneWorkPlane(WORLD_WORK_PLANE);
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
        this.doc.layerColors[layer] ??= result.layerColors[layer] ?? 0xffffff;
      });
      this.doc.viewMode = '2d';
      this.doc.transaction(() => {
        this.doc.clearSelection();
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

  async exportStl(): Promise<void> {
    if (this.doc.solids.length === 0) {
      this.callbacks.log('STL export: the document contains no 3D solids.');
      return;
    }
    await this.saveText(exportAsciiStl(this.doc), 'model.stl', 'STL model', 'stl');
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
