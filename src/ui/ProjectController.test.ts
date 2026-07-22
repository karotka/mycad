import { describe, expect, it, vi } from 'vitest';
import { Document } from '../core/Document';
import { CommandHistory } from '../core/history/CommandHistory';
import { ProjectController, type ProjectControllerCallbacks } from './ProjectController';
import { serializeProject } from '../io/ProjectIO';

describe('ProjectController', () => {
  it('creates a clean millimetre project and resets transient application state', () => {
    const doc = new Document();
    doc.layers = ['0', 'Parts'];
    doc.currentLayer = 'Parts';
    doc.gridSize = 5;
    doc.gridVisible = false;
    doc.snapSize = 2;
    doc.viewMode = '3d';
    doc.addNamedWorkPlane({
      origin: { x: 10, y: 0, z: 0 },
      xAxis: { x: 1, y: 0, z: 0 },
      yAxis: { x: 0, y: 1, z: 0 },
      zAxis: { x: 0, y: 0, z: 1 },
    }, 'Fixture');
    const callbacks = {
      captureView: vi.fn(), cancelInteraction: vi.fn(), resetView: vi.fn(), applyView: vi.fn(),
      zoomExtents: vi.fn(), renderLayers: vi.fn(), log: vi.fn(), clearLog: vi.fn(),
      redraw: vi.fn(), focusInput: vi.fn(),
    } as unknown as ProjectControllerCallbacks;
    const controller = new ProjectController(doc, new CommandHistory(doc), callbacks);

    expect(controller.newProject(false)).toBe(true);

    expect(doc.layers).toEqual(['0']);
    expect(doc.currentLayer).toBe('0');
    expect(doc.gridSize).toBe(1);
    expect(doc.gridVisible).toBe(true);
    expect(doc.snapSize).toBe(0.5);
    expect(doc.viewMode).toBe('2d');
    expect(doc.namedWorkPlanes).toEqual([]);
    expect(doc.activeNamedWorkPlaneId).toBeNull();
    expect(callbacks.cancelInteraction).toHaveBeenCalledOnce();
    expect(callbacks.resetView).toHaveBeenCalledOnce();
    expect(callbacks.redraw).toHaveBeenCalledOnce();
  });

  it('remembers an opened path and quick-saves back to it without a dialog', async () => {
    const doc = new Document();
    const opened = new Document();
    opened.addEntity(opened.createLine({ x: 0, y: 0 }, { x: 2, y: 3 }));
    const quickSave = vi.fn(async ({ filePath }: { filePath?: string }) => ({ filePath: filePath! }));
    const saveFile = vi.fn();
    vi.stubGlobal('window', { mycadAPI: {
      openFile: vi.fn(async () => ({ canceled: false, filePath: '/tmp/opened.mycad', content: serializeProject(opened) })),
      quickSave,
      saveFile,
    } });
    const callbacks = {
      captureView: vi.fn(() => undefined), cancelInteraction: vi.fn(), resetView: vi.fn(), applyView: vi.fn(),
      zoomExtents: vi.fn(), renderLayers: vi.fn(), log: vi.fn(), clearLog: vi.fn(), redraw: vi.fn(), focusInput: vi.fn(),
    } as unknown as ProjectControllerCallbacks;
    const controller = new ProjectController(doc, new CommandHistory(doc), callbacks);

    await controller.open();
    await controller.quickSave();

    expect(quickSave).toHaveBeenCalledWith(expect.objectContaining({ filePath: '/tmp/opened.mycad', defaultPath: 'opened.mycad' }));
    expect(saveFile).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('writes an STL containing only the solids provided by the selection command', async () => {
    const doc = new Document();
    const omitted = doc.createSolid(
      { positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), indices: new Uint32Array([0, 1, 2]) },
      'omitted', 0, [],
    );
    const selected = doc.createSolid(
      { positions: new Float32Array([10, 0, 0, 11, 0, 0, 10, 1, 0]), indices: new Uint32Array([0, 1, 2]) },
      'selected', 0, [],
    );
    doc.solids.push(omitted, selected);
    const saveFile = vi.fn(async (_request: { content: string }) => ({ canceled: false, filePath: '/tmp/selected.stl' }));
    vi.stubGlobal('window', { mycadAPI: { saveFile } });
    const callbacks = {
      captureView: vi.fn(), cancelInteraction: vi.fn(), resetView: vi.fn(), applyView: vi.fn(),
      zoomExtents: vi.fn(), renderLayers: vi.fn(), log: vi.fn(), clearLog: vi.fn(),
      redraw: vi.fn(), focusInput: vi.fn(),
    } as unknown as ProjectControllerCallbacks;
    const controller = new ProjectController(doc, new CommandHistory(doc), callbacks);

    await controller.exportStl([selected]);

    const request = saveFile.mock.calls[0]![0];
    expect(request.content.match(/facet normal/g)).toHaveLength(1);
    expect(request.content).toContain('vertex 10 0 0');
    expect(request.content).not.toContain('vertex 0 0 0');
    expect(callbacks.log).toHaveBeenCalledWith('STL: 1 selected solid(s).');
    vi.unstubAllGlobals();
  });
});
