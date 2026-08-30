import { describe, expect, it, vi } from 'vitest';
import { Document } from '../core/Document';
import { CommandHistory } from '../core/history/CommandHistory';
import { ProjectController, type ProjectControllerCallbacks } from './ProjectController';
import { serializeProject } from '../io/ProjectIO';
import { buildExactBox } from '../core/geometry/ExactSolid';
import { openCascadeKernel } from '../core/geometry/OpenCascadeRuntime';

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

  it('seeds a new project from a setting changed earlier, not the hardcoded factory default', () => {
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => store.set(key, value),
    });
    store.set('mycad.defaults.gcode', JSON.stringify({ penDelayMs: 250 }));
    store.set('mycad.defaults.drafting', JSON.stringify({ snapSize: 2, gridSize: 20, polarAngles: [15, 75] }));
    const doc = new Document();
    const callbacks = {
      captureView: vi.fn(), cancelInteraction: vi.fn(), resetView: vi.fn(), applyView: vi.fn(),
      zoomExtents: vi.fn(), renderLayers: vi.fn(), log: vi.fn(), clearLog: vi.fn(),
      redraw: vi.fn(), focusInput: vi.fn(),
    } as unknown as ProjectControllerCallbacks;
    const controller = new ProjectController(doc, new CommandHistory(doc), callbacks);

    controller.newProject(false);

    expect(doc.gcode.penDelayMs).toBe(250);
    expect(doc.snapSize).toBe(2);
    expect(doc.gridSize).toBe(20);
    expect(doc.drafting.polarAngles).toEqual([15, 75]);
    vi.unstubAllGlobals();
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

  it('writes a STEP file containing the real exact geometry of the solids provided', async () => {
    const doc = new Document();
    const feature = { kind: 'primitive' as const, primitive: 'box' as const, center: { x: 0, y: 0 }, width: 2, depth: 4, height: 6 };
    const geometry = await buildExactBox(feature);
    const selected = doc.createSolid(geometry.mesh, 'selected', 6, [], undefined, feature);
    selected.exact = geometry.exact;
    doc.solids.push(selected);
    const saveFile = vi.fn(async (_request: { content: string }) => ({ canceled: false, filePath: '/tmp/selected.step' }));
    vi.stubGlobal('window', { mycadAPI: { saveFile } });
    const callbacks = {
      captureView: vi.fn(), cancelInteraction: vi.fn(), resetView: vi.fn(), applyView: vi.fn(),
      zoomExtents: vi.fn(), renderLayers: vi.fn(), log: vi.fn(), clearLog: vi.fn(),
      redraw: vi.fn(), focusInput: vi.fn(),
    } as unknown as ProjectControllerCallbacks;
    const controller = new ProjectController(doc, new CommandHistory(doc), callbacks);

    await controller.exportStep([selected]);

    const request = saveFile.mock.calls[0]![0];
    expect(request.content).toContain('ISO-10303-21');
    expect(callbacks.log).toHaveBeenCalledWith('STEP: 1 selected solid(s).');
    vi.unstubAllGlobals();
  });

  it('imports every solid in a STEP file as one undoable operation', async () => {
    const doc = new Document();
    const history = new CommandHistory(doc);
    const kernel = await openCascadeKernel();
    const box = kernel.makeBox({ x: 2, y: 2, z: 2 });
    const step = kernel.writeStep([box]);
    box.dispose();
    vi.stubGlobal('window', { mycadAPI: {
      openFile: vi.fn(async () => ({ canceled: false, filePath: '/tmp/part.step', content: step })),
    } });
    const callbacks = {
      captureView: vi.fn(), cancelInteraction: vi.fn(), resetView: vi.fn(), applyView: vi.fn(),
      zoomExtents: vi.fn(), renderLayers: vi.fn(), log: vi.fn(), clearLog: vi.fn(),
      redraw: vi.fn(), focusInput: vi.fn(),
    } as unknown as ProjectControllerCallbacks;
    const controller = new ProjectController(doc, history, callbacks);

    await controller.importStep();
    expect(doc.solids).toHaveLength(1);
    expect(doc.solids[0]).toMatchObject({ name: 'STEP import' });

    history.undo();
    expect(doc.solids).toEqual([]);
    history.redo();
    expect(doc.solids).toHaveLength(1);
    vi.unstubAllGlobals();
  });

  it('imports a PDF\'s vector paths as one undoable operation', async () => {
    const doc = new Document();
    const history = new CommandHistory(doc);
    const content = '100 100 m\n200 200 l\nS\n';
    const pdf = `%PDF-1.4
1 0 obj
<< /Type /Catalog /Pages 2 0 R >>
endobj
2 0 obj
<< /Type /Pages /Kids [3 0 R] /Count 1 >>
endobj
3 0 obj
<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Contents 4 0 R /Resources << >> >>
endobj
4 0 obj
<< /Length ${content.length} >>
stream
${content}endstream
endobj
trailer
<< /Size 5 /Root 1 0 R >>
%%EOF
`;
    const bytes = new TextEncoder().encode(pdf);
    vi.stubGlobal('window', { mycadAPI: {
      openBinaryFile: vi.fn(async () => ({ canceled: false, filePath: '/tmp/part.pdf', data: bytes })),
    } });
    const callbacks = {
      captureView: vi.fn(), cancelInteraction: vi.fn(), resetView: vi.fn(), applyView: vi.fn(),
      zoomExtents: vi.fn(), renderLayers: vi.fn(), log: vi.fn(), clearLog: vi.fn(),
      redraw: vi.fn(), focusInput: vi.fn(),
    } as unknown as ProjectControllerCallbacks;
    const controller = new ProjectController(doc, history, callbacks);

    await controller.importPdf();
    expect(doc.entities).toHaveLength(1);
    expect(doc.entities[0].type).toBe('line');

    history.undo();
    expect(doc.entities).toEqual([]);
    history.redo();
    expect(doc.entities).toHaveLength(1);
    vi.unstubAllGlobals();
  });

  it('imports DXF block definitions and references as one undoable operation', async () => {
    const doc = new Document();
    const history = new CommandHistory(doc);
    const dxf = '0\nSECTION\n2\nBLOCKS\n'
      + '0\nBLOCK\n2\nPart\n10\n0\n20\n0\n'
      + '0\nLINE\n8\n0\n10\n0\n20\n0\n11\n5\n21\n0\n0\nENDBLK\n0\nENDSEC\n'
      + '0\nSECTION\n2\nENTITIES\n0\nINSERT\n2\nPart\n10\n20\n20\n30\n0\nENDSEC\n0\nEOF\n';
    vi.stubGlobal('window', { mycadAPI: {
      openFile: vi.fn(async () => ({ canceled: false, filePath: '/tmp/part.dxf', content: dxf })),
    } });
    const callbacks = {
      captureView: vi.fn(), cancelInteraction: vi.fn(), resetView: vi.fn(), applyView: vi.fn(),
      zoomExtents: vi.fn(), renderLayers: vi.fn(), log: vi.fn(), clearLog: vi.fn(),
      redraw: vi.fn(), focusInput: vi.fn(),
    } as unknown as ProjectControllerCallbacks;
    const controller = new ProjectController(doc, history, callbacks);

    await controller.importDxf();
    expect(doc.blockDefinitions).toHaveLength(1);
    expect(doc.entities[0]).toMatchObject({ type: 'insert', blockName: 'Part' });

    history.undo();
    expect(doc.blockDefinitions).toEqual([]);
    expect(doc.entities).toEqual([]);
    history.redo();
    expect(doc.blockDefinitions[0].name).toBe('Part');
    expect(doc.entities[0].type).toBe('insert');
    vi.unstubAllGlobals();
  });
});
