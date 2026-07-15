import { describe, expect, it, vi } from 'vitest';
import { Document } from '../Document';
import { CommandHistory } from '../history/CommandHistory';
import { CommandManager } from './CommandManager';

function setup() {
  const doc = new Document();
  const history = new CommandHistory(doc);
  const log = vi.fn();
  const moveObject = vi.fn();
  const manager = new CommandManager({
    doc,
    history,
    moveObject,
    log,
    prompt: vi.fn(),
    getCursor: () => ({ x: 0, y: 0 }),
    redraw: vi.fn(),
  });
  return { doc, history, log, manager, moveObject };
}

describe('CommandManager history integration', () => {
  it('suggests ambiguous command prefixes and keeps destructive erase explicit', () => {
    const { manager } = setup();
    expect(manager.commandSuggestions('m')).toEqual(['MEASURE', 'MOVE', 'MIRROR']);
    expect(manager.commandSuggestions('p')).toEqual(['POLYGON', 'PRESSPULL']);
    expect(manager.resolveAlias('e')).toBe('EXTRUDE');
    expect(manager.resolveAlias('s')).toBe('SUBTRACT');
    expect(manager.resolveAlias('u')).toBe('UNION');
    expect(manager.resolveAlias('j')).toBe('JOIN');
    expect(manager.resolveAlias('erase')).toBe('ERASE');
  });

  it('joins connected lines into one closed polyline', async () => {
    const { doc, manager } = setup();
    const lines = [
      doc.createLine({ x: 0, y: 0 }, { x: 10, y: 0 }),
      doc.createLine({ x: 5, y: 8 }, { x: 0, y: 0 }),
      doc.createLine({ x: 10, y: 0 }, { x: 5, y: 8 }),
    ];
    doc.entities.push(...lines);
    lines.forEach((line) => doc.selectEntity(line.id, true));
    manager.startCommand('JOIN');
    expect(doc.entities).toHaveLength(1);
    expect(doc.entities[0]).toMatchObject({ type: 'polyline', closed: true });
  });

  it('joins a Bezier curve to a connected line', async () => {
    const { doc, manager } = setup();
    const line = doc.createLine({ x: 0, y: 0 }, { x: 5, y: 0 });
    const bezier = doc.createBezier({ x: 5, y: 0 }, { x: 7, y: 0 }, { x: 8, y: 4 }, { x: 10, y: 4 });
    doc.entities.push(line, bezier);
    doc.selectEntity(line.id, true); doc.selectEntity(bezier.id, true);
    manager.startCommand('JOIN');
    expect(doc.entities).toHaveLength(1);
    expect(doc.entities[0]).toMatchObject({ type: 'polyline', closed: false });
    expect(doc.entities[0].type === 'polyline' && doc.entities[0].vertices.length).toBeGreaterThan(40);
  });

  it('joins an arc to a connected line', async () => {
    const { doc, manager } = setup();
    const line = doc.createLine({ x: 0, y: 0 }, { x: 5, y: 0 });
    const arc = doc.createArc({ x: 5, y: 5 }, 5, -Math.PI / 2, Math.PI / 2);
    doc.entities.push(line, arc);
    manager.startCommand('JOIN');
    await manager.handleClick({ x: 2, y: 0 }, line);
    await manager.handleClick({ x: 7, y: 1 }, arc);
    await manager.submitInput('');
    expect(doc.entities).toHaveLength(1);
    expect(doc.entities[0]).toMatchObject({ type: 'polyline', closed: false });
    expect(doc.entities[0].type === 'polyline' && doc.entities[0].vertices.length).toBeGreaterThan(40);
    expect(doc.entities[0].type === 'polyline' && doc.entities[0].vertices.at(-1)).toMatchObject({ x: 10, y: 5 });
  });

  it('extends a line to a selected boundary', async () => {
    const { doc, manager } = setup();
    const boundary = doc.createLine({ x: 10, y: -5 }, { x: 10, y: 5 });
    const target = doc.createLine({ x: 0, y: 0 }, { x: 6, y: 0 });
    doc.entities.push(boundary, target);
    manager.startCommand('EXTEND');
    await manager.handleClick({ x: 10, y: 0 }, boundary);
    await manager.handleClick({ x: 5, y: 0 }, target);
    expect(doc.getEntity(target.id)).toMatchObject({ type: 'line', end: { x: 10, y: 0 } });
  });

  it('trims the clicked side of a line at a cutting edge', async () => {
    const { doc, manager } = setup();
    const cutter = doc.createLine({ x: 5, y: -5 }, { x: 5, y: 5 });
    const target = doc.createLine({ x: 0, y: 0 }, { x: 10, y: 0 });
    doc.entities.push(cutter, target);
    manager.startCommand('TRIM');
    await manager.handleClick({ x: 5, y: 0 }, cutter);
    await manager.handleClick({ x: 8, y: 0 }, target);
    expect(doc.getEntity(target.id)).toMatchObject({ type: 'line', start: { x: 0, y: 0 }, end: { x: 5, y: 0 } });
  });

  it('creates an equal-length offset line on the clicked side', async () => {
    const { doc, manager } = setup();
    const source = doc.createLine({ x: 0, y: 0 }, { x: 10, y: 0 });
    doc.entities.push(source);
    manager.startCommand('OFFSET');
    await manager.handleClick({ x: 4, y: 0 }, source);
    await manager.submitInput('2');
    await manager.handleClick({ x: 4, y: 5 });
    expect(doc.entities).toHaveLength(2);
    expect(doc.entities[1]).toMatchObject({ type: 'line', start: { x: 0, y: 2 }, end: { x: 10, y: 2 } });
  });

  it('offsets a circle outward or inward according to the picked side', async () => {
    const { doc, manager } = setup();
    const circle = doc.createCircle({ x: 0, y: 0 }, 10);
    doc.entities.push(circle);
    manager.startCommand('OFFSET');
    await manager.handleClick({ x: 10, y: 0 }, circle);
    expect(doc.selectedEntityIds.has(circle.id)).toBe(true);
    await manager.submitInput('2');
    await manager.handleClick({ x: 15, y: 0 });
    expect(doc.entities[1]).toMatchObject({ type: 'circle', center: { x: 0, y: 0 }, radius: 12 });
  });

  it('offsets a closed rectangle outward', async () => {
    const { doc, manager } = setup();
    const rectangle = doc.createRectangle({ x: 0, y: 0 }, { x: 10, y: 5 });
    doc.entities.push(rectangle);
    manager.startCommand('OFFSET');
    await manager.handleClick({ x: 0, y: 0 }, rectangle);
    await manager.submitInput('1');
    await manager.handleClick({ x: 12, y: 3 });
    expect(doc.entities[1]).toMatchObject({ type: 'rectangle', first: { x: -1, y: -1 }, opposite: { x: 11, y: 6 } });
  });

  it('records a complete line as one undoable edit', async () => {
    const { doc, history, manager } = setup();
    manager.startCommand('LINE');
    await manager.handleClick({ x: 1, y: 2 });
    expect(doc.entities).toHaveLength(0);
    await manager.handleClick({ x: 4, y: 6 });
    expect(doc.entities).toHaveLength(1);
    expect(history.undo()).toBe(true);
    expect(doc.entities).toHaveLength(0);
    expect(history.redo()).toBe(true);
    expect(doc.entities[0]).toMatchObject({ type: 'line', start: { x: 1, y: 2 }, end: { x: 4, y: 6 } });
  });

  it('accepts relative Cartesian coordinates for the next point', async () => {
    const { doc, manager } = setup();
    manager.startCommand('LINE');
    await manager.submitInput('20,30');
    await manager.submitInput('@10,10');
    expect(doc.entities[0]).toMatchObject({
      type: 'line', start: { x: 20, y: 30 }, end: { x: 30, y: 40 },
    });
  });

  it('accepts AutoCAD-style relative polar coordinates for a line', async () => {
    const { doc, manager } = setup();
    manager.startCommand('LINE');
    await manager.submitInput('0,0');
    await manager.submitInput('@10<180');
    expect(doc.entities[0].type).toBe('line');
    if (doc.entities[0].type !== 'line') return;
    expect(doc.entities[0].end.x).toBeCloseTo(-10, 10);
    expect(doc.entities[0].end.y).toBeCloseTo(0, 10);
  });

  it('keeps line and rectangle tools active for repeated drawing', async () => {
    const { doc, manager } = setup();
    manager.startCommand('LINE');
    await manager.handleClick({ x: 0, y: 0 });
    await manager.handleClick({ x: 2, y: 0 });
    expect(manager.active).toMatchObject({ name: 'LINE', stepIndex: 0, data: {} });
    await manager.handleClick({ x: 3, y: 0 });
    await manager.handleClick({ x: 5, y: 1 });
    expect(doc.entities).toHaveLength(2);

    manager.startCommand('RECTANGLE');
    await manager.handleClick({ x: 0, y: 0 });
    await manager.handleClick({ x: 4, y: 3 });
    expect(manager.active).toMatchObject({ name: 'RECTANGLE', stepIndex: 0, data: {} });
    manager.cancelActive();
    expect(manager.active).toBeNull();
  });

  it('keeps the circle tool active for repeated drawing', async () => {
    const { doc, manager } = setup();
    manager.startCommand('CIRCLE');
    await manager.handleClick({ x: 0, y: 0 });
    await manager.handleClick({ x: 2, y: 0 });
    expect(doc.entities).toHaveLength(1);
    expect(manager.active).toMatchObject({ name: 'CIRCLE', stepIndex: 0, data: {} });
  });

  it('accepts a numeric circle radius from the command line', async () => {
    const { doc, manager } = setup();
    manager.startCommand('CIRCLE');
    await manager.submitInput('10,20');
    await manager.submitInput('7.5');
    expect(doc.entities[0]).toMatchObject({
      type: 'circle', center: { x: 10, y: 20 }, radius: 7.5,
    });
    expect(manager.active).toMatchObject({ name: 'CIRCLE', stepIndex: 0 });
  });

  it('selects text font and height before the insertion point', async () => {
    const { doc, manager } = setup();
    manager.startCommand('TEXT');
    await manager.submitInput('Times New Roman');
    await manager.submitInput('6.5');
    await manager.handleClick({ x: 12, y: 8 });
    await manager.submitInput('Title');
    expect(doc.entities[0]).toMatchObject({
      type: 'text', position: { x: 12, y: 8 }, text: 'Title', height: 6.5, font: 'Times New Roman',
    });
  });

  it('undoes erase with the original entity id', async () => {
    const { doc, history, manager } = setup();
    const circle = doc.createCircle({ x: 2, y: 3 }, 4);
    doc.addEntity(circle);
    manager.startCommand('ERASE');
    await manager.handleClick({ x: 2, y: 3 }, circle);
    expect(doc.entities).toHaveLength(0);
    history.undo();
    expect(doc.entities[0].id).toBe(circle.id);
  });

  it('does not create history for a cancelled command', async () => {
    const { history, manager } = setup();
    manager.startCommand('CIRCLE');
    await manager.handleClick({ x: 0, y: 0 });
    await manager.submitInput('CANCEL');
    expect(history.canUndo).toBe(false);
  });

  it('creates an undoable rectangle from opposite corners', async () => {
    const { doc, history, manager } = setup();
    manager.startCommand('RECTANGLE');
    await manager.handleClick({ x: -2, y: 1 });
    await manager.handleClick({ x: 4, y: 5 });
    expect(doc.entities[0]).toMatchObject({
      type: 'rectangle', first: { x: -2, y: 1 }, opposite: { x: 4, y: 5 },
    });
    history.undo();
    expect(doc.entities).toHaveLength(0);
    history.redo();
    expect(doc.entities[0].type).toBe('rectangle');
  });

  it('marks the first subtract solid as selected', async () => {
    const { doc, manager } = setup();
    const mesh = {
      positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 1]),
      indices: new Uint32Array([0, 1, 2]),
    };
    const base = doc.createSolid(mesh, 'base', 1, []);
    doc.addSolid(base);
    manager.startCommand('SUBTRACT');
    await manager.handleClick({ x: 0, y: 0 }, undefined, base.id);
    expect(doc.selectedSolidIds.has(base.id)).toBe(true);
    expect(doc.getSolid(base.id)?.selected).toBe(true);
  });

  it('advances extrude to height after a preselected profile is supplied', async () => {
    const { doc, manager } = setup();
    const profile = doc.createRectangle({ x: 0, y: 0 }, { x: 4, y: 3 });
    doc.addEntity(profile);
    doc.selectEntity(profile.id);
    manager.startCommand('EXTRUDE');
    expect(manager.active).toMatchObject({ name: 'EXTRUDE', stepIndex: 1 });
    expect(manager.currentPrompt()).toBe('Enter extrusion height:');
  });

  it('moves a selected object by the two picked view-plane points', async () => {
    const { doc, manager, moveObject } = setup();
    const line = doc.createLine({ x: 0, y: 0 }, { x: 1, y: 0 });
    doc.addEntity(line);
    manager.startCommand('MOVE');
    await manager.handleClick({ x: 0, y: 0 }, line);
    await manager.handleClick({ x: 2, y: 3 });
    await manager.handleClick({ x: 7, y: 9 });
    expect(moveObject).toHaveBeenCalledWith(line, { x: 5, y: 6 });
  });

  it('uses the exact 3D delta when MOVE points come from object snaps', async () => {
    const { doc, manager, moveObject } = setup();
    const rectangle = doc.createRectangle({ x: 0, y: 0 }, { x: 4, y: 2 });
    doc.addEntity(rectangle);
    manager.startCommand('MOVE');
    await manager.handleClick({ x: 1, y: 1 }, rectangle);
    manager.active!.data.pendingMoveWorldPoint = { x: 2, y: 3, z: 10 };
    await manager.handleClick({ x: 0, y: 0 });
    manager.active!.data.pendingMoveWorldPoint = { x: 12, y: 8, z: 14 };
    await manager.handleClick({ x: 5, y: 2 });
    expect(moveObject).toHaveBeenCalledWith(rectangle, { x: 5, y: 2 }, { x: 10, y: 5, z: 4 });
  });

  it('rotates a preselected line around a base point by entered degrees', async () => {
    const { doc, manager } = setup();
    const line = doc.createLine({ x: 2, y: 1 }, { x: 6, y: 1 });
    doc.addEntity(line);
    doc.selectEntity(line.id);
    manager.startCommand('ROTATE');
    expect(manager.active).toMatchObject({ name: 'ROTATE', stepIndex: 1 });
    await manager.handleClick({ x: 2, y: 1 });
    await manager.submitInput('90');
    expect(doc.entities[0].type).toBe('line');
    if (doc.entities[0].type !== 'line') return;
    expect(doc.entities[0].start.x).toBeCloseTo(2);
    expect(doc.entities[0].start.y).toBeCloseTo(1);
    expect(doc.entities[0].end.x).toBeCloseTo(2);
    expect(doc.entities[0].end.y).toBeCloseTo(5);
  });

  it('converts a freely rotated rectangle into a closed polyline', async () => {
    const { doc, manager } = setup();
    const rectangle = doc.createRectangle({ x: 0, y: 0 }, { x: 4, y: 2 });
    doc.addEntity(rectangle);
    doc.selectEntity(rectangle.id);
    manager.startCommand('ROTATE');
    await manager.handleClick({ x: 0, y: 0 });
    await manager.submitInput('45');
    expect(doc.entities[0]).toMatchObject({ type: 'polyline', closed: true });
  });

  it('measures spatial distance and remains active', async () => {
    const { log, manager } = setup();
    manager.startCommand('MEASURE');
    await manager.handleClick({ x: 0, y: 0, z: 0 });
    await manager.handleClick({ x: 3, y: 4, z: 12 });
    expect(log).toHaveBeenCalledWith(expect.stringContaining('Distance: 13.000 mm'));
    expect(manager.active).toMatchObject({ name: 'MEASURE', stepIndex: 0 });
  });

  it('creates a polygon from center, side count and apothem', async () => {
    const { doc, manager } = setup();
    manager.startCommand('POLYGON');
    await manager.handleClick({ x: 0, y: 0 });
    await manager.submitInput('6');
    await manager.submitInput('10');
    expect(doc.entities[0]).toMatchObject({ type: 'polyline', closed: true });
    const polygon = doc.entities[0];
    expect(polygon.type === 'polyline' && polygon.vertices).toHaveLength(7);
    expect(manager.active).toMatchObject({ name: 'POLYGON', stepIndex: 0 });
  });
});
