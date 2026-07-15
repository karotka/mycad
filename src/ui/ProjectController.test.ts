import { describe, expect, it, vi } from 'vitest';
import { Document } from '../core/Document';
import { CommandHistory } from '../core/history/CommandHistory';
import { ProjectController, type ProjectControllerCallbacks } from './ProjectController';

describe('ProjectController', () => {
  it('creates a clean millimetre project and resets transient application state', () => {
    const doc = new Document();
    doc.layers = ['0', 'Parts'];
    doc.currentLayer = 'Parts';
    doc.gridSize = 5;
    doc.snapSize = 2;
    doc.viewMode = '3d';
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
    expect(doc.snapSize).toBe(0.5);
    expect(doc.viewMode).toBe('2d');
    expect(callbacks.cancelInteraction).toHaveBeenCalledOnce();
    expect(callbacks.resetView).toHaveBeenCalledOnce();
    expect(callbacks.redraw).toHaveBeenCalledOnce();
  });
});
