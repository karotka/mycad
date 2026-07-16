import { describe, expect, it, vi } from 'vitest';
import { Document } from '../Document';
import { CommandHistory } from '../history/CommandHistory';
import { CommandManager, hitTestEntity } from './CommandManager';
import { COMMAND_LIST, commandDef } from './registry';
import { dimensionGeometry } from '../entities/types';

function setup() {
  const doc = new Document();
  const history = new CommandHistory(doc);
  const log = vi.fn();
  const moveObjects = vi.fn();
  const manager = new CommandManager({
    doc,
    history,
    moveObjects,
    copyWorldDelta: () => undefined,
    log,
    prompt: vi.fn(),
    getCursor: () => ({ x: 0, y: 0 }),
    redraw: vi.fn(),
  });
  return { doc, history, log, manager, moveObjects };
}

describe('CommandManager history integration', () => {
  it('suggests ambiguous command prefixes and keeps destructive erase explicit', () => {
    const { manager } = setup();
    expect(manager.commandSuggestions('m')).toEqual(['MEASURE', 'MOVE', 'MIRROR']);
    expect(manager.commandSuggestions('p')).toEqual(['POLYLINE', 'POLYGON', 'PYRAMID', 'PRESSPULL']);
    expect(manager.resolveAlias('pl')).toBe('POLYLINE');
    expect(manager.resolveAlias('p')).toBe('POLYGON');
    expect(manager.resolveAlias('mo')).toBe('MOVE');
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

  it('joins a preselected line and polyline without asking again', async () => {
    const { doc, manager } = setup();
    const line = doc.createLine({ x: 0, y: 0 }, { x: 5, y: 0 });
    const polyline = doc.createPolyline([{ x: 5, y: 0 }, { x: 5, y: 4 }, { x: 0, y: 4 }], false);
    doc.entities.push(line, polyline);
    doc.selectEntity(line.id, true);
    doc.selectEntity(polyline.id, true);

    manager.startCommand('JOIN');

    expect(doc.entities).toHaveLength(1);
    expect(doc.entities[0]).toMatchObject({ type: 'polyline', closed: false });
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
    const boundary = doc.createPolyline([{ x: 10, y: -5 }, { x: 10, y: 5 }], false);
    const target = doc.createPolyline([{ x: 0, y: 0 }, { x: 6, y: 0 }], false);
    doc.entities.push(boundary, target);
    manager.startCommand('EXTEND');
    await manager.handleClick({ x: 10, y: 0 }, boundary);
    await manager.handleClick({ x: 5, y: 0 }, target);
    const extended = doc.getEntity(target.id);
    expect(extended).toMatchObject({ type: 'polyline' });
    if (extended?.type === 'polyline') expect(extended.vertices[1]).toMatchObject({ x: 10, y: 0 });
  });

  it('trims the clicked side of a line at a cutting edge', async () => {
    const { doc, manager } = setup();
    const cutter = doc.createPolyline([{ x: 5, y: -5 }, { x: 5, y: 5 }], false);
    const target = doc.createPolyline([{ x: 0, y: 0 }, { x: 10, y: 0 }], false);
    doc.entities.push(cutter, target);
    manager.startCommand('TRIM');
    await manager.handleClick({ x: 5, y: 0 }, cutter);
    await manager.handleClick({ x: 8, y: 0 }, target);
    const trimmed = doc.getEntity(target.id);
    expect(trimmed).toMatchObject({ type: 'polyline' });
    if (trimmed?.type === 'polyline') expect(trimmed.vertices[1]).toMatchObject({ x: 5, y: 0 });
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
    // ERASE gathers a selection and acts on Enter, like the other object commands.
    await manager.submitInput('');
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
    const { doc, manager, moveObjects } = setup();
    const line = doc.createLine({ x: 0, y: 0 }, { x: 1, y: 0 });
    doc.addEntity(line);
    manager.startCommand('MOVE');
    await manager.handleClick({ x: 0, y: 0 }, line);
    await manager.submitInput(''); // MOVE gathers a selection, like the other object commands
    await manager.handleClick({ x: 2, y: 3 });
    await manager.handleClick({ x: 7, y: 9 });
    expect(moveObjects).toHaveBeenCalledWith([line], { x: 5, y: 6 }, undefined);
  });

  it('uses the exact 3D delta when MOVE points come from object snaps', async () => {
    const { doc, manager, moveObjects } = setup();
    const rectangle = doc.createRectangle({ x: 0, y: 0 }, { x: 4, y: 2 });
    doc.addEntity(rectangle);
    manager.startCommand('MOVE');
    await manager.handleClick({ x: 1, y: 1 }, rectangle);
    await manager.submitInput('');
    manager.active!.data.pendingMoveWorldPoint = { x: 2, y: 3, z: 10 };
    await manager.handleClick({ x: 0, y: 0 });
    manager.active!.data.pendingMoveWorldPoint = { x: 12, y: 8, z: 14 };
    await manager.handleClick({ x: 5, y: 2 });
    expect(moveObjects).toHaveBeenCalledWith([rectangle], { x: 5, y: 2 }, { x: 10, y: 5, z: 4 });
  });

  it('copies preselected entities repeatedly from one base point', async () => {
    const { doc, manager, history } = setup();
    const line = doc.createLine({ x: 0, y: 0 }, { x: 2, y: 0 });
    doc.addEntity(line);
    doc.selectEntity(line.id);
    manager.startCommand('COPY');
    expect(manager.active).toMatchObject({ name: 'COPY', stepIndex: 1 });

    await manager.handleClick({ x: 0, y: 0 });
    await manager.handleClick({ x: 5, y: 3 });
    await manager.handleClick({ x: -2, y: 4 });

    expect(doc.entities).toHaveLength(3);
    const copies = doc.entities.filter((entity) => entity.id !== line.id);
    expect(copies.map((entity) => entity.type === 'line' ? entity.start : null)).toEqual(expect.arrayContaining([
      { x: 5, y: 3 }, { x: -2, y: 4 },
    ]));
    expect(manager.active).toMatchObject({ name: 'COPY', stepIndex: 2 });
    history.undo();
    expect(doc.entities).toHaveLength(2);
  });

  it('creates a rectangular array of preselected entities', async () => {
    const { doc, manager, history } = setup();
    const line = doc.createLine({ x: 0, y: 0 }, { x: 1, y: 0 });
    doc.addEntity(line);
    doc.selectEntity(line.id);
    manager.startCommand('ARRAY_RECTANGULAR');

    await manager.submitInput('2');
    await manager.submitInput('3');
    await manager.submitInput('5');
    await manager.submitInput('10');

    expect(doc.entities).toHaveLength(6);
    const starts = doc.entities
      .filter((entity): entity is typeof line => entity.type === 'line')
      .map((entity) => entity.start)
      .sort((a, b) => a.y - b.y || a.x - b.x);
    expect(starts).toEqual([
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 20, y: 0 },
      { x: 0, y: 5 },
      { x: 10, y: 5 },
      { x: 20, y: 5 },
    ]);
    expect(manager.active).toBeNull();
    history.undo();
    expect(doc.entities).toHaveLength(1);
  });

  it('creates a rectangular array of solids in world space', async () => {
    const { doc, manager, history } = setup();
    const mesh = {
      positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
      indices: new Uint32Array([0, 1, 2]),
    };
    const solid = doc.createSolid(mesh, 'solid', 1, []);
    doc.addSolid(solid);
    doc.selectSolid(solid.id);
    manager.startCommand('ARRAY_RECTANGULAR');

    await manager.submitInput('1');
    await manager.submitInput('2');
    await manager.submitInput('1.5');
    await manager.submitInput('4');

    expect(doc.solids).toHaveLength(2);
    expect(doc.solids[1].mesh.positions[0]).toBeCloseTo(4);
    expect(doc.solids[1].mesh.positions[1]).toBeCloseTo(0);
    history.undo();
    expect(doc.solids).toHaveLength(1);
  });

  it('creates a polar array of preselected entities', async () => {
    const { doc, manager, history } = setup();
    const line = doc.createLine({ x: 2, y: 0 }, { x: 4, y: 0 });
    doc.addEntity(line);
    doc.selectEntity(line.id);
    manager.startCommand('ARRAY_POLAR');

    await manager.submitInput('0,0');
    await manager.submitInput('2');
    await manager.submitInput('90');

    expect(doc.entities).toHaveLength(2);
    const endpoints = doc.entities.filter((entity): entity is typeof line => entity.type === 'line').map((entity) => entity.end);
    const rotated = endpoints.find((point) => Math.abs(point.y - 4) < 1e-6);
    const original = endpoints.find((point) => point.x === 4 && point.y === 0);
    expect(rotated).toBeTruthy();
    expect(rotated?.x).toBeCloseTo(0);
    expect(rotated?.y).toBeCloseTo(4);
    expect(original).toBeTruthy();
    history.undo();
    expect(doc.entities).toHaveLength(1);
  });

  it('creates a polar array of solids in world space', async () => {
    const { doc, manager, history } = setup();
    const mesh = {
      positions: new Float32Array([2, 0, 0, 4, 0, 0, 2, 1, 0]),
      indices: new Uint32Array([0, 1, 2]),
    };
    const solid = doc.createSolid(mesh, 'solid', 1, []);
    doc.addSolid(solid);
    doc.selectSolid(solid.id);
    manager.startCommand('ARRAY_POLAR');

    await manager.submitInput('0,0');
    await manager.submitInput('2');
    await manager.submitInput('90');

    expect(doc.solids).toHaveLength(2);
    expect(doc.solids[1].mesh.positions[0]).toBeCloseTo(0);
    expect(doc.solids[1].mesh.positions[1]).toBeCloseTo(2);
    history.undo();
    expect(doc.solids).toHaveLength(1);
  });

  it('creates a sweep solid from a closed profile and a path', async () => {
    const { doc, manager, history } = setup();
    const profile = doc.createRectangle({ x: 0, y: 0 }, { x: 2, y: 1 });
    const path = doc.createLine({ x: 0, y: 0 }, { x: 8, y: 0 });
    doc.entities.push(profile, path);
    manager.startCommand('SWEEP');

    await manager.handleClick({ x: 0, y: 0 }, profile);
    await manager.handleClick({ x: 4, y: 0 }, path);

    expect(doc.solids).toHaveLength(1);
    expect(doc.solids[0].feature.kind).toBe('sweep');
    expect(doc.entities).toHaveLength(1);
    history.undo();
    expect(doc.solids).toHaveLength(0);
    expect(doc.entities).toHaveLength(2);
  });

  it('accepts a window selection while COPY is selecting objects', async () => {
    const { doc, manager } = setup();
    const first = doc.createLine({ x: 0, y: 0 }, { x: 2, y: 0 });
    const second = doc.createCircle({ x: 5, y: 5 }, 2);
    doc.entities.push(first, second);
    manager.startCommand('COPY');
    doc.selectEntity(first.id, true);
    doc.selectEntity(second.id, true);

    expect(manager.syncWindowSelection()).toBe(true);
    await manager.submitInput('');

    expect(manager.active).toMatchObject({ name: 'COPY', stepIndex: 1 });
    expect(manager.active?.data.entities).toHaveLength(2);
  });

  it('accepts a window selection while JOIN is selecting objects', async () => {
    const { doc, manager } = setup();
    const first = doc.createLine({ x: 0, y: 0 }, { x: 2, y: 0 });
    const second = doc.createLine({ x: 2, y: 0 }, { x: 4, y: 0 });
    doc.entities.push(first, second);
    manager.startCommand('JOIN');
    doc.selectEntity(first.id, true);
    doc.selectEntity(second.id, true);

    expect(manager.syncWindowSelection()).toBe(true);
    await manager.submitInput('');

    expect(doc.entities).toHaveLength(1);
    expect(doc.entities[0]).toMatchObject({ type: 'polyline' });
  });

  it('scales a preselected entity around a base point by a numeric factor', async () => {
    const { doc, manager, history } = setup();
    const circle = doc.createCircle({ x: 3, y: 2 }, 2);
    doc.addEntity(circle);
    doc.selectEntity(circle.id);
    manager.startCommand('SCALE');
    expect(manager.active).toMatchObject({ name: 'SCALE', stepIndex: 1 });

    await manager.handleClick({ x: 1, y: 2 });
    await manager.submitInput('2');

    expect(doc.entities[0]).toMatchObject({ type: 'circle', center: { x: 5, y: 2 }, radius: 4 });
    history.undo();
    expect(doc.entities[0]).toMatchObject({ type: 'circle', center: { x: 3, y: 2 }, radius: 2 });
  });

  it('explodes a preselected rectangle into four undoable lines', async () => {
    const { doc, manager, history } = setup();
    const rectangle = doc.createRectangle({ x: 0, y: 0 }, { x: 8, y: 3 });
    doc.addEntity(rectangle);
    doc.selectEntity(rectangle.id);
    manager.startCommand('EXPLODE');
    await manager.submitInput('');

    expect(doc.entities).toHaveLength(4);
    expect(doc.entities.every((entity) => entity.type === 'line')).toBe(true);
    expect(doc.getSelectedEntities()).toHaveLength(4);
    history.undo();
    expect(doc.entities).toHaveLength(1);
    expect(doc.entities[0].type).toBe('rectangle');
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

  // A 3-4-5 triangle: the legs are 3 and 4, the diagonal is 5. MEASURE is the
  // linear dimension, so it reads a leg — reading 5 is what DIMALIGNED is for.
  it('creates a persistent linear dimension and remains active', async () => {
    const { doc, log, manager } = setup();
    manager.startCommand('MEASURE');
    await manager.handleClick({ x: 0, y: 0 });
    await manager.handleClick({ x: 3, y: 4 });
    await manager.handleClick({ x: 0, y: 8 }); // pulled upwards, so it reads across
    expect(doc.entities[0]).toMatchObject({
      type: 'dimension', dimensionKind: 'linear', rotation: 0,
      start: { x: 0, y: 0 }, end: { x: 3, y: 4 }, offset: { x: 0, y: 8 },
    });
    expect(doc.entities[0].layer).toBe('dims');
    expect(doc.layers).toContain('dims');
    expect(log).toHaveBeenCalledWith(expect.stringContaining('Dimension created: 3.00 mm'));
    expect(manager.active).toMatchObject({ name: 'MEASURE', stepIndex: 0 });
  });

  it('creates radius and diameter dimensions from a selected circle', async () => {
    const { doc, manager } = setup();
    const circle = doc.createCircle({ x: 2, y: 3 }, 5);
    doc.entities.push(circle); doc.selectEntity(circle.id);

    manager.startCommand('DIMRADIUS');
    await manager.handleClick({ x: 12, y: 3 });
    expect(doc.entities.at(-1)).toMatchObject({ type: 'dimension', dimensionKind: 'radius', start: { x: 2, y: 3 }, end: { x: 7, y: 3 } });

    doc.selectEntity(circle.id);
    manager.startCommand('DIMDIAMETER');
    await manager.handleClick({ x: 2, y: 13 });
    expect(doc.entities.at(-1)).toMatchObject({ type: 'dimension', dimensionKind: 'diameter', end: { x: 2, y: 8 } });
  });

  it('creates parametric box and cylinder primitives with undo support', async () => {
    const { doc, history, manager } = setup();
    manager.startCommand('BOX');
    await manager.handleClick({ x: 0, y: 0 });
    await manager.handleClick({ x: 10, y: 6 });
    await manager.submitInput('4');
    expect(doc.solids[0]).toMatchObject({ name: 'Box', feature: { kind: 'primitive', primitive: 'box', width: 10, depth: 6, height: 4 } });
    history.undo(); expect(doc.solids).toHaveLength(0);
    history.redo(); expect(doc.solids).toHaveLength(1);

    manager.startCommand('CYLINDER');
    await manager.handleClick({ x: 20, y: 0 });
    await manager.submitInput('3');
    await manager.submitInput('8');
    expect(doc.solids.at(-1)).toMatchObject({ name: 'Cylinder', feature: { kind: 'primitive', primitive: 'cylinder', radius: 3, height: 8 } });
  });

  it('creates wedge, sphere, cone and pyramid primitives', async () => {
    const { doc, manager } = setup();
    manager.startCommand('WEDGE');
    await manager.handleClick({ x: 0, y: 0 }); await manager.handleClick({ x: 6, y: 4 }); await manager.submitInput('3');
    manager.startCommand('SPHERE');
    await manager.handleClick({ x: 10, y: 0 }); await manager.submitInput('2');
    manager.startCommand('CONE');
    await manager.handleClick({ x: 20, y: 0 }); await manager.submitInput('3'); await manager.submitInput('7');
    manager.startCommand('PYRAMID');
    await manager.handleClick({ x: 30, y: 0 }); await manager.submitInput('4'); await manager.submitInput('9');
    expect(doc.solids.map((solid) => solid.feature.kind === 'primitive' ? solid.feature.primitive : '')).toEqual(['wedge', 'sphere', 'cone', 'pyramid']);
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

describe('object selection steps', () => {
  // Window select, additive clicking and window consumption used to be gated on
  // three different hardcoded command-name lists that disagreed with each other.
  // They are all derived from the active step now, so these must stay in lockstep.
  const MULTI = ['COPY', 'SCALE', 'EXPLODE', 'MIRROR', 'JOIN', 'ROTATE', 'ARRAY_RECTANGULAR', 'ARRAY_POLAR'] as const;

  it.each(MULTI)('%s offers window select on its object step', (name) => {
    const { manager } = setup();
    manager.startCommand(name);
    expect(manager.isMultiObjectStep).toBe(true);
    expect(manager.isAdditiveStep).toBe(true);
  });

  // The real flow: the command starts with nothing selected, the user drags a
  // window, and the resulting document selection is synced back into the step.
  it('lets every multi-object step consume a window selection', () => {
    for (const name of MULTI) {
      const { doc, manager } = setup();
      manager.startCommand(name);
      const line = doc.createLine({ x: 0, y: 0 }, { x: 1, y: 0 });
      doc.addEntity(line);
      doc.selectEntity(line.id);
      expect(manager.syncWindowSelection()).toBe(true);
      expect(manager.active?.data.entities).toHaveLength(1);
    }
  });

  it('keeps single-object steps free of window select', () => {
    for (const name of ['OFFSET', 'TRIM', 'EXTEND'] as const) {
      const { manager } = setup();
      manager.startCommand(name);
      expect(manager.isMultiObjectStep).toBe(false);
      expect(manager.syncWindowSelection()).toBe(false);
    }
  });

  it('advances boolean operations additively without offering a window', () => {
    for (const name of ['UNION', 'SUBTRACT'] as const) {
      const { manager } = setup();
      manager.startCommand(name);
      expect(manager.isAdditiveStep).toBe(true);
      expect(manager.isMultiObjectStep).toBe(false);
    }
  });

  it('reports which picks the active step accepts', () => {
    const { manager } = setup();
    manager.startCommand('MOVE');
    expect(manager.stepAccepts('entity')).toBe(true);
    expect(manager.stepAccepts('solid')).toBe(true);

    manager.startCommand('OFFSET');
    expect(manager.stepAccepts('entity')).toBe(true);
    expect(manager.stepAccepts('solid')).toBe(false);

    manager.startCommand('UNION');
    expect(manager.stepAccepts('solid')).toBe(true);
    expect(manager.stepAccepts('entity')).toBe(false);
  });
});

describe('Enter finishes a multi-object step', () => {
  // ARRAY prompts "Select objects to array, then press Enter" but was missing
  // from the hardcoded list that handled Enter, so Enter cancelled it instead.
  // Enter must consume the gathered objects — either advancing to the next step
  // or completing the command. What it must never do is cancel.
  it.each(['MIRROR', 'JOIN', 'ROTATE', 'COPY', 'SCALE', 'EXPLODE', 'ARRAY_RECTANGULAR', 'ARRAY_POLAR'] as const)(
    '%s acts on Enter instead of cancelling',
    async (name) => {
      const { doc, log, manager } = setup();
      manager.startCommand(name);
      // Two connected lines: JOIN needs at least two, and the extra pick is
      // harmless for the others.
      const first = doc.createLine({ x: 0, y: 0 }, { x: 10, y: 0 });
      const second = doc.createLine({ x: 10, y: 0 }, { x: 10, y: 5 });
      doc.addEntity(first);
      doc.addEntity(second);
      await manager.handleClick({ x: 0, y: 0 }, first);
      await manager.handleClick({ x: 10, y: 5 }, second);
      expect(manager.active, `${name} should still be running after picking`).not.toBeNull();
      const stepAfterPick = manager.active?.stepIndex ?? -1;

      await manager.submitInput('');
      expect(log, `${name} cancelled on Enter`).not.toHaveBeenCalledWith('Command canceled.');
      const advanced = manager.active === null || (manager.active?.stepIndex ?? -1) > stepAfterPick;
      expect(advanced, `${name} ignored Enter`).toBe(true);
    },
  );

  it('still cancels on Enter when nothing was gathered', async () => {
    const { log, manager } = setup();
    manager.startCommand('MIRROR');
    await manager.submitInput('');
    expect(manager.active).toBeNull();
    expect(log).toHaveBeenCalledWith('Command canceled.');
  });
});

describe('TORUS command', () => {
  it('creates an undoable torus solid from centre, radius and tube radius', async () => {
    const { doc, history, manager } = setup();
    manager.startCommand('TORUS');
    await manager.handleClick({ x: 0, y: 0 });
    await manager.handleClick({ x: 10, y: 0 });
    await manager.submitInput('2');

    expect(doc.solids).toHaveLength(1);
    expect(doc.solids[0].feature).toMatchObject({
      kind: 'primitive', primitive: 'torus', radius: 10, tubeRadius: 2,
    });
    expect(doc.viewMode).toBe('3d');

    expect(history.undo()).toBe(true);
    expect(doc.solids).toHaveLength(0);
  });

  it('is reachable by name and by prefix like every other primitive', () => {
    const { manager } = setup();
    expect(manager.resolveAlias('torus')).toBe('TORUS');
    expect(manager.resolveAlias('tor')).toBe('TORUS');
    expect(manager.commandSuggestions('TOR')).toContain('TORUS');
  });

  it('refuses a tube that is thicker than the torus itself', async () => {
    const { doc, log, manager } = setup();
    manager.startCommand('TORUS');
    await manager.handleClick({ x: 0, y: 0 });
    await manager.handleClick({ x: 5, y: 0 });
    await manager.submitInput('9');

    expect(doc.solids).toHaveLength(0);
    expect(log).toHaveBeenCalledWith('Tube radius must be smaller than the torus radius.');
  });
});

describe('POLYLINE command', () => {
  it('appends a vertex per pick and stays on the same step', async () => {
    const { doc, manager } = setup();
    manager.startCommand('POLYLINE');
    await manager.handleClick({ x: 0, y: 0 });
    expect(manager.active?.stepIndex).toBe(1);

    await manager.handleClick({ x: 10, y: 0 });
    await manager.handleClick({ x: 10, y: 5 });
    // The repeating step must not advance while it is collecting.
    expect(manager.active?.stepIndex).toBe(1);
    expect(doc.entities).toHaveLength(0);
    expect(manager.active?.data.vertices).toHaveLength(3);
  });

  it('creates one undoable polyline on Enter', async () => {
    const { doc, history, manager } = setup();
    manager.startCommand('POLYLINE');
    await manager.handleClick({ x: 0, y: 0 });
    await manager.handleClick({ x: 10, y: 0 });
    await manager.handleClick({ x: 10, y: 5 });
    await manager.submitInput('');

    expect(doc.entities).toHaveLength(1);
    expect(doc.entities[0]).toMatchObject({ type: 'polyline', closed: false });
    const polyline = doc.entities[0];
    expect(polyline.type === 'polyline' && polyline.vertices).toHaveLength(3);

    expect(history.undo()).toBe(true);
    expect(doc.entities).toHaveLength(0);
  });

  it('closes the polyline on C', async () => {
    const { doc, manager } = setup();
    manager.startCommand('POLYLINE');
    await manager.handleClick({ x: 0, y: 0 });
    await manager.handleClick({ x: 10, y: 0 });
    await manager.handleClick({ x: 10, y: 5 });
    await manager.submitInput('C');

    expect(doc.entities[0]).toMatchObject({ type: 'polyline', closed: true });
  });

  it('restarts itself after finishing, like the other drawing tools', async () => {
    const { manager } = setup();
    manager.startCommand('POLYLINE');
    await manager.handleClick({ x: 0, y: 0 });
    await manager.handleClick({ x: 10, y: 0 });
    await manager.submitInput('');
    expect(manager.active).toMatchObject({ name: 'POLYLINE', stepIndex: 0 });
  });

  it('tracks ortho and the rubber band from the last vertex', async () => {
    const { manager } = setup();
    manager.startCommand('POLYLINE');
    await manager.handleClick({ x: 0, y: 0 });
    await manager.handleClick({ x: 10, y: 0 });
    expect(manager.active?.data.start).toMatchObject({ x: 10, y: 0 });
    await manager.handleClick({ x: 10, y: 5 });
    expect(manager.active?.data.start).toMatchObject({ x: 10, y: 5 });
  });

  it('drops a polyline that never got a second point', async () => {
    const { doc, log, manager } = setup();
    manager.startCommand('POLYLINE');
    await manager.handleClick({ x: 0, y: 0 });
    await manager.submitInput('');
    expect(doc.entities).toHaveLength(0);
    expect(log).toHaveBeenCalledWith('A polyline needs at least two points.');
  });

  it('refuses to close a polyline with only two points', async () => {
    const { doc, log, manager } = setup();
    manager.startCommand('POLYLINE');
    await manager.handleClick({ x: 0, y: 0 });
    await manager.handleClick({ x: 10, y: 0 });
    await manager.submitInput('C');
    expect(doc.entities).toHaveLength(0);
    expect(log).toHaveBeenCalledWith('A closed polyline needs at least three points.');
  });
});

describe('commands built from the registry', () => {
  it('takes its steps from the registry definition', () => {
    const { manager } = setup();
    for (const command of COMMAND_LIST) {
      if (!command.steps) continue;
      manager.startCommand(command.name);
      expect(manager.active?.name, `${command.name} did not start`).toBe(command.name);
      expect(manager.active?.steps, `${command.name} steps differ`).toEqual(command.steps);
      expect(manager.active?.stepIndex).toBe(0);
    }
  });

  // The registry holds one definition; the wizard must never mutate it.
  it('does not let a run mutate the shared definition', async () => {
    const { doc, manager } = setup();
    manager.startCommand('POLYLINE');
    await manager.handleClick({ x: 0, y: 0 });
    await manager.handleClick({ x: 10, y: 0 });
    await manager.submitInput('');
    expect(doc.entities).toHaveLength(1);

    manager.startCommand('POLYLINE');
    expect(manager.active?.data.vertices, 'vertices leaked into the next run').toHaveLength(0);
    expect(commandDef('POLYLINE').steps).toEqual(commandDef('POLYLINE').steps);
    expect(manager.active?.steps).not.toBe(commandDef('POLYLINE').steps);
  });
});

describe('Enter repeats the last command', () => {
  it('restarts the last command at an empty prompt', async () => {
    const { manager } = setup();
    manager.startCommand('CIRCLE');
    manager.cancelActive();
    expect(manager.active).toBeNull();

    await manager.submitInput('');
    expect(manager.active).toMatchObject({ name: 'CIRCLE', stepIndex: 0 });
  });

  it('repeats a command started from the toolbar, not just a typed one', async () => {
    const { manager } = setup();
    // startCommand is what the toolbar calls; nothing was typed.
    manager.startCommand('RECTANGLE');
    manager.cancelActive();
    await manager.submitInput('');
    expect(manager.active).toMatchObject({ name: 'RECTANGLE' });
  });

  it('repeats after a command completes', async () => {
    const { doc, manager } = setup();
    manager.startCommand('LINE');
    await manager.handleClick({ x: 0, y: 0 });
    await manager.handleClick({ x: 5, y: 0 });
    expect(doc.entities).toHaveLength(1);
    manager.cancelActive();

    await manager.submitInput('');
    expect(manager.active).toMatchObject({ name: 'LINE' });
  });

  it('repeats an immediate command too', async () => {
    const { doc, log, manager } = setup();
    const before = doc.snapEnabled;
    manager.startCommand('SNAP');
    expect(doc.snapEnabled).toBe(!before);
    await manager.submitInput('');
    expect(doc.snapEnabled).toBe(before);
    expect(log).toHaveBeenCalledTimes(2);
  });

  it('does nothing at an empty prompt before any command has run', async () => {
    const { manager } = setup();
    await manager.submitInput('');
    expect(manager.active).toBeNull();
  });

  // While a command is running, Enter belongs to that command's step.
  it('does not hijack Enter from a running command', async () => {
    const { doc, manager } = setup();
    manager.startCommand('POLYLINE');
    await manager.handleClick({ x: 0, y: 0 });
    await manager.handleClick({ x: 10, y: 0 });
    await manager.submitInput('');
    expect(doc.entities).toHaveLength(1);
  });
});

describe('commands take the selection you already made', () => {
  const withSelection = (count: number) => {
    const kit = setup();
    for (let index = 0; index < count; index++) {
      const line = kit.doc.createLine({ x: index, y: 0 }, { x: index + 1, y: 1 });
      kit.doc.addEntity(line);
      kit.doc.selectEntity(line.id, true);
    }
    return kit;
  };

  // Selecting objects and then picking a tool must not ask for them again.
  it.each(['COPY', 'SCALE', 'ROTATE', 'MIRROR', 'ARRAY_RECTANGULAR', 'ARRAY_POLAR'] as const)(
    '%s skips its selection step when objects are already selected',
    (name) => {
      const { manager } = withSelection(2);
      manager.startCommand(name);
      expect(manager.active?.stepIndex, `${name} asked again`).toBe(1);
      expect(manager.active?.data.entities).toHaveLength(2);
    },
  );

  it.each(['COPY', 'SCALE', 'ROTATE', 'MIRROR'] as const)('%s still asks when nothing is selected', (name) => {
    const { manager } = setup();
    manager.startCommand(name);
    expect(manager.active?.stepIndex).toBe(0);
  });

  it('MIRROR mirrors the objects it was handed', async () => {
    const { doc, manager } = withSelection(1);
    manager.startCommand('MIRROR');
    await manager.handleClick({ x: 0, y: -1 });
    await manager.handleClick({ x: 5, y: -1 });
    // One original plus one mirrored copy.
    expect(doc.entities).toHaveLength(2);
  });

  it('MOVE takes however many objects were preselected', () => {
    const { manager } = withSelection(3);
    manager.startCommand('MOVE');
    expect(manager.active?.stepIndex).toBe(1);
    expect(manager.active?.data.entities).toHaveLength(3);
  });
});

describe('a preselection that answers everything runs the command', () => {
  const withSelectedLines = (count: number) => {
    const kit = setup();
    for (let index = 0; index < count; index++) {
      const line = kit.doc.createLine({ x: index * 10, y: 0 }, { x: index * 10 + 5, y: 0 });
      kit.doc.addEntity(line);
      kit.doc.selectEntity(line.id, true);
    }
    return kit;
  };

  // Select, hit ERASE, gone — waiting for an Enter would only confirm the screen.
  it('deletes a preselection the moment ERASE starts', () => {
    const { doc, manager } = withSelectedLines(3);
    manager.startCommand('ERASE');
    expect(doc.entities).toHaveLength(0);
    expect(manager.active).toBeNull();
  });

  it('deletes everything as one undoable step', () => {
    const { doc, history, manager } = withSelectedLines(3);
    manager.startCommand('ERASE');
    expect(doc.entities).toHaveLength(0);
    expect(history.undo()).toBe(true);
    expect(doc.entities).toHaveLength(3);
    expect(history.undo()).toBe(false);
  });

  it('still asks when ERASE starts with nothing selected', async () => {
    const { doc, manager } = setup();
    const line = doc.createLine({ x: 0, y: 0 }, { x: 5, y: 0 });
    doc.addEntity(line);
    manager.startCommand('ERASE');
    expect(manager.active?.stepIndex).toBe(0);
    expect(doc.entities).toHaveLength(1);

    await manager.handleClick({ x: 2, y: 0 }, line);
    // Gathering, not deleting yet.
    expect(doc.entities).toHaveLength(1);
    await manager.submitInput('');
    expect(doc.entities).toHaveLength(0);
  });

  it('deletes several picked objects together', async () => {
    const { doc, history, manager } = setup();
    const lines = [0, 1].map((index) => {
      const line = doc.createLine({ x: index * 10, y: 0 }, { x: index * 10 + 5, y: 0 });
      doc.addEntity(line);
      return line;
    });
    manager.startCommand('ERASE');
    for (const line of lines) await manager.handleClick({ x: line.start.x, y: 0 }, line);
    await manager.submitInput('');
    expect(doc.entities).toHaveLength(0);
    history.undo();
    expect(doc.entities).toHaveLength(2);
  });

  // A command with more to ask must not be short-circuited by the same rule.
  it.each(['COPY', 'SCALE', 'ROTATE', 'MIRROR', 'ARRAY_RECTANGULAR'] as const)(
    '%s still asks for the rest after a preselection',
    (name) => {
      const { manager } = withSelectedLines(2);
      manager.startCommand(name);
      expect(manager.active, `${name} completed too early`).not.toBeNull();
      expect(manager.active?.stepIndex).toBe(1);
    },
  );

  it('joins a preselection on start, and says why when there is too little', () => {
    const { doc, log, manager } = withSelectedLines(1);
    manager.startCommand('JOIN');
    expect(doc.entities).toHaveLength(1);
    expect(log).toHaveBeenCalledWith('JOIN requires at least two connected objects.');
  });
});

describe('ELLIPSE and CIRCLE_DIAMETER', () => {
  it('draws an ellipse from centre, first axis and the second axis distance', async () => {
    const { doc, history, manager } = setup();
    manager.startCommand('ELLIPSE');
    await manager.handleClick({ x: 0, y: 0 });
    await manager.handleClick({ x: 10, y: 0 });  // major axis along +X, so radiusX = 10
    await manager.handleClick({ x: 0, y: 4 });   // perpendicular distance 4
    expect(doc.entities[0]).toMatchObject({ type: 'ellipse', center: { x: 0, y: 0 }, radiusX: 10, radiusY: 4 });
    expect(history.undo()).toBe(true);
    expect(doc.entities).toHaveLength(0);
  });

  it('takes the rotation from the first axis', async () => {
    const { doc, manager } = setup();
    manager.startCommand('ELLIPSE');
    await manager.handleClick({ x: 0, y: 0 });
    await manager.handleClick({ x: 0, y: 6 });   // axis straight up
    await manager.handleClick({ x: 2, y: 0 });
    const ellipse = doc.entities[0];
    expect(ellipse.type === 'ellipse' && ellipse.rotation).toBeCloseTo(Math.PI / 2);
    expect(ellipse.type === 'ellipse' && ellipse.radiusX).toBeCloseTo(6);
    expect(ellipse.type === 'ellipse' && ellipse.radiusY).toBeCloseTo(2);
  });

  it('refuses a degenerate ellipse', async () => {
    const { doc, log, manager } = setup();
    manager.startCommand('ELLIPSE');
    await manager.handleClick({ x: 0, y: 0 });
    await manager.handleClick({ x: 10, y: 0 });
    await manager.handleClick({ x: 5, y: 0 }); // no perpendicular distance at all
    expect(doc.entities).toHaveLength(0);
    expect(log).toHaveBeenCalledWith('Ellipse radii must be greater than zero.');
  });

  // The distance to the picked point is the diameter, as in AutoCAD's D option.
  it('treats the picked distance as the diameter', async () => {
    const { doc, manager } = setup();
    manager.startCommand('CIRCLE_DIAMETER');
    await manager.handleClick({ x: 0, y: 0 });
    await manager.handleClick({ x: 10, y: 0 });
    expect(doc.entities[0]).toMatchObject({ type: 'circle', radius: 5 });
  });

  it('treats a typed number as the diameter, where CIRCLE takes it as the radius', async () => {
    const byDiameter = setup();
    byDiameter.manager.startCommand('CIRCLE_DIAMETER');
    await byDiameter.manager.handleClick({ x: 0, y: 0 });
    await byDiameter.manager.submitInput('10');
    expect(byDiameter.doc.entities[0]).toMatchObject({ type: 'circle', radius: 5 });

    const byRadius = setup();
    byRadius.manager.startCommand('CIRCLE');
    await byRadius.manager.handleClick({ x: 0, y: 0 });
    await byRadius.manager.submitInput('10');
    expect(byRadius.doc.entities[0]).toMatchObject({ type: 'circle', radius: 10 });
  });

  it('restarts like the other drawing tools', async () => {
    const { manager } = setup();
    manager.startCommand('ELLIPSE');
    await manager.handleClick({ x: 0, y: 0 });
    await manager.handleClick({ x: 10, y: 0 });
    await manager.handleClick({ x: 0, y: 4 });
    expect(manager.active).toMatchObject({ name: 'ELLIPSE', stepIndex: 0 });
  });

  it('picks an ellipse on its outline and inside it', () => {
    const { doc } = setup();
    const ellipse = doc.createEllipse({ x: 0, y: 0 }, 10, 4, 0);
    doc.entities.push(ellipse);
    expect(hitTestEntity(doc.entities, { x: 10, y: 0 }, 0.2)).toMatchObject({ id: ellipse.id });
    expect(hitTestEntity(doc.entities, { x: 0, y: 4 }, 0.2)).toMatchObject({ id: ellipse.id });
    expect(hitTestEntity(doc.entities, { x: 0, y: 0 }, 0.2)).toMatchObject({ id: ellipse.id });
    // Outside the curve: 10 along X is on it, but 10 along Y is nowhere near.
    expect(hitTestEntity(doc.entities, { x: 0, y: 10 }, 0.2)).toBeNull();
  });
});

describe('MOVE takes as many objects as you give it', () => {
  it('gathers several picks and moves them all', async () => {
    const { doc, manager, moveObjects } = setup();
    const lines = [0, 1].map((index) => {
      const line = doc.createLine({ x: index * 10, y: 0 }, { x: index * 10 + 5, y: 0 });
      doc.addEntity(line);
      return line;
    });
    manager.startCommand('MOVE');
    for (const line of lines) await manager.handleClick({ x: line.start.x, y: 0 }, line);
    expect(manager.active?.stepIndex, 'still gathering').toBe(0);

    await manager.submitInput('');
    await manager.handleClick({ x: 0, y: 0 });
    await manager.handleClick({ x: 3, y: 4 });
    expect(moveObjects).toHaveBeenCalledWith(lines, { x: 3, y: 4 }, undefined);
  });

  it('hands over solids by id alongside entities', async () => {
    const { doc, manager, moveObjects } = setup();
    const line = doc.createLine({ x: 0, y: 0 }, { x: 5, y: 0 });
    doc.addEntity(line);
    const solid = doc.createSolid(
      { positions: new Float32Array([0, 0, 0]), indices: new Uint32Array([0]) },
      'Box', 1, [], undefined, { kind: 'mesh' },
    );
    doc.addSolid(solid);

    manager.startCommand('MOVE');
    await manager.handleClick({ x: 0, y: 0 }, line);
    await manager.handleClick({ x: 0, y: 0 }, undefined, solid.id);
    await manager.submitInput('');
    await manager.handleClick({ x: 0, y: 0 });
    await manager.handleClick({ x: 1, y: 1 });
    expect(moveObjects).toHaveBeenCalledWith([line, solid.id], { x: 1, y: 1 }, undefined);
  });

  it('says so rather than moving nothing', async () => {
    const { log, manager, moveObjects } = setup();
    manager.startCommand('MOVE');
    manager.active!.stepIndex = 2;
    manager.active!.data.basePoint = { x: 0, y: 0 };
    await manager.handleClick({ x: 5, y: 5 });
    expect(moveObjects).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith('Nothing to move.');
  });
});

describe('linear and aligned dimensions', () => {
  // The points form a 3-4-5 triangle, so the answer says which one it measured.
  const measure = async (name: 'MEASURE' | 'DIMALIGNED', offset: { x: number; y: number }) => {
    const kit = setup();
    kit.manager.startCommand(name);
    await kit.manager.handleClick({ x: 0, y: 0 });
    await kit.manager.handleClick({ x: 3, y: 4 });
    await kit.manager.handleClick(offset);
    const dimension = kit.doc.entities[0];
    return { dimension, text: dimension.type === 'dimension' ? dimensionGeometry(dimension).text : '' };
  };

  it('reads the horizontal leg when the dimension line is pulled up', async () => {
    const { dimension, text } = await measure('MEASURE', { x: 1.5, y: 9 });
    expect(dimension).toMatchObject({ dimensionKind: 'linear', rotation: 0 });
    expect(text).toBe('3.00');
  });

  it('reads the vertical leg when the dimension line is pulled aside', async () => {
    const { dimension, text } = await measure('MEASURE', { x: -6, y: 2 });
    expect(dimension).toMatchObject({ dimensionKind: 'linear', rotation: Math.PI / 2 });
    expect(text).toBe('4.00');
  });

  it('reads the diagonal only when asked for an aligned dimension', async () => {
    const { dimension, text } = await measure('DIMALIGNED', { x: -4, y: 5 });
    expect(dimension).toMatchObject({ dimensionKind: 'aligned' });
    expect(text).toBe('5.00');
  });

  it('is reachable as its own command', () => {
    const { manager } = setup();
    expect(manager.resolveAlias('dal')).toBe('DIMALIGNED');
    expect(manager.commandSuggestions('DIM')).toContain('DIMALIGNED');
  });
});
