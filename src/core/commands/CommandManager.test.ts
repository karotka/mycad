import { describe, expect, it, vi } from 'vitest';
import { Document } from '../Document';
import { CommandHistory } from '../history/CommandHistory';
import { CommandManager, hitTestEntity } from './CommandManager';
import { ellipsePoints, expandedInsertSolids, linearDimensionRotation } from '../entities/types';
import { COMMAND_LIST, commandDef } from './registry';
import { dimensionGeometry } from '../entities/types';
import { cloneWorkPlane, localToWorld, workPlaneFromXAxis, WORLD_WORK_PLANE } from '../../math/workplane';
import { createBoxMesh, createCylinderMesh, primitivePreviewMesh as primitiveMesh } from '../geometry/PrimitiveMesh';
import { regenerateExactFeatureMesh as regenerateSolidFeature } from '../geometry/FeatureMesh';
import { boxLikePrimitiveFeature, radialLikePrimitiveFeature, torusPrimitiveFeature } from './steps/solids';
import { planarFaceRegionAt, solidCircularEdges, solidDesignEdges, solidPlanarFaces } from '../solids/SolidTopology';
import { buildExactFeature, openExactShape } from '../geometry/ExactSolid';
import { openCascadeKernel } from '../geometry/OpenCascadeRuntime';

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
  it('measures AREA after three points by Enter or by clicking the first point', async () => {
    const { manager, log } = setup();
    manager.startCommand('AREA');
    await manager.handleClick({ x: 0, y: 0 });
    await manager.handleClick({ x: 10, y: 0 });
    await manager.handleClick({ x: 10, y: 5 });
    await manager.submitInput('');
    expect(log).toHaveBeenCalledWith('Area = 25.000 mm², Perimeter = 26.180 mm');
    expect(manager.active).toBeNull();

    manager.startCommand('AREA');
    await manager.handleClick({ x: 0, y: 0 });
    await manager.handleClick({ x: 4, y: 0 });
    await manager.handleClick({ x: 4, y: 3 });
    await manager.handleClick({ x: 0, y: 0 });
    expect(log).toHaveBeenCalledWith('Area = 6.000 mm², Perimeter = 12.000 mm');
    expect(manager.active).toBeNull();
  });
  it('edits imported-style text through TEXTEDIT and undo', async () => {
    const { doc, manager, history } = setup();
    const text = doc.createText({ x: 2, y: 3 }, 'Old text', 2.5);
    doc.addEntity(text);
    doc.selectEntity(text.id);

    manager.startCommand('TEXTEDIT');
    expect(manager.active).toMatchObject({ name: 'TEXTEDIT', stepIndex: 1 });
    await manager.submitInput('New text');
    expect(doc.getEntity(text.id)).toMatchObject({ type: 'text', text: 'New text' });
    history.undo();
    expect(doc.getEntity(text.id)).toMatchObject({ type: 'text', text: 'Old text' });
  });
  it('carries a height alongside the text when TEXTEDIT answers through submitText, not just submitInput', async () => {
    const { doc, manager } = setup();
    const text = doc.createText({ x: 2, y: 3 }, 'Old text', 2.5);
    doc.addEntity(text);
    doc.selectEntity(text.id);

    manager.startCommand('TEXTEDIT');
    await manager.submitText('New text\nsecond line', 9);
    expect(doc.getEntity(text.id)).toMatchObject({ type: 'text', text: 'New text\nsecond line', height: 9 });
  });
  it('leaves height untouched when submitText is given none, same as a plain submitInput edit', async () => {
    const { doc, manager } = setup();
    const text = doc.createText({ x: 2, y: 3 }, 'Old text', 2.5);
    doc.addEntity(text);
    doc.selectEntity(text.id);

    manager.startCommand('TEXTEDIT');
    await manager.submitText('New text');
    expect(doc.getEntity(text.id)).toMatchObject({ type: 'text', text: 'New text', height: 2.5 });
  });
  it('creates multi-line MTEXT with the height submitText carries, overriding the step-1 height', async () => {
    const { doc, manager } = setup();
    manager.startCommand('MTEXT');
    await manager.submitInput('Arial');
    await manager.submitInput('2.5');
    await manager.handleClick({ x: 1, y: 1 });
    await manager.submitText('line one\nline two', 4);
    expect(doc.entities[0]).toMatchObject({
      type: 'text', text: 'line one\nline two', height: 4, font: 'Arial',
    });
  });
  it('changes the font TEXTEDIT answers with through submitText, overriding the original', async () => {
    const { doc, manager } = setup();
    const text = doc.createText({ x: 2, y: 3 }, 'Old text', 2.5, 'Arial');
    doc.addEntity(text);
    doc.selectEntity(text.id);

    manager.startCommand('TEXTEDIT');
    await manager.submitText('New text', 4, 'Single-stroke');
    expect(doc.getEntity(text.id)).toMatchObject({ type: 'text', text: 'New text', height: 4, font: 'Single-stroke' });
  });
  it('overrides the font a fresh MTEXT was started with, from the on-canvas editor', async () => {
    const { doc, manager } = setup();
    manager.startCommand('MTEXT');
    await manager.submitInput('Arial');
    await manager.submitInput('2.5');
    await manager.handleClick({ x: 1, y: 1 });
    await manager.submitText('line one', 2.5, 'Single-stroke');
    expect(doc.entities[0]).toMatchObject({ type: 'text', font: 'Single-stroke' });
  });
  it('ignores a submitText call for a step that is not currently asking for text', async () => {
    const { doc, manager } = setup();
    manager.startCommand('TEXT');
    await manager.submitInput('Arial');
    await manager.submitInput('2.5');
    expect(manager.active).toMatchObject({ name: 'TEXT', stepIndex: 2 }); // now waiting on a point, not text
    await manager.submitText('should be ignored', 5);
    expect(manager.active).toMatchObject({ name: 'TEXT', stepIndex: 2 });
    expect(doc.entities).toHaveLength(0);
  });
  it('suggests ambiguous command prefixes and keeps destructive erase explicit', () => {
    const { manager } = setup();
    expect(manager.commandSuggestions('m')).toEqual(['MTEXT', 'MEASURE', 'MOVE', 'MIRROR']);
    expect(manager.commandSuggestions('p')).toEqual(['POLYLINE', 'POLYGON', 'PYRAMID', 'PRESSPULL']);
    expect(manager.resolveAlias('pl')).toBe('POLYLINE');
    expect(manager.resolveAlias('p')).toBe('POLYGON');
    expect(manager.resolveAlias('mo')).toBe('MOVE');
    expect(manager.resolveAlias('e')).toBe('EXTRUDE');
    expect(manager.resolveAlias('s')).toBe('SUBTRACT');
    expect(manager.resolveAlias('u')).toBe('UNION');
    expect(manager.resolveAlias('int')).toBe('INTERSECT');
    expect(manager.resolveAlias('j')).toBe('JOIN');
    expect(manager.resolveAlias('b')).toBe('BLOCK');
    expect(manager.resolveAlias('i')).toBe('INSERT');
    expect(manager.resolveAlias('bez')).toBe('BEZIER');
    expect(manager.resolveAlias('erase')).toBe('ERASE');
  });

  it('requires an explicit solid selection and exports exactly the gathered solids', async () => {
    const { doc, manager } = setup();
    const first = doc.createSolid(
      { positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), indices: new Uint32Array([0, 1, 2]) },
      'first', 0, [],
    );
    const second = doc.createSolid(
      { positions: new Float32Array([10, 0, 0, 11, 0, 0, 10, 1, 0]), indices: new Uint32Array([0, 1, 2]) },
      'second', 0, [],
    );
    doc.solids.push(first, second);
    const exportStl = vi.fn();
    manager.updateContext({ exportStl });

    manager.startCommand('EXPORTSTL');
    expect(manager.currentPrompt()).toContain('Select 3D solid(s) or block(s)');
    expect(exportStl).not.toHaveBeenCalled();

    await manager.handleClick({ x: 0, y: 0 }, undefined, second.id);
    expect(exportStl).not.toHaveBeenCalled();
    await manager.submitInput('');

    expect(exportStl).toHaveBeenCalledOnce();
    expect(exportStl).toHaveBeenCalledWith([second]);
    expect(manager.active).toBeNull();
  });

  it('uses preselected solids for STL export without including other solids', () => {
    const { doc, manager } = setup();
    const first = doc.createSolid(
      { positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), indices: new Uint32Array([0, 1, 2]) },
      'first', 0, [],
    );
    const second = doc.createSolid(
      { positions: new Float32Array([10, 0, 0, 11, 0, 0, 10, 1, 0]), indices: new Uint32Array([0, 1, 2]) },
      'second', 0, [],
    );
    doc.solids.push(first, second);
    doc.selectSolid(first.id);
    const exportStl = vi.fn();
    manager.updateContext({ exportStl });

    manager.startCommand('EXPORTSTL');

    expect(exportStl).toHaveBeenCalledOnce();
    expect(exportStl).toHaveBeenCalledWith([first]);
    expect(manager.active).toBeNull();
  });

  it('exports transformed 3D contents of a selected block', () => {
    const { doc, manager } = setup();
    const solid = doc.createSolid(createBoxMesh(4, 6, 8), 'Box', 8, []);
    const definition = { name: 'SolidPart', basePoint: { x: 0, y: 0 }, entities: [], solids: [solid] };
    const insert = doc.createInsert(definition, { x: 10, y: 20 });
    insert.scaleZ = 2;
    doc.entities.push(insert);
    doc.selectEntity(insert.id);
    const exportStl = vi.fn();
    manager.updateContext({ exportStl });

    manager.startCommand('EXPORTSTL');

    expect(exportStl).toHaveBeenCalledOnce();
    const exported = exportStl.mock.calls[0][0];
    expect(exported).toHaveLength(1);
    expect(Array.from(exported[0].mesh.positions)).toEqual(expect.arrayContaining([8, 17, 0, 12, 23, 16]));
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

  it('joins coplanar lines that carry different work-plane origins', () => {
    const { doc, manager } = setup();
    // Same world plane, but line2 stores a shifted work-plane origin — as lines
    // drawn on a face in a UCS do. They meet at world (10, 0).
    const line1 = doc.createLine({ x: 0, y: 0 }, { x: 10, y: 0 });
    const line2 = doc.createLine({ x: 0, y: 0 }, { x: 10, y: 0 });
    line2.workPlane = { ...cloneWorkPlane(WORLD_WORK_PLANE), origin: { x: 10, y: 0, z: 0 } };
    doc.entities.push(line1, line2);
    doc.selectEntity(line1.id, true);
    doc.selectEntity(line2.id, true);
    manager.startCommand('JOIN');
    expect(doc.entities).toHaveLength(1);
    expect(doc.entities[0]).toMatchObject({ type: 'polyline' });
    expect(doc.entities[0].type === 'polyline' && doc.entities[0].vertices).toEqual([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 20, y: 0 }]);
  });

  it('joins a horizontal and a vertical line into a polyline in their shared plane', () => {
    const { doc, manager } = setup();
    // A flat leg on the world plane and a leg rising in Z meet at (10, 0, 0).
    // They are coplanar (the X-Z plane), which is neither leg's own work plane.
    const horizontal = doc.createLine({ x: 0, y: 0 }, { x: 10, y: 0 });
    const vertical = doc.createLine({ x: 10, y: 0, z: 0 } as never, { x: 10, y: 0, z: 8 } as never);
    doc.entities.push(horizontal, vertical);
    doc.selectEntity(horizontal.id, true);
    doc.selectEntity(vertical.id, true);
    manager.startCommand('JOIN');
    expect(doc.entities).toHaveLength(1);
    expect(doc.entities[0]).toMatchObject({ type: 'polyline' });
    expect(doc.entities[0].type === 'polyline' && doc.entities[0].vertices).toHaveLength(3);
  });

  /**
   * JOIN used to flatten every mixed chain into a many-point polyline, losing
   * the curve's own exactness — a straight run and an original Bezier segment
   * both have an exact cubic form, so there is no need to sample either one.
   */
  it('joins a Bezier curve to a connected line into one exact spline, not a flattened polyline', async () => {
    const { doc, manager } = setup();
    const line = doc.createLine({ x: 0, y: 0 }, { x: 5, y: 0 });
    const bezier = doc.createBezier({ x: 5, y: 0 }, { x: 7, y: 0 }, { x: 8, y: 4 }, { x: 10, y: 4 });
    doc.entities.push(line, bezier);
    doc.selectEntity(line.id, true); doc.selectEntity(bezier.id, true);
    manager.startCommand('JOIN');
    expect(doc.entities).toHaveLength(1);
    const joined = doc.entities[0];
    expect(joined).toMatchObject({ type: 'bezier', start: { x: 0, y: 0 } });
    if (joined.type === 'bezier') {
      expect(joined.segments).toHaveLength(2);
      expect(joined.segments[0].end).toMatchObject({ x: 5, y: 0 }); // the line's exact degenerate cubic
      expect(joined.segments[1]).toEqual({ control1: { x: 7, y: 0 }, control2: { x: 8, y: 4 }, end: { x: 10, y: 4 } }); // carried through untouched
    }
  });

  /**
   * The bug: joining two curves whose first leg does not run along world X
   * (an ordinary pair of hand-drawn splines, not a straight horizontal line)
   * used to fit the result a work plane rotated to match that leg. The outline
   * still drew correctly — that goes through the work-plane transform — but
   * every grip on it (drag, 2D hover hit-testing) compares straight against
   * the mouse's world position with no such transform, so they landed nowhere
   * near the curve. A flat, ordinary 2D chain needs no plane of its own at
   * all: it can keep world coordinates directly, like every other 2D entity.
   */
  it('joins two non-axis-aligned Beziers into one exact spline without giving it a rotated plane of its own', async () => {
    const { doc, manager } = setup();
    const first = doc.createBezier({ x: 0, y: 0 }, { x: 1, y: 3 }, { x: 3, y: 6 }, { x: 5, y: 8 });
    const second = doc.createBezier({ x: 5, y: 8 }, { x: 7, y: 9 }, { x: 9, y: 5 }, { x: 12, y: 3 });
    doc.entities.push(first, second);
    doc.selectEntity(first.id, true); doc.selectEntity(second.id, true);
    manager.startCommand('JOIN');
    expect(doc.entities).toHaveLength(1);
    const joined = doc.entities[0];
    expect(joined).toMatchObject({ type: 'bezier', start: { x: 0, y: 0 } });
    // The active (world) work plane, not one rotated to match either curve's
    // own tangent — the same reasoning that already applied to a joined
    // polyline applies here too, since grips still work in world coordinates.
    expect(joined.workPlane).toEqual(doc.activeWorkPlane);
    if (joined.type === 'bezier') {
      // Both curves are carried through exactly — no resampling at all.
      expect(joined.segments).toEqual([
        { control1: { x: 1, y: 3 }, control2: { x: 3, y: 6 }, end: { x: 5, y: 8 } },
        { control1: { x: 7, y: 9 }, control2: { x: 9, y: 5 }, end: { x: 12, y: 3 } },
      ]);
    }
  });

  it('splits a wide arc sweep into multiple Bezier spans, each closely matching the true circle', async () => {
    const { doc, manager } = setup();
    const center = { x: 0, y: 0 }, radius = 10;
    // Two semicircles, closing a full circle — each 180° sweep needs more
    // than one cubic span to stay a close match to the true arc.
    const upper = doc.createArc(center, radius, 0, Math.PI);
    const lower = doc.createArc(center, radius, Math.PI, Math.PI);
    doc.entities.push(upper, lower);
    doc.selectEntity(upper.id, true); doc.selectEntity(lower.id, true);
    manager.startCommand('JOIN');
    expect(doc.entities).toHaveLength(1);
    const joined = doc.entities[0];
    expect(joined).toMatchObject({ type: 'bezier', start: { x: 10, y: 0 } });
    if (joined.type === 'bezier') {
      expect(joined.segments).toHaveLength(4); // two spans per 180° sweep
      // The loop closes back to its own start.
      expect(joined.segments.at(-1)!.end.x).toBeCloseTo(10, 6);
      expect(joined.segments.at(-1)!.end.y).toBeCloseTo(0, 6);
      // Every span's own end sits on the true circle, not just near it.
      for (const segment of joined.segments) {
        expect(Math.hypot(segment.end.x - center.x, segment.end.y - center.y)).toBeCloseTo(radius, 6);
      }
    }
  });

  it('joins an arc to a connected line into one exact spline, approximating only the arc', async () => {
    const { doc, manager } = setup();
    const line = doc.createLine({ x: 0, y: 0 }, { x: 5, y: 0 });
    const arc = doc.createArc({ x: 5, y: 5 }, 5, -Math.PI / 2, Math.PI / 2);
    doc.entities.push(line, arc);
    manager.startCommand('JOIN');
    await manager.handleClick({ x: 2, y: 0 }, line);
    await manager.handleClick({ x: 7, y: 1 }, arc);
    await manager.submitInput('');
    expect(doc.entities).toHaveLength(1);
    const joined = doc.entities[0];
    expect(joined).toMatchObject({ type: 'bezier', start: { x: 0, y: 0 } });
    if (joined.type === 'bezier') {
      expect(joined.segments).toHaveLength(2);
      expect(joined.segments[0].end).toMatchObject({ x: 5, y: 0 }); // the line's exact degenerate cubic
      const arcEnd = joined.segments.at(-1)!.end;
      expect(arcEnd.x).toBeCloseTo(10, 6);
      expect(arcEnd.y).toBeCloseTo(5, 6);
    }
  });

  it('extends a line to a selected boundary', async () => {
    const { doc, manager } = setup();
    const boundary = doc.createPolyline([{ x: 10, y: -5 }, { x: 10, y: 5 }], false);
    const target = doc.createPolyline([{ x: 0, y: 0 }, { x: 6, y: 0 }], false);
    doc.entities.push(boundary, target);
    manager.startCommand('EXTEND');
    await manager.handleClick({ x: 10, y: 0 }, boundary);
    await manager.submitInput(''); // finish selecting boundary edges
    await manager.handleClick({ x: 5, y: 0 }, target);
    const extended = doc.getEntity(target.id);
    expect(extended).toMatchObject({ type: 'polyline' });
    if (extended?.type === 'polyline') expect(extended.vertices[1]).toMatchObject({ x: 10, y: 0 });
  });

  it('extends the start when clicked near the start, instead of always moving the far end', async () => {
    // The target's click point was never recorded for EXTEND (only TRIM), so
    // it always fell back to acting as if you had clicked at the far end —
    // which yanked the untouched end onto the boundary and left the line
    // collapsed or reversed instead of extended.
    const { doc, manager } = setup();
    const boundary = doc.createLine({ x: -5, y: -5 }, { x: -5, y: 5 });
    const target = doc.createLine({ x: 0, y: 0 }, { x: 10, y: 0 });
    doc.entities.push(boundary, target);
    manager.startCommand('EXTEND');
    await manager.handleClick({ x: -5, y: 0 }, boundary);
    await manager.submitInput(''); // finish selecting boundaries
    await manager.handleClick({ x: 1, y: 0 }, target); // clicked near the start
    const extended = doc.getEntity(target.id);
    expect(extended).toMatchObject({ type: 'line', start: { x: -5, y: 0 }, end: { x: 10, y: 0 } });
  });

  it('extends the end nearest the click, not whichever boundary happens to sit closer in space', async () => {
    // A far boundary beyond the clicked end and a near boundary beyond the
    // *opposite* end used to let proximity-to-click pick the near one, which
    // then got assigned to the far end — collapsing the line instead of
    // extending it, wiping out its original span.
    const { doc, manager } = setup();
    const farBoundary = doc.createLine({ x: 100, y: -5 }, { x: 100, y: 5 });
    const nearWrongSideBoundary = doc.createLine({ x: -1, y: -5 }, { x: -1, y: 5 });
    const target = doc.createLine({ x: 0, y: 0 }, { x: 10, y: 0 });
    doc.entities.push(farBoundary, nearWrongSideBoundary, target);
    manager.startCommand('EXTEND');
    await manager.handleClick({ x: 100, y: 0 }, farBoundary);
    await manager.handleClick({ x: -1, y: 0 }, nearWrongSideBoundary);
    await manager.submitInput(''); // finish selecting boundaries
    await manager.handleClick({ x: 9, y: 0 }, target); // clicked near the end
    const extended = doc.getEntity(target.id);
    expect(extended).toMatchObject({ type: 'line', start: { x: 0, y: 0 }, end: { x: 100, y: 0 } });
  });

  it('trims the clicked side of a line at a cutting edge', async () => {
    const { doc, manager } = setup();
    const cutter = doc.createPolyline([{ x: 5, y: -5 }, { x: 5, y: 5 }], false);
    const target = doc.createPolyline([{ x: 0, y: 0 }, { x: 10, y: 0 }], false);
    doc.entities.push(cutter, target);
    manager.startCommand('TRIM');
    await manager.handleClick({ x: 5, y: 0 }, cutter);
    await manager.submitInput(''); // finish selecting cutting edges
    await manager.handleClick({ x: 8, y: 0 }, target);
    const trimmed = doc.getEntity(target.id);
    expect(trimmed).toMatchObject({ type: 'polyline' });
    if (trimmed?.type === 'polyline') expect(trimmed.vertices[1]).toMatchObject({ x: 5, y: 0 });
  });

  it('shows the last offset distance in the prompt and reuses it on Enter', async () => {
    const { doc, manager } = setup();
    const first = doc.createLine({ x: 0, y: 0 }, { x: 10, y: 0 });
    doc.entities.push(first);
    manager.startCommand('OFFSET');
    await manager.handleClick({ x: 5, y: 0 }, first);
    expect(manager.currentPrompt()).toBe('Enter offset distance:'); // nothing remembered yet
    await manager.submitInput('2.5');
    await manager.handleClick({ x: 5, y: 5 });
    expect(doc.entities[1]).toMatchObject({ type: 'line', start: { x: 0, y: 2.5 } });

    const second = doc.createLine({ x: 0, y: 20 }, { x: 10, y: 20 });
    doc.entities.push(second);
    doc.clearSelection(); // the previous offset's result is still selected otherwise
    manager.startCommand('OFFSET');
    await manager.handleClick({ x: 5, y: 20 }, second);
    expect(manager.currentPrompt()).toBe('Enter offset distance (2.5):');
    await manager.submitInput(''); // Enter alone reuses it
    await manager.handleClick({ x: 5, y: 25 });
    expect(doc.entities[3]).toMatchObject({ type: 'line', start: { x: 0, y: 22.5 } });
  });

  it('shortens a plain line to a single cutting edge, same as a polyline', async () => {
    const { doc, manager } = setup();
    const cutter = doc.createLine({ x: 5, y: -5 }, { x: 5, y: 5 });
    const target = doc.createLine({ x: 0, y: 0 }, { x: 10, y: 0 });
    doc.entities.push(cutter, target);
    manager.startCommand('TRIM');
    await manager.handleClick({ x: 5, y: 0 }, cutter);
    await manager.submitInput('');
    await manager.handleClick({ x: 8, y: 0 }, target); // clicked side (x > 5) is the one removed
    const trimmed = doc.getEntity(target.id);
    expect(trimmed).toMatchObject({ type: 'line', start: { x: 0, y: 0 }, end: { x: 5, y: 0 } });
  });

  /**
   * The bug: with two parallel cutting edges selected, clicking the line
   * segment *between* them removed everything from that crossing to whichever
   * end the click happened to be nearer, using only the one edge closest to
   * the click — the other selected boundary was silently ignored. TRIM should
   * split the line into the two pieces left after cutting out just the middle.
   */
  it('splits a line into two pieces when the clicked span sits between two cutting edges', async () => {
    const { doc, manager, history } = setup();
    const left = doc.createLine({ x: 2, y: -5 }, { x: 2, y: 5 });
    const right = doc.createLine({ x: 8, y: -5 }, { x: 8, y: 5 });
    const target = doc.createLine({ x: 0, y: 0 }, { x: 10, y: 0 });
    doc.entities.push(left, right, target);
    manager.startCommand('TRIM');
    await manager.handleClick({ x: 2, y: 0 }, left);
    await manager.handleClick({ x: 8, y: 0 }, right);
    await manager.submitInput('');
    await manager.handleClick({ x: 5, y: 0 }, target); // the middle span, between both edges

    expect(doc.getEntity(target.id)).toBeUndefined();
    const pieces = doc.entities.filter((entity) => entity.type === 'line' && entity.id !== left.id && entity.id !== right.id);
    expect(pieces).toHaveLength(2);
    expect(pieces).toContainEqual(expect.objectContaining({ start: { x: 0, y: 0 }, end: { x: 2, y: 0 } }));
    expect(pieces).toContainEqual(expect.objectContaining({ start: { x: 8, y: 0 }, end: { x: 10, y: 0 } }));

    history.undo();
    expect(doc.entities.filter((entity) => entity.type === 'line')).toHaveLength(3);
    expect(doc.getEntity(target.id)).toMatchObject({ type: 'line', start: { x: 0, y: 0 }, end: { x: 10, y: 0 } });
  });

  it('trims a line where it crosses a circle cutting edge', async () => {
    const { doc, manager } = setup();
    const circle = doc.createCircle({ x: 0, y: 0 }, 5);
    const line = doc.createLine({ x: 0, y: 0 }, { x: 10, y: 0 });
    doc.entities.push(circle, line);
    manager.startCommand('TRIM');
    await manager.handleClick({ x: 4, y: 4 }, circle);
    await manager.submitInput(''); // finish selecting cutting edges
    await manager.handleClick({ x: 8, y: 0 }, line); // clicked side is outside the circle
    const trimmed = doc.getEntity(line.id);
    expect(trimmed).toMatchObject({ type: 'line' });
    if (trimmed?.type === 'line') {
      const points = [trimmed.start, trimmed.end];
      expect(points).toContainEqual({ x: 0, y: 0 });
      expect(points).toContainEqual({ x: 5, y: 0 });
    }
  });

  it('trims a circle into an arc, dropping the clicked span', async () => {
    const { doc, manager } = setup();
    const circle = doc.createCircle({ x: 0, y: 0 }, 5);
    const cutter = doc.createLine({ x: 0, y: -10 }, { x: 0, y: 10 });
    doc.entities.push(circle, cutter);
    manager.startCommand('TRIM');
    await manager.handleClick({ x: 0, y: 0 }, cutter);
    await manager.submitInput(''); // finish selecting cutting edges
    await manager.handleClick({ x: 5, y: 0 }, circle); // remove the right half
    // The circle is gone, replaced by an arc of the same radius.
    expect(doc.getEntity(circle.id)).toBeUndefined();
    const arc = doc.entities.find((entity) => entity.type === 'arc');
    expect(arc).toMatchObject({ type: 'arc', radius: 5 });
    // The kept span is the left half, so its midpoint sits at negative x.
    if (arc?.type === 'arc') expect(Math.cos(arc.startAngle + arc.sweepAngle / 2)).toBeLessThan(0);
  });

  it('trims a circle between two parallel cutting edges, keeping the clicked end cap', async () => {
    const { doc, manager } = setup();
    const circle = doc.createCircle({ x: 0, y: 0 }, 5);
    const left = doc.createLine({ x: -3, y: -10 }, { x: -3, y: 10 });
    const right = doc.createLine({ x: 3, y: -10 }, { x: 3, y: 10 });
    doc.entities.push(circle, left, right);
    manager.startCommand('TRIM');
    await manager.handleClick({ x: -3, y: 6 }, left);
    await manager.handleClick({ x: 3, y: 6 }, right);
    await manager.submitInput(''); // finish selecting the two cutting edges
    // Click the right cap (x > 3): it is bracketed by the right line's two
    // crossings, so only that cap is removed — impossible with a single edge.
    await manager.handleClick({ x: 5, y: 0 }, circle);
    expect(doc.getEntity(circle.id)).toBeUndefined();
    const arc = doc.entities.find((entity) => entity.type === 'arc');
    expect(arc).toMatchObject({ type: 'arc', radius: 5 });
    // The kept span runs the long way round (through the left cap), so its
    // midpoint sits on negative x.
    if (arc?.type === 'arc') expect(Math.cos(arc.startAngle + arc.sweepAngle / 2)).toBeLessThan(0);
  });

  it('trims coplanar objects whose work planes carry a different origin (same face, different UCS)', async () => {
    const { doc, manager } = setup();
    const planeAt = (ox: number, oy: number) => ({
      origin: { x: ox, y: oy, z: 0 },
      xAxis: { x: 1, y: 0, z: 0 }, yAxis: { x: 0, y: 1, z: 0 }, zAxis: { x: 0, y: 0, z: 1 },
    });
    // Circle centred at world (0,0), r=5, on a plane whose origin is shifted to (10,0).
    const circle = doc.createCircle({ x: -10, y: 0 }, 5);
    circle.workPlane = planeAt(10, 0);
    // Vertical cutter at world x=0, on a DIFFERENT plane origin (4,1) — same face, other UCS.
    const cutter = doc.createLine({ x: -4, y: -11 }, { x: -4, y: 9 });
    cutter.workPlane = planeAt(4, 1);
    doc.entities.push(circle, cutter);
    manager.startCommand('TRIM');
    await manager.handleClick({ x: 0, y: 6 }, cutter);
    await manager.submitInput('');
    await manager.handleClick({ x: 5, y: 0 }, circle); // remove the right half, in world coords
    // Previously this errored with "must be on the same work plane"; now it trims.
    expect(doc.getEntity(circle.id)).toBeUndefined();
    const arc = doc.entities.find((entity) => entity.type === 'arc');
    expect(arc).toMatchObject({ type: 'arc', radius: 5 });
    if (arc?.type === 'arc') expect(Math.cos(arc.startAngle + arc.sweepAngle / 2)).toBeLessThan(0);
  });

  it('removes the span you click when the active work plane is shifted (no inversion)', async () => {
    const { doc, manager } = setup();
    // Draw and trim on a plane whose origin is offset from world — the click
    // arrives in that plane's local frame, so a plain world reading would map it
    // to the far side of the circle and trim the opposite span.
    doc.activeWorkPlane.origin.x = 10;
    const plane = () => ({
      origin: { x: 10, y: 0, z: 0 },
      xAxis: { x: 1, y: 0, z: 0 }, yAxis: { x: 0, y: 1, z: 0 }, zAxis: { x: 0, y: 0, z: 1 },
    });
    const circle = doc.createCircle({ x: 0, y: 0 }, 5); circle.workPlane = plane();
    const cutter = doc.createLine({ x: 3, y: -10 }, { x: 3, y: 10 }); cutter.workPlane = plane();
    doc.entities.push(circle, cutter);
    manager.startCommand('TRIM');
    await manager.handleClick({ x: 3, y: 8 }, cutter);
    await manager.submitInput('');
    await manager.handleClick({ x: 5, y: 0 }, circle); // click the small right span (local coords)
    const arc = doc.entities.find((entity) => entity.type === 'arc');
    expect(arc).toMatchObject({ type: 'arc', radius: 5 });
    // The clicked (right) span is removed, so the kept span's midpoint is on the left.
    if (arc?.type === 'arc') expect(Math.cos(arc.startAngle + arc.sweepAngle / 2)).toBeLessThan(0);
  });

  it('keeps the cutting edges active to trim several objects in one run', async () => {
    const { doc, manager } = setup();
    const cutter = doc.createLine({ x: 5, y: -20 }, { x: 5, y: 20 });
    const a = doc.createLine({ x: 0, y: 0 }, { x: 10, y: 0 });
    const b = doc.createLine({ x: 0, y: 2 }, { x: 10, y: 2 });
    doc.entities.push(cutter, a, b);
    manager.startCommand('TRIM');
    await manager.handleClick({ x: 5, y: 10 }, cutter);
    await manager.submitInput(''); // finish selecting cutting edges
    await manager.handleClick({ x: 8, y: 0 }, a); // trim first line's right end
    await manager.handleClick({ x: 8, y: 2 }, b); // same edge still active — trim second line
    await manager.submitInput(''); // Enter ends the command
    const ta = doc.getEntity(a.id), tb = doc.getEntity(b.id);
    if (ta?.type === 'line') expect(ta.end).toMatchObject({ x: 5, y: 0 });
    if (tb?.type === 'line') expect(tb.end).toMatchObject({ x: 5, y: 2 });
    expect(manager.active).toBeNull();
  });

  it('trims a closed polyline at a circle, dropping the clicked span and opening the loop', async () => {
    const { doc, manager } = setup();
    const circle = doc.createCircle({ x: 0, y: 0 }, 5);
    // An arrowhead: a far-left tip outside the circle, two vertices inside it.
    const arrow = doc.createPolyline([{ x: -20, y: 0 }, { x: 3, y: 3 }, { x: 3, y: -3 }], true);
    doc.entities.push(circle, arrow);
    manager.startCommand('TRIM');
    await manager.handleClick({ x: 2, y: 2 }, circle);
    await manager.submitInput(''); // finish selecting cutting edges
    await manager.handleClick({ x: -15, y: 0 }, arrow); // click the tip, outside the circle
    const trimmed = doc.getEntity(arrow.id);
    expect(trimmed).toMatchObject({ type: 'polyline', closed: false });
    if (trimmed?.type === 'polyline') {
      // The tip is gone; the two inner vertices remain, joined by the two crossings.
      expect(trimmed.vertices).toHaveLength(4);
      expect(trimmed.vertices).toContainEqual({ x: 3, y: 3 });
      expect(trimmed.vertices).toContainEqual({ x: 3, y: -3 });
      expect(trimmed.vertices).not.toContainEqual({ x: -20, y: 0 });
    }
  });

  it('splits an open polyline in two when the trimmed span is in its middle', async () => {
    const { doc, manager } = setup();
    const cutter = doc.createCircle({ x: 10, y: 0 }, 3); // crosses the polyline at x=7 and x=13
    const strip = doc.createPolyline([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 20, y: 0 }], false);
    doc.entities.push(cutter, strip);
    manager.startCommand('TRIM');
    await manager.handleClick({ x: 10, y: 3 }, cutter);
    await manager.submitInput(''); // finish selecting cutting edges
    await manager.handleClick({ x: 10, y: 0 }, strip); // click the middle, between the two crossings
    expect(doc.getEntity(strip.id)).toBeUndefined();
    const halves = doc.entities.filter((entity) => entity.type === 'polyline');
    expect(halves).toHaveLength(2);
    const vertexSets = halves.map((half) => (half as { vertices: { x: number; y: number }[] }).vertices);
    expect(vertexSets).toContainEqual([{ x: 0, y: 0 }, { x: 7, y: 0 }]);
    expect(vertexSets).toContainEqual([{ x: 13, y: 0 }, { x: 20, y: 0 }]);
  });

  it('chamfers the corner between two 2D lines', async () => {
    const { doc, manager } = setup();
    const horizontal = doc.createLine({ x: 0, y: 0 }, { x: 10, y: 0 });
    const vertical = doc.createLine({ x: 0, y: 0 }, { x: 0, y: 10 });
    doc.entities.push(horizontal, vertical);
    manager.startCommand('CHAMFER');
    await manager.handleClick({ x: 5, y: 0 }, horizontal);
    await manager.handleClick({ x: 0, y: 5 }, vertical);
    await manager.submitInput('2, 2');
    // Each line is cut back to its chamfer point, the picked side kept.
    const h = doc.getEntity(horizontal.id), v = doc.getEntity(vertical.id);
    if (h?.type === 'line') expect([h.start, h.end]).toEqual(expect.arrayContaining([{ x: 2, y: 0 }, { x: 10, y: 0 }]));
    if (v?.type === 'line') expect([v.start, v.end]).toEqual(expect.arrayContaining([{ x: 0, y: 2 }, { x: 0, y: 10 }]));
    // A connector line bridges the two chamfer points.
    const connector = doc.entities.find((entity) => entity.type === 'line' && entity.id !== horizontal.id && entity.id !== vertical.id);
    expect(connector).toBeTruthy();
    if (connector?.type === 'line') expect([connector.start, connector.end]).toEqual(expect.arrayContaining([{ x: 2, y: 0 }, { x: 0, y: 2 }]));
  });

  it('chamfers the shared corner of two sides of a closed polyline, keeping it one polyline', async () => {
    const { doc, manager } = setup();
    const square = doc.createPolyline([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }], true);
    doc.entities.push(square);
    manager.startCommand('CHAMFER');
    await manager.handleClick({ x: 5, y: 0 }, square);  // bottom side
    await manager.handleClick({ x: 10, y: 5 }, square); // right side — they meet at (10,0)
    await manager.submitInput('2, 2');
    const result = doc.getEntity(square.id);
    expect(result).toMatchObject({ type: 'polyline', closed: true });
    if (result?.type === 'polyline') {
      // The corner (10,0) is replaced by its two cut points; a closed polyline
      // still repeats its first vertex at the end.
      expect(result.vertices).toEqual([
        { x: 0, y: 0 }, { x: 8, y: 0 }, { x: 10, y: 2 }, { x: 10, y: 10 }, { x: 0, y: 10 }, { x: 0, y: 0 },
      ]);
    }
  });

  it('fillets the shared corner of two sides of a closed polyline into a rounded corner', async () => {
    const { doc, manager } = setup();
    const square = doc.createPolyline([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }], true);
    doc.entities.push(square);
    manager.startCommand('FILLET');
    await manager.handleClick({ x: 5, y: 0 }, square);
    await manager.handleClick({ x: 10, y: 5 }, square);
    await manager.submitInput('2');
    const result = doc.getEntity(square.id);
    expect(result).toMatchObject({ type: 'polyline', closed: true });
    if (result?.type === 'polyline') {
      // The sharp corner is gone, replaced by an arc between the two tangent points.
      expect(result.vertices.length).toBeGreaterThan(5);
      expect(result.vertices.some((v) => Math.hypot(v.x - 8, v.y - 0) < 1e-6)).toBe(true);
      expect(result.vertices.some((v) => Math.hypot(v.x - 10, v.y - 2) < 1e-6)).toBe(true);
      expect(result.vertices.some((v) => Math.hypot(v.x - 10, v.y - 0) < 1e-6)).toBe(false);
      // Every point that is not one of the three surviving corners lies on the
      // fillet arc: radius 2 from its centre (8,2).
      const corners = [{ x: 0, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }];
      for (const v of result.vertices) {
        if (!corners.some((c) => c.x === v.x && c.y === v.y)) expect(Math.hypot(v.x - 8, v.y - 2)).toBeCloseTo(2, 6);
      }
    }
  });

  it('fillets the corner between two 2D lines with a tangent arc', async () => {
    const { doc, manager } = setup();
    const horizontal = doc.createLine({ x: 0, y: 0 }, { x: 10, y: 0 });
    const vertical = doc.createLine({ x: 0, y: 0 }, { x: 0, y: 10 });
    doc.entities.push(horizontal, vertical);
    manager.startCommand('FILLET');
    await manager.handleClick({ x: 5, y: 0 }, horizontal);
    await manager.handleClick({ x: 0, y: 5 }, vertical);
    await manager.submitInput('2');
    // Lines cut back to the tangent points (2,0) and (0,2); the picked far ends stay.
    const h = doc.getEntity(horizontal.id), v = doc.getEntity(vertical.id);
    if (h?.type === 'line') {
      expect(h.start.x).toBeCloseTo(2, 6);
      expect(h.start.y).toBeCloseTo(0, 6);
      expect(h.end).toEqual({ x: 10, y: 0 });
    }
    if (v?.type === 'line') {
      expect(v.start.x).toBeCloseTo(0, 6);
      expect(v.start.y).toBeCloseTo(2, 6);
      expect(v.end).toEqual({ x: 0, y: 10 });
    }
    // The rounding arc is centred at (2,2) with the chosen radius.
    const arc = doc.entities.find((entity) => entity.type === 'arc');
    expect(arc).toMatchObject({ type: 'arc', radius: 2 });
    if (arc?.type === 'arc') {
      expect(arc.center.x).toBeCloseTo(2, 6);
      expect(arc.center.y).toBeCloseTo(2, 6);
    }
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

  it('offsets an arc outward or inward according to the picked side, keeping its angles', async () => {
    const { doc, manager } = setup();
    const arc = doc.createArc({ x: 0, y: 0 }, 10, 0, Math.PI / 2);
    doc.entities.push(arc);
    manager.startCommand('OFFSET');
    await manager.handleClick({ x: 10, y: 0 }, arc);
    await manager.submitInput('2');
    await manager.handleClick({ x: 15, y: 0 });
    expect(doc.entities[1]).toMatchObject({ type: 'arc', center: { x: 0, y: 0 }, radius: 12, startAngle: 0, sweepAngle: Math.PI / 2 });
  });

  /**
   * An ellipse's true offset (a constant distance out along its own normal at
   * every point) is not itself an ellipse — no closed form gives one, unlike a
   * circle — so this samples it into a dense polygon and offsets that. The
   * near-collinear samples the "smoothness" of that polygon depends on are
   * exactly the case the closed-polygon miter join used to explode on, so this
   * doubles as the regression test for that fix on a closed shape.
   */
  it('offsets an ellipse outward and inward as a densely-sampled closed polyline', async () => {
    const { doc, manager } = setup();
    const ellipse = doc.createEllipse({ x: 0, y: 0 }, 50, 20);
    doc.entities.push(ellipse);
    manager.startCommand('OFFSET');
    await manager.handleClick({ x: 50, y: 0 }, ellipse);
    await manager.submitInput('1');
    await manager.handleClick({ x: 60, y: 0 }); // clearly outside
    const outward = doc.entities[1];
    expect(outward).toMatchObject({ type: 'polyline', closed: true });
    if (outward.type === 'polyline') {
      // The rightmost and topmost sampled points sit where the ellipse's own
      // normal runs along an axis, so the true offset there is exactly +1 mm
      // along that axis — the closest thing to an exact check this shape has.
      const rightmost = outward.vertices.reduce((a, b) => (a.x > b.x ? a : b));
      const topmost = outward.vertices.reduce((a, b) => (a.y > b.y ? a : b));
      expect(rightmost.x).toBeCloseTo(51, 0);
      expect(topmost.y).toBeCloseTo(21, 0);
      // Every sample stayed close to the source ellipse, not flung out by a
      // degenerate miter — the near-collinear samples are exactly that case.
      const sourcePoints = ellipsePoints(ellipse, 96);
      for (const vertex of outward.vertices) {
        const nearest = Math.min(...sourcePoints.map((p) => Math.hypot(p.x - vertex.x, p.y - vertex.y)));
        expect(nearest).toBeLessThan(3);
      }
    }

    doc.clearSelection();
    manager.startCommand('OFFSET');
    await manager.handleClick({ x: 50, y: 0 }, ellipse);
    await manager.submitInput('1');
    await manager.handleClick({ x: 40, y: 0 }); // clearly inside
    const inward = doc.entities[2];
    if (inward.type === 'polyline') {
      const rightmost = inward.vertices.reduce((a, b) => (a.x > b.x ? a : b));
      expect(rightmost.x).toBeCloseTo(49, 0);
    }
  });

  it('offsets an open polyline to one side along its whole length', async () => {
    const { doc, manager } = setup();
    const polyline = doc.createPolyline([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }], false);
    doc.entities.push(polyline);
    manager.startCommand('OFFSET');
    await manager.handleClick({ x: 5, y: 0 }, polyline);
    await manager.submitInput('1');
    // Picked above the horizontal leg: the whole chain shifts to that side,
    // including the vertical leg where it was never clicked.
    await manager.handleClick({ x: 5, y: 5 });
    expect(doc.entities[1]).toMatchObject({ type: 'polyline', closed: false });
    const result = doc.entities[1];
    if (result.type === 'polyline') {
      expect(result.vertices[0]).toMatchObject({ x: 0, y: 1 });
      expect(result.vertices[1]).toMatchObject({ x: 9, y: 1 });
      expect(result.vertices[2]).toMatchObject({ x: 9, y: 10 });
    }
  });

  /**
   * The bug: a JOINed Bezier pair (or any curve flattened into many closely-
   * spaced, barely-turning segments) offset into a chain with spikes flying
   * off far from the source curve, which read as "OFFSET does not work" on
   * anything but a simple, sharp-cornered shape. A true miter join extends
   * each edge to its exact intersection with the next — fine for two clearly
   * angled segments, but for two *almost* parallel ones (a smoothly sampled
   * curve) that intersection can land many times farther out than the offset
   * distance itself.
   */
  it('offsets a densely-sampled curve without its miter joints blowing up', async () => {
    const { doc, manager } = setup();
    const radius = 50;
    const vertices = Array.from({ length: 49 }, (_, i) => {
      const angle = (i / 48) * (Math.PI / 2);
      return { x: radius * Math.cos(angle), y: radius * Math.sin(angle) };
    });
    const polyline = doc.createPolyline(vertices, false);
    doc.entities.push(polyline);
    manager.startCommand('OFFSET');
    await manager.handleClick({ x: 0, y: 0 }, polyline);
    await manager.submitInput('1');
    await manager.handleClick({ x: (radius + 5) * Math.cos(Math.PI / 4), y: (radius + 5) * Math.sin(Math.PI / 4) });
    expect(doc.entities).toHaveLength(2);
    const result = doc.entities[1];
    expect(result).toMatchObject({ type: 'polyline', closed: false });
    if (result.type === 'polyline') {
      expect(result.vertices).toHaveLength(vertices.length);
      for (let i = 0; i < result.vertices.length; i++) {
        const distance = Math.hypot(result.vertices[i].x - vertices[i].x, result.vertices[i].y - vertices[i].y);
        expect(distance).toBeLessThan(2); // stays near the 1 mm offset, never a runaway miter spike
      }
    }
  });

  it('reduces a straight run of collinear points down to its two ends', async () => {
    const { doc, manager } = setup();
    const vertices = Array.from({ length: 20 }, (_, i) => ({ x: i * 0.5, y: 0 }));
    const polyline = doc.createPolyline(vertices, false);
    doc.entities.push(polyline);
    manager.startCommand('SIMPLIFY');
    await manager.handleClick({ x: 0, y: 0 }, polyline);
    await manager.submitInput('0.01');
    const result = doc.entities[0];
    expect(result.type === 'polyline' && result.vertices).toEqual([{ x: 0, y: 0 }, { x: 9.5, y: 0 }]);
  });

  it('keeps a real corner regardless of how fine the tolerance is set', async () => {
    const { doc, manager } = setup();
    // A right angle, with extra collinear points along each leg that carry no
    // shape of their own — those should go, but not the corner between them.
    const vertices = [
      { x: 0, y: 0 }, { x: 2, y: 0 }, { x: 4, y: 0 }, { x: 6, y: 0 },
      { x: 6, y: 2 }, { x: 6, y: 4 }, { x: 6, y: 6 },
    ];
    const polyline = doc.createPolyline(vertices, false);
    doc.entities.push(polyline);
    manager.startCommand('SIMPLIFY');
    await manager.handleClick({ x: 0, y: 0 }, polyline);
    await manager.submitInput('0.01');
    const result = doc.entities[0];
    expect(result.type === 'polyline' && result.vertices).toEqual([{ x: 0, y: 0 }, { x: 6, y: 0 }, { x: 6, y: 6 }]);
  });

  it('collapses a densely-sampled curve to a handful of points, keeping its ends fixed', async () => {
    const { doc, manager } = setup();
    const radius = 50;
    const vertices = Array.from({ length: 49 }, (_, i) => {
      const angle = (i / 48) * (Math.PI / 2);
      return { x: radius * Math.cos(angle), y: radius * Math.sin(angle) };
    });
    const polyline = doc.createPolyline(vertices, false);
    doc.entities.push(polyline);
    manager.startCommand('SIMPLIFY');
    await manager.handleClick({ x: 0, y: 0 }, polyline);
    await manager.submitInput('0.1');
    const result = doc.entities[0];
    expect(result.type === 'polyline' && result.vertices.length).toBeLessThan(20);
    expect(result.type === 'polyline' && result.vertices[0]).toMatchObject(vertices[0]);
    expect(result.type === 'polyline' && result.vertices.at(-1)).toMatchObject(vertices.at(-1)!);
  });

  it('keeps a simplified closed polyline closed', async () => {
    const { doc, manager } = setup();
    // A square with an extra, shape-free point along each side.
    const vertices = [
      { x: 0, y: 0 }, { x: 5, y: 0 }, { x: 10, y: 0 },
      { x: 10, y: 5 }, { x: 10, y: 10 },
      { x: 5, y: 10 }, { x: 0, y: 10 },
      { x: 0, y: 5 },
    ];
    const polyline = doc.createPolyline(vertices, true);
    doc.entities.push(polyline);
    manager.startCommand('SIMPLIFY');
    await manager.handleClick({ x: 0, y: 0 }, polyline);
    await manager.submitInput('0.01');
    const result = doc.entities[0];
    if (result.type === 'polyline') {
      expect(result.closed).toBe(true);
      expect(result.vertices[0]).toEqual(result.vertices.at(-1));
      expect(result.vertices).toEqual([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }, { x: 0, y: 0 }]);
    }
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

  it('keeps LINE and CIRCLE on the parallel plane established by an off-UCS endpoint snap', async () => {
    const { doc, manager } = setup();
    const plane = { ...cloneWorkPlane(WORLD_WORK_PLANE), origin: { x: 0, y: 0, z: 8 } };

    manager.startCommand('LINE');
    manager.active!.data.drawingPlane = plane;
    await manager.handleClick({ x: 2, y: 3 });
    await manager.handleClick({ x: 6, y: 3 });
    manager.cancelActive();

    manager.startCommand('CIRCLE');
    manager.active!.data.drawingPlane = plane;
    await manager.handleClick({ x: 2, y: 3 });
    await manager.handleClick({ x: 4, y: 3 });

    const line = doc.entities.find((entity) => entity.type === 'line')!;
    const circle = doc.entities.find((entity) => entity.type === 'circle')!;
    expect(localToWorld(line.workPlane!, line.start)).toEqual({ x: 2, y: 3, z: 8 });
    expect(localToWorld(circle.workPlane!, circle.center)).toEqual({ x: 2, y: 3, z: 8 });
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
    expect(manager.currentPrompt()).toBe('Specify extrusion height or [Direction/Path/Taper angle]:');
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

  it('moves a selection by a typed @distance<angle vector after the base point', async () => {
    const { doc, manager, moveObjects } = setup();
    const line = doc.createLine({ x: 0, y: 0 }, { x: 1, y: 0 });
    doc.addEntity(line);
    manager.startCommand('MOVE');
    await manager.handleClick({ x: 0, y: 0 }, line);
    await manager.submitInput('');
    await manager.handleClick({ x: 2, y: 3 }); // base point
    await manager.submitInput('@10<90'); // target as a polar vector in the active plane
    const [objects, delta, worldDelta] = moveObjects.mock.calls.at(-1)!;
    expect(objects).toEqual([line]);
    expect(delta.x).toBeCloseTo(0, 6);
    expect(delta.y).toBeCloseTo(10, 6);
    expect(worldDelta).toBeUndefined();
  });

  it('adds a cosmetic M-thread from a picked circle, guessing the size from its diameter', async () => {
    const { doc, manager } = setup();
    const hole = doc.createCircle({ x: 0, y: 0 }, 1.65); // ⌀3.30 ≈ the M4 tapping drill
    doc.addEntity(hole);
    manager.startCommand('THREAD');
    await manager.handleClick({ x: 0, y: 0 }, hole);
    await manager.submitInput(''); // internal (default)
    await manager.submitInput(''); // accept the suggested size
    // Original circle + major ring + minor ring + label.
    expect(doc.entities).toHaveLength(4);
    const radii = doc.entities.filter((entity) => entity.type === 'circle')
      .map((entity) => entity.type === 'circle' ? entity.radius : 0);
    expect(radii).toContain(2); // M4 major diameter is 4 mm
    expect(doc.entities.some((entity) => entity.type === 'text' && entity.text === 'M4')).toBe(true);
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
    expect(doc.solids[0].exact?.revision).toBe(doc.solids[0].revision);
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

  it('scales a preselected entity from a unit reference length', async () => {
    const { doc, manager, history } = setup();
    const circle = doc.createCircle({ x: 3, y: 2 }, 2);
    doc.addEntity(circle);
    doc.selectEntity(circle.id);
    manager.startCommand('SCALE');
    expect(manager.active).toMatchObject({ name: 'SCALE', stepIndex: 1 });

    await manager.handleClick({ x: 1, y: 2 });
    await manager.handleClick({ x: 2, y: 2 }); // unit reference from base
    await manager.handleClick({ x: 3, y: 2 }); // new length 2

    expect(doc.entities[0]).toMatchObject({ type: 'circle', center: { x: 5, y: 2 }, radius: 4 });
    history.undo();
    expect(doc.entities[0]).toMatchObject({ type: 'circle', center: { x: 3, y: 2 }, radius: 2 });
  });

  it('shrinks by a reference length picked on the drawing (new ÷ reference)', async () => {
    const { doc, manager, history } = setup();
    const circle = doc.createCircle({ x: 4, y: 0 }, 2);
    doc.addEntity(circle);
    doc.selectEntity(circle.id);
    manager.startCommand('SCALE');

    await manager.handleClick({ x: 0, y: 0 }); // base
    await manager.handleClick({ x: 4, y: 0 }); // reference length from base = 4
    await manager.handleClick({ x: 2, y: 0 }); // new length 2 → factor 2/4 = 0.5 (shrinks)

    expect(doc.entities[0]).toMatchObject({ type: 'circle', center: { x: 2, y: 0 }, radius: 1 });
    history.undo();
    expect(doc.entities[0]).toMatchObject({ type: 'circle', center: { x: 4, y: 0 }, radius: 2 });
  });

  it('scales by a typed reference and new length', async () => {
    const { doc, manager } = setup();
    const circle = doc.createCircle({ x: 4, y: 0 }, 2);
    doc.addEntity(circle);
    doc.selectEntity(circle.id);
    manager.startCommand('SCALE');

    await manager.handleClick({ x: 0, y: 0 }); // base
    await manager.submitInput('4');            // reference length = 4
    await manager.submitInput('6');            // new length 6 → factor 1.5

    expect(doc.entities[0]).toMatchObject({ type: 'circle', center: { x: 6, y: 0 }, radius: 3 });
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

  it('explodes single-stroke text into the line segments a pen would draw', async () => {
    const { doc, manager, history } = setup();
    const text = doc.createText({ x: 0, y: 0 }, 'HI', 10, 'Single-stroke');
    doc.addEntity(text);
    doc.selectEntity(text.id);
    manager.startCommand('EXPLODE');
    await manager.submitInput('');

    expect(doc.entities.length).toBeGreaterThan(2); // several strokes for two letters
    expect(doc.entities.every((entity) => entity.type === 'line')).toBe(true);
    expect(doc.getSelectedEntities().length).toBe(doc.entities.length);
    history.undo();
    expect(doc.entities).toHaveLength(1);
    expect(doc.entities[0]).toMatchObject({ type: 'text', text: 'HI' });
  });

  it('refuses to explode text in an outline font, since it has no strokes to give', async () => {
    const { doc, manager, log } = setup();
    const text = doc.createText({ x: 0, y: 0 }, 'HI', 10, 'Arial');
    doc.addEntity(text);
    doc.selectEntity(text.id);
    manager.startCommand('EXPLODE');
    await manager.submitInput('');

    expect(doc.entities).toHaveLength(1);
    expect(doc.entities[0].type).toBe('text');
    expect(log).toHaveBeenCalledWith(expect.stringContaining('outline font'));
  });

  it('creates one native hatch and materialises its strokes only on EXPLODE', async () => {
    const { doc, manager } = setup();
    doc.hatch = { pattern: 'lines', angle: 0, spacing: 2 };
    const rectangle = doc.createRectangle({ x: 0, y: 0 }, { x: 10, y: 10 });
    doc.addEntity(rectangle);
    doc.selectEntity(rectangle.id);
    manager.startCommand('HATCH');
    await manager.submitInput('');

    const hatch = doc.entities.find((entity) => entity.type === 'hatch');
    expect(hatch).toMatchObject({ type: 'hatch', angle: 0, spacing: 2 });
    expect(doc.entities.filter((entity) => entity.type === 'line')).toHaveLength(0);

    doc.clearSelection();
    doc.selectEntity(hatch!.id);
    manager.startCommand('EXPLODE');
    await manager.submitInput('');
    expect(doc.entities.some((entity) => entity.type === 'hatch')).toBe(false);
    expect(doc.entities.filter((entity) => entity.type === 'line').length).toBeGreaterThanOrEqual(4);
  });

  it('explodes one INSERT into its transformed drawing entities', async () => {
    const { doc, manager, history } = setup();
    const definition = {
      name: 'Part', basePoint: { x: 0, y: 0 },
      entities: [doc.createLine({ x: 0, y: 0 }, { x: 5, y: 0 }), doc.createCircle({ x: 2, y: 2 }, 1)],
    };
    const insert = doc.createInsert(definition, { x: 10, y: 20 });
    insert.rotation = Math.PI / 2;
    doc.addEntity(insert);
    doc.selectEntity(insert.id);

    manager.startCommand('EXPLODE');
    await manager.submitInput('');

    expect(doc.entities.map((entity) => entity.type)).toEqual(['line', 'circle']);
    expect(doc.entities[0]).toMatchObject({ start: { x: 10, y: 20 }, end: { x: 10, y: 25 } });
    history.undo();
    expect(doc.entities).toHaveLength(1);
    expect(doc.entities[0].type).toBe('insert');
  });

  it('creates one named block from preselected entities and undoes it as one edit', async () => {
    const { doc, manager, history } = setup();
    const first = doc.createLine({ x: 2, y: 3 }, { x: 12, y: 3 });
    const second = doc.createCircle({ x: 7, y: 8 }, 2);
    doc.addEntity(first);
    doc.addEntity(second);
    doc.selectEntity(first.id);
    doc.selectEntity(second.id, true);

    manager.startCommand('BLOCK');
    expect(manager.active).toMatchObject({ name: 'BLOCK', stepIndex: 1 });
    await manager.submitInput('Bracket');
    await manager.handleClick({ x: 2, y: 3 });

    expect(doc.blockDefinitions).toHaveLength(1);
    expect(doc.blockDefinitions[0]).toMatchObject({ name: 'Bracket', basePoint: { x: 2, y: 3 } });
    expect(doc.blockDefinitions[0].entities).toHaveLength(2);
    expect(doc.entities).toHaveLength(1);
    expect(doc.entities[0]).toMatchObject({ type: 'insert', blockName: 'Bracket', position: { x: 2, y: 3 } });
    expect(doc.getSelectedEntities()).toHaveLength(1);

    history.undo();
    expect(doc.blockDefinitions).toEqual([]);
    expect(doc.entities.map((entity) => entity.type).sort()).toEqual(['circle', 'line']);
    history.redo();
    expect(doc.blockDefinitions[0].name).toBe('Bracket');
    expect(doc.entities[0].type).toBe('insert');
  });

  it('creates, transforms and explodes a native block containing a 3D solid', async () => {
    const { doc, manager, history } = setup();
    const solid = doc.createSolid(createBoxMesh(4, 6, 8), 'Box', 8, []);
    doc.addSolid(solid);
    doc.selectSolid(solid.id);

    manager.startCommand('BLOCK');
    expect(manager.active).toMatchObject({ name: 'BLOCK', stepIndex: 1 });
    await manager.submitInput('SolidPart');
    await manager.handleClick({ x: 0, y: 0, z: 0 } as { x: number; y: number });

    expect(doc.solids).toHaveLength(0);
    expect(doc.entities).toHaveLength(1);
    expect(doc.blockDefinitions[0].solids).toHaveLength(1);
    const insert = doc.entities[0];
    if (insert.type !== 'insert') throw new Error('expected INSERT');
    insert.position = { x: 10, y: 20, z: 5 } as { x: number; y: number };
    insert.scaleX = 2;
    insert.scaleY = 3;
    insert.scaleZ = 4;
    const expanded = expandedInsertSolids(insert)[0];
    expect(Array.from(expanded.mesh.positions)).toEqual(expect.arrayContaining([6, 11, 5, 14, 29, 37]));

    doc.clearSelection();
    doc.selectEntity(insert.id);
    manager.startCommand('EXPLODE');
    await manager.submitInput('');

    expect(doc.entities).toHaveLength(0);
    expect(doc.solids).toHaveLength(1);
    expect(doc.solids[0].mesh.positions).toBeInstanceOf(Float32Array);
    history.undo();
    expect(doc.entities[0].type).toBe('insert');
  });

  it('explodes a 3D solid into one closed polyline per planar face, AutoCAD-style', async () => {
    const { doc, manager, history } = setup();
    const solid = doc.createSolid(createBoxMesh(4, 6, 8), 'Box', 8, []);
    doc.addSolid(solid);
    doc.selectSolid(solid.id);

    manager.startCommand('EXPLODE');
    await manager.submitInput('');

    // A box has six planar faces, so it comes apart into six closed polylines.
    expect(doc.solids).toHaveLength(0);
    expect(doc.entities).toHaveLength(6);
    expect(doc.entities.every((entity) => entity.type === 'polyline' && entity.closed)).toBe(true);
    history.undo();
    expect(doc.solids).toHaveLength(1);
    expect(doc.entities).toHaveLength(0);
  });

  it('inserts a saved block with default scale and entered rotation', async () => {
    const { doc, manager, history } = setup();
    const definition = {
      name: 'Hole', basePoint: { x: 5, y: 5 },
      entities: [doc.createCircle({ x: 5, y: 5 }, 2)],
    };
    doc.blockDefinitions = [definition];

    manager.startCommand('INSERT');
    await manager.submitInput('hole');
    expect(manager.active).toMatchObject({ name: 'INSERT', stepIndex: 1 });
    await manager.handleClick({ x: 20, y: 30 });
    await manager.submitInput('');
    await manager.submitInput('90');

    expect(doc.entities).toHaveLength(1);
    expect(doc.entities[0]).toMatchObject({
      type: 'insert', blockName: 'Hole', position: { x: 20, y: 30 }, scaleX: 1, scaleY: 1,
    });
    expect(doc.entities[0].type === 'insert' && doc.entities[0].rotation).toBeCloseTo(Math.PI / 2);
    history.undo();
    expect(doc.entities).toEqual([]);
  });

  // A command that waits on the solid engine leaves the wizard open for a few
  // milliseconds. Anything arriving in that window used to be answered a second
  // time: EXPLODE runs itself when a preselection answers everything, so an
  // Enter landing while it was still working exploded the rectangle twice and
  // left eight lines where four belonged.
  it('ignores input that lands while a step is still being carried out', async () => {
    const { doc, manager } = setup();
    const rectangle = doc.createRectangle({ x: 0, y: 0 }, { x: 8, y: 3 });
    doc.addEntity(rectangle);
    doc.selectEntity(rectangle.id);

    manager.startCommand('EXPLODE'); // starts exploding, and does not wait
    await manager.submitInput('');   // Enter, mid-flight
    await manager.submitInput('');

    expect(doc.entities).toHaveLength(4);
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
    await manager.submitInput(''); // Enter: leave the text centred
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

  it('creates an angular dimension from a vertex and two ray points', async () => {
    const { doc, manager } = setup();
    manager.startCommand('DIMANGULAR');
    await manager.submitInput('');
    expect(manager.active).toMatchObject({ name: 'DIMANGULAR', stepIndex: 2 });
    await manager.handleClick({ x: 0, y: 0 });
    await manager.handleClick({ x: 10, y: 0 });
    await manager.handleClick({ x: 0, y: 10 });
    await manager.handleClick({ x: 4, y: 4 });
    await manager.submitInput('');

    const dimension = doc.entities[0];
    expect(dimension).toMatchObject({
      type: 'dimension',
      dimensionKind: 'angular',
      start: { x: 0, y: 0 },
      end: { x: 10, y: 0 },
      offset: { x: 0, y: 10 },
      arcPoint: { x: 4, y: 4 },
    });
    if (dimension.type === 'dimension') expect(dimensionGeometry(dimension).text).toBe('90.0°');
    expect(manager.active).toMatchObject({ name: 'DIMANGULAR', stepIndex: 0 });
  });

  it('creates an angular dimension from two selected lines', async () => {
    const { doc, manager } = setup();
    const horizontal = doc.createLine({ x: 0, y: 0 }, { x: 10, y: 0 });
    const vertical = doc.createLine({ x: 0, y: 0 }, { x: 0, y: 10 });
    doc.addEntity(horizontal); doc.addEntity(vertical);

    manager.startCommand('DIMANGULAR');
    await manager.handleClick({ x: 5, y: 0 }, horizontal);
    await manager.handleClick({ x: 0, y: 5 }, vertical);
    expect(manager.active).toMatchObject({ name: 'DIMANGULAR', stepIndex: 5 });
    await manager.handleClick({ x: 3, y: 3 });
    await manager.submitInput('');

    const dimension = doc.entities.at(-1)!;
    expect(dimension).toMatchObject({ type: 'dimension', dimensionKind: 'angular' });
    if (dimension.type === 'dimension') expect(dimensionGeometry(dimension).text).toBe('90.0°');
  });

  it('builds a plane for angular dimensions between spatial solid edges', async () => {
    const { doc, manager } = setup();
    doc.viewMode = '3d';
    const edgeX = {
      solidId: 'solid', start: { x: 0, y: 2, z: 0 }, end: { x: 10, y: 2, z: 0 },
      normalA: { x: 0, y: 1, z: 0 }, normalB: { x: 0, y: 0, z: 1 },
    };
    const edgeZ = {
      solidId: 'solid', start: { x: 0, y: 2, z: 0 }, end: { x: 0, y: 2, z: 10 },
      normalA: { x: 0, y: 1, z: 0 }, normalB: { x: 1, y: 0, z: 0 },
    };

    manager.startCommand('DIMANGULAR');
    await manager.handleClick({ x: 5, y: 2, z: 0 }, undefined, undefined, undefined, edgeX);
    await manager.handleClick({ x: 0, y: 2, z: 5 }, undefined, undefined, undefined, edgeZ);
    await manager.handleClick({ x: 3, y: 3 });
    await manager.submitInput('');

    const dimension = doc.entities[0];
    if (dimension.type !== 'dimension') throw new Error('expected angular dimension');
    expect(dimensionGeometry(dimension).text).toBe('90.0°');
    expect(localToWorld(dimension.workPlane!, dimension.start)).toMatchObject({ x: 0, y: 2, z: 0 });
  });

  it('creates radius and diameter dimensions from a circular 3D solid edge', async () => {
    const { doc, manager } = setup();
    const mesh = createCylinderMesh(3, 10);
    const solid = doc.createSolid(mesh, 'Cylinder', 10, []);
    doc.addSolid(solid);
    const circle = solidCircularEdges(mesh).find((candidate) => Math.abs(candidate.center.z - 10) < 1e-5)!;
    const edge = {
      solidId: solid.id,
      start: circle.points[0],
      end: circle.points[1],
      normalA: circle.normal,
      normalB: circle.normal,
      circular: { center: circle.center, normal: circle.normal, radius: circle.radius },
    };

    manager.startCommand('DIMRADIUS');
    await manager.handleClick({ x: 0, y: 0 }, undefined, undefined, undefined, edge);
    expect(manager.active).toMatchObject({ name: 'DIMRADIUS', stepIndex: 1 });
    await manager.handleClick({ x: 7, y: 2 });
    const radius = doc.entities.at(-1)!;
    if (radius.type !== 'dimension') throw new Error('expected radius dimension');
    expect(dimensionGeometry(radius).text).toBe('R3.00');
    expect(localToWorld(radius.workPlane!, radius.start)).toMatchObject({ x: 0, y: 0, z: 10 });

    manager.startCommand('DIMDIAMETER');
    await manager.handleClick({ x: 0, y: 0 }, undefined, undefined, undefined, edge);
    await manager.handleClick({ x: -6, y: 4 });
    const diameter = doc.entities.at(-1)!;
    if (diameter.type !== 'dimension') throw new Error('expected diameter dimension');
    expect(dimensionGeometry(diameter).text).toBe('Ø6.00');
    expect(diameter.workPlane).toEqual(radius.workPlane);
  });

  it('saves every completed UCS as an active named coordinate system', async () => {
    const { doc, manager, log } = setup();
    const workPlaneChanged = vi.fn();
    manager.updateContext({ workPlaneChanged });

    manager.startCommand('UCS');
    await manager.handleClick({ x: 10, y: 20, z: 30 });
    await manager.handleClick({ x: 11, y: 20, z: 30 });
    await manager.handleClick({ x: 10, y: 20, z: 31 });

    expect(doc.namedWorkPlanes).toHaveLength(1);
    expect(doc.namedWorkPlanes[0]).toMatchObject({
      name: 'UCS 1',
      workPlane: { origin: { x: 10, y: 20, z: 30 }, zAxis: { x: 0, y: -1, z: 0 } },
    });
    expect(doc.activeNamedWorkPlaneId).toBe(doc.namedWorkPlanes[0].id);
    expect(doc.activeWorkPlane).toEqual(doc.namedWorkPlanes[0].workPlane);
    expect(doc.activeWorkPlane).not.toBe(doc.namedWorkPlanes[0].workPlane);
    expect(workPlaneChanged).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('UCS 1 saved'));
  });

  it('creates parametric box and cylinder primitives with undo support', async () => {
    const { doc, history, manager } = setup();
    manager.startCommand('BOX');
    await manager.handleClick({ x: 0, y: 0 });
    await manager.handleClick({ x: 10, y: 6 });
    expect(doc.viewMode).toBe('3d');
    expect(manager.active).toMatchObject({ name: 'BOX', stepIndex: 2, data: { framePrimitiveBase: true } });
    await manager.submitInput('4');
    expect(doc.solids[0]).toMatchObject({ name: 'Box', feature: { kind: 'primitive', primitive: 'box', width: 10, depth: 6, height: 4 } });
    expect(doc.solids[0].exact).toMatchObject({
      kernel: 'opencascade',
      revision: 0,
      shape: { format: 'occt-brep-v1' },
    });
    expect(doc.solids[0].mesh.triangleFaceIds).toHaveLength(doc.solids[0].mesh.indices.length / 3);
    history.undo(); expect(doc.solids).toHaveLength(0);
    history.redo(); expect(doc.solids).toHaveLength(1);
    expect(doc.solids[0].exact?.shape.data).toContain('CASCADE Topology V3');

    manager.startCommand('CYLINDER');
    await manager.handleClick({ x: 20, y: 0 });
    await manager.submitInput('3');
    await manager.submitInput('8');
    expect(doc.solids.at(-1)).toMatchObject({ name: 'Cylinder', feature: { kind: 'primitive', primitive: 'cylinder', radius: 3, height: 8 } });
    expect(doc.solids.at(-1)?.exact?.revision).toBe(doc.solids.at(-1)?.revision);
  });

  it('uses one normalized BOX/WEDGE feature for live preview and placement', () => {
    const plane = {
      origin: { x: 2, y: 3, z: 4 },
      xAxis: { x: 0, y: 1, z: 0 },
      yAxis: { x: 0, y: 0, z: 1 },
      zAxis: { x: 1, y: 0, z: 0 },
    };
    const feature = boxLikePrimitiveFeature('wedge', { x: 5, y: 8 }, { x: -3, y: 2 }, -7, plane);

    expect(feature).toMatchObject({
      primitive: 'wedge',
      center: { x: 1, y: 5 },
      width: 8,
      depth: 6,
      height: 7,
      workPlane: plane,
    });
    expect(feature?.workPlane).not.toBe(plane);
    expect(boxLikePrimitiveFeature('box', { x: 1, y: 1 }, { x: 1, y: 4 }, 3, WORLD_WORK_PLANE)).toBeNull();
  });

  it('uses normalized radial features for the same live preview and placement path', () => {
    const plane = {
      origin: { x: 2, y: 3, z: 4 },
      xAxis: { x: 0, y: 1, z: 0 },
      yAxis: { x: 0, y: 0, z: 1 },
      zAxis: { x: 1, y: 0, z: 0 },
    };
    const cylinder = radialLikePrimitiveFeature(
      'cylinder',
      { x: 5, y: 8 },
      { x: 8, y: 12 },
      -7,
      plane,
    );
    const torus = torusPrimitiveFeature(
      { x: 5, y: 8 },
      { x: 8, y: 12 },
      -2,
      plane,
    );

    expect(cylinder).toMatchObject({
      primitive: 'cylinder',
      center: { x: 5, y: 8 },
      radius: 5,
      height: 7,
      workPlane: plane,
    });
    expect(torus).toMatchObject({
      primitive: 'torus',
      center: { x: 5, y: 8 },
      radius: 5,
      tubeRadius: 2,
      height: 4,
      workPlane: plane,
    });
    expect(cylinder?.workPlane).not.toBe(plane);
    expect(torus?.workPlane).not.toBe(plane);
    expect(torusPrimitiveFeature({ x: 0, y: 0 }, { x: 5, y: 0 }, 5, plane)).toBeNull();
  });

  it('switches every primitive with a final 3D drag after its base is placed', async () => {
    for (const name of ['BOX', 'WEDGE', 'CYLINDER', 'CONE', 'PYRAMID', 'TORUS'] as const) {
      const { doc, manager } = setup();
      doc.viewMode = '2d';
      manager.startCommand(name);
      await manager.handleClick({ x: 0, y: 0 });
      await manager.handleClick(name === 'BOX' || name === 'WEDGE' ? { x: 6, y: 4 } : { x: 5, y: 0 });

      expect(doc.viewMode, name).toBe('3d');
      expect(manager.active, name).toMatchObject({
        name,
        stepIndex: 2,
        data: { framePrimitiveBase: true },
      });
      expect(doc.solids, name).toHaveLength(0);

      await manager.submitInput('2');
      expect(doc.solids, name).toHaveLength(1);
      expect(doc.solids[0].exact?.revision, name).toBe(doc.solids[0].revision);
    }
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
    expect(doc.solids.every((solid) => solid.exact?.revision === solid.revision)).toBe(true);
  });

  it('selects a solid, slices it with three plane points and undoes both halves together', async () => {
    const { doc, history, manager } = setup();
    const source = doc.createSolid(createBoxMesh(10, 6, 4), 'Block', 4, [], undefined, {
      kind: 'primitive', primitive: 'box', center: { x: 0, y: 0 }, width: 10, depth: 6, height: 4,
    });
    doc.addSolid(source);

    manager.startCommand('SLICE');
    expect(manager.active).toMatchObject({ name: 'SLICE', stepIndex: 0 });
    await manager.handleClick({ x: 0, y: 0 }, undefined, source.id);
    await manager.submitInput('');
    expect(manager.active).toMatchObject({ name: 'SLICE', stepIndex: 1 });
    await manager.handleClick({ x: 0, y: -3, z: 0 });
    await manager.handleClick({ x: 0, y: 3, z: 0 });
    await manager.handleClick({ x: 0, y: 0, z: 4 });

    expect(manager.active).toBeNull();
    expect(doc.solids).toHaveLength(2);
    expect(doc.solids.every((solid) => solid.feature.kind === 'mesh')).toBe(true);
    expect(doc.solids.map((solid) => solid.name)).toEqual(['Block_Slice1', 'Block_Slice2']);
    expect(doc.getSelectedSolids()).toHaveLength(2);

    expect(history.undo()).toBe(true);
    expect(doc.solids).toHaveLength(1);
    expect(doc.solids[0].id).toBe(source.id);
    expect(history.redo()).toBe(true);
    expect(doc.solids).toHaveLength(2);
  });

  it('keeps exact B-rep geometry through BOX, oblique SLICE and UNION', async () => {
    const { doc, manager } = setup();
    manager.startCommand('BOX');
    await manager.handleClick({ x: 0, y: 0 });
    await manager.handleClick({ x: 20, y: 30 });
    await manager.submitInput('40');
    const source = doc.solids[0];
    expect(source.exact?.revision).toBe(source.revision);

    manager.startCommand('SLICE');
    await manager.handleClick({ x: 0, y: 0 }, undefined, source.id);
    await manager.submitInput('');
    await manager.handleClick({ x: 10, y: 15, z: 20 });
    await manager.handleClick({ x: 11, y: 14, z: 20 });
    await manager.handleClick({ x: 11, y: 15, z: 18 });

    expect(doc.solids).toHaveLength(2);
    expect(doc.solids.every((solid) => solid.exact?.revision === solid.revision)).toBe(true);
    const [first, second] = doc.solids;

    manager.startCommand('UNION');
    await manager.handleClick({ x: 0, y: 0 }, undefined, first.id);
    await manager.handleClick({ x: 0, y: 0 }, undefined, second.id);

    expect(doc.solids).toHaveLength(1);
    const reunited = doc.solids[0];
    expect(reunited.exact).toMatchObject({ kernel: 'opencascade', revision: reunited.revision });
    expect(solidPlanarFaces(reunited.mesh)).toHaveLength(6);
    expect(solidDesignEdges(reunited.mesh)).toHaveLength(12);
  });

  it('uses an existing planar face as the SLICE plane', async () => {
    const { doc, manager } = setup();
    const source = doc.createSolid(createBoxMesh(10, 6, 4), 'Source', 4, []);
    // Its left face lies at x=0 and therefore cuts the source through its middle.
    const reference = doc.createSolid(createBoxMesh(2, 8, 6, 1, 0), 'Reference', 6, []);
    doc.addSolid(source);
    doc.addSolid(reference);
    doc.selectSolid(source.id);
    manager.startCommand('SLICE');

    await manager.handleClick(
      { x: 0, y: 0, z: 0 },
      undefined,
      reference.id,
      { solidId: reference.id, vertexIndices: [0, 3, 4, 7], normal: { x: 1, y: 0, z: 0 } },
    );

    expect(manager.active).toBeNull();
    expect(doc.solids).toHaveLength(3);
    expect(doc.getSolid(reference.id)).toBe(reference);
    expect(doc.getSolid(source.id)).toBeUndefined();
    expect(doc.solids.filter((solid) => solid.name.startsWith('Source_Slice'))).toHaveLength(2);
  });

  it('slices every selected solid crossed by the plane and leaves missed solids untouched', async () => {
    const { doc, history, manager } = setup();
    const crossed = doc.createSolid(createBoxMesh(10, 6, 4), 'Crossed', 4, []);
    const missed = doc.createSolid(createBoxMesh(4, 4, 4, 20, 0), 'Missed', 4, []);
    doc.addSolid(crossed);
    doc.addSolid(missed);
    doc.selectSolid(crossed.id, true);
    doc.selectSolid(missed.id, true);
    manager.startCommand('SLICE');

    await manager.handleClick({ x: 0, y: -3, z: 0 });
    await manager.handleClick({ x: 0, y: 3, z: 0 });
    await manager.handleClick({ x: 0, y: 0, z: 4 });

    expect(doc.solids).toHaveLength(3);
    expect(doc.getSolid(missed.id)).toBe(missed);
    expect(doc.getSolid(crossed.id)).toBeUndefined();
    expect(doc.solids.filter((solid) => solid.name.startsWith('Crossed_Slice'))).toHaveLength(2);
    expect(history.undo()).toBe(true);
    expect(doc.solids.map((solid) => solid.id).sort()).toEqual([crossed.id, missed.id].sort());
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
    const { manager } = setup();
    manager.startCommand('OFFSET');
    expect(manager.isMultiObjectStep).toBe(false);
    expect(manager.syncWindowSelection()).toBe(false);
  });

  it('gathers cutting edges as a multi-object step for TRIM and EXTEND', () => {
    for (const name of ['TRIM', 'EXTEND'] as const) {
      const { manager } = setup();
      manager.startCommand(name);
      expect(manager.isMultiObjectStep).toBe(true);
    }
  });

  it('keeps UNION additive and stages SUBTRACT around Enter', async () => {
    const union = setup();
    union.manager.startCommand('UNION');
    expect(union.manager.isAdditiveStep).toBe(true);
    expect(union.manager.isMultiObjectStep).toBe(false);

    const subtract = setup();
    const base = subtract.doc.createSolid(primitiveMesh({ kind: 'primitive', primitive: 'box', center: { x: 0, y: 0 }, width: 10, depth: 10, height: 10 }), 'base', 10, []);
    subtract.doc.addSolid(base);
    subtract.manager.startCommand('SUBTRACT');
    expect(subtract.manager.isAdditiveStep).toBe(true);
    expect(subtract.manager.isMultiObjectStep).toBe(false);
    await subtract.manager.handleClick({ x: 0, y: 0 }, undefined, base.id);
    expect(subtract.manager.active?.stepIndex).toBe(0);
    await subtract.manager.submitInput('');
    expect(subtract.manager.active?.stepIndex).toBe(1);
    expect(subtract.manager.isMultiObjectStep).toBe(true);
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
    expect(doc.solids[0].exact?.revision).toBe(doc.solids[0].revision);
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

describe('SPLINE command', () => {
  it('appends a fit point per pick and stays on the same step', async () => {
    const { doc, manager } = setup();
    manager.startCommand('SPLINE');
    await manager.handleClick({ x: 0, y: 0 });
    expect(manager.active?.stepIndex).toBe(1);

    await manager.handleClick({ x: 10, y: 5 });
    await manager.handleClick({ x: 20, y: 0 });
    expect(manager.active?.stepIndex).toBe(1);
    expect(doc.entities).toHaveLength(0);
    expect(manager.active?.data.points).toHaveLength(3);
  });

  it('fits one smooth Bezier chain through the clicked points on Enter', async () => {
    const { doc, history, manager } = setup();
    manager.startCommand('SPLINE');
    await manager.handleClick({ x: 0, y: 0 });
    await manager.handleClick({ x: 10, y: 8 });
    await manager.handleClick({ x: 20, y: 0 });
    await manager.submitInput('');

    expect(doc.entities).toHaveLength(1);
    const spline = doc.entities[0];
    expect(spline).toMatchObject({ type: 'bezier', start: { x: 0, y: 0 } });
    if (spline.type === 'bezier') {
      expect(spline.segments.length).toBeGreaterThan(0);
      expect(spline.segments.at(-1)!.end).toMatchObject({ x: 20, y: 0 });
    }
    expect(history.undo()).toBe(true);
    expect(doc.entities).toHaveLength(0);
  });

  it('refuses to finish with only one point', async () => {
    const { doc, log, manager } = setup();
    manager.startCommand('SPLINE');
    await manager.handleClick({ x: 0, y: 0 });
    await manager.submitInput('');
    expect(doc.entities).toHaveLength(0);
    expect(log).toHaveBeenCalledWith('A spline needs at least two points.');
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

  it('MIRROR takes a preselected solid from the model tree and mirrors it', async () => {
    const { doc, history, manager } = setup();
    const feature = {
      kind: 'primitive' as const, primitive: 'box' as const, center: { x: 4, y: 0 }, width: 2, depth: 2, height: 2,
    };
    const solid = doc.createSolid(primitiveMesh(feature), 'box', 2, [], undefined, feature);
    solid.exact = {
      kernel: 'opencascade', revision: solid.revision,
      shape: { format: 'occt-brep-v1', data: 'fixture' },
    };
    doc.addSolid(solid);
    doc.selectSolid(solid.id, true);

    manager.startCommand('MIRROR');
    expect(manager.active?.stepIndex).toBe(1);
    expect(manager.active?.data.solids).toHaveLength(1);
    await manager.handleClick({ x: 0, y: -1 });
    await manager.handleClick({ x: 0, y: 1 });

    expect(doc.solids).toHaveLength(2);
    const copy = doc.solids.find((item) => item.id !== solid.id)!;
    expect(copy.feature.kind).toBe('primitive');
    const xs = Array.from(copy.mesh.positions).filter((_, index) => index % 3 === 0);
    expect(Math.min(...xs)).toBeCloseTo(-5, 5);
    expect(Math.max(...xs)).toBeCloseTo(-3, 5);
    expect(copy.exact).toMatchObject({
      revision: copy.revision,
      transform: [-1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0],
    });
    expect(history.undo()).toBe(true);
    expect(doc.solids).toHaveLength(1);
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

describe('SCALE and ROTATE keep the history that built the solid', () => {
  const ball = (kit: ReturnType<typeof setup>) => {
    const feature = { kind: 'primitive' as const, primitive: 'sphere' as const, center: { x: 0, y: 0 }, radius: 4, height: 8 };
    const solid = kit.doc.createSolid(primitiveMesh(feature), 'Ball', 8, [], undefined, feature);
    kit.doc.addSolid(solid);
    kit.doc.selectSolid(solid.id);
    return solid;
  };

  // Reported from the app: scale a sphere and the model tree says "Mesh — no
  // history". The radius that made it is gone, and no undo brings it back,
  // because losing it *is* the operation.
  it('a scaled sphere is still a sphere', async () => {
    const kit = setup();
    ball(kit);
    kit.manager.startCommand('SCALE');
    await kit.manager.handleClick({ x: 0, y: 0 });
    await kit.manager.handleClick({ x: 1, y: 0 });
    await kit.manager.handleClick({ x: 2, y: 0 });

    const solid = kit.doc.solids[0];
    expect(solid.feature.kind).toBe('primitive');
    if (solid.feature.kind !== 'primitive') throw new Error('expected a primitive');
    expect(solid.feature.radius).toBe(4);
    expect(solid.feature.scale).toMatchObject({ x: 2, y: 2, z: 2 });
    let maxX = -Infinity;
    for (let i = 0; i < solid.mesh.positions.length; i += 3) maxX = Math.max(maxX, solid.mesh.positions[i]);
    expect(maxX).toBeCloseTo(8, 3);
  });

  // Reported next: rotation only worked on 2D objects. It did — ROTATE's step
  // said "Select 2D object(s)" and its onStart only ever looked at entities, so
  // a solid could be scaled but not turned. Nobody decided that; SCALE grew
  // solids and ROTATE beside it did not.
  it('turns a solid at all', async () => {
    const kit = setup();
    const solid = ball(kit);
    solid.feature = { kind: 'mesh' }; // the feature is a separate question
    kit.manager.startCommand('ROTATE');
    // Preselected, so it starts at the base point: the proof it took the solid.
    expect(kit.manager.active).toMatchObject({ stepIndex: 1 });
    await kit.manager.handleClick({ x: 10, y: 0 });
    await kit.manager.submitInput('180');

    // Half a turn about x = 10 takes a ball at the origin to x = 20.
    let maxX = -Infinity;
    for (let i = 0; i < kit.doc.solids[0].mesh.positions.length; i += 3) {
      maxX = Math.max(maxX, kit.doc.solids[0].mesh.positions[i]);
    }
    expect(maxX).toBeCloseTo(24, 3);
  });

  it('a rotated sphere is still a sphere', async () => {
    const kit = setup();
    ball(kit);
    kit.manager.startCommand('ROTATE');
    await kit.manager.handleClick({ x: 0, y: 0 });
    await kit.manager.submitInput('90');

    const solid = kit.doc.solids[0];
    expect(solid.feature.kind).toBe('primitive');
    if (solid.feature.kind !== 'primitive') throw new Error('expected a primitive');
    expect(solid.feature.radius).toBe(4);
  });

  // Reported: "ROTATE failed: Cannot create property 'selected' on string
  // 'solid_6'". A solid is picked by its id, because an id is all the viewport
  // can name it by — and ROTATE's step, newly told it accepts solids, pushed
  // that string in among the entities and later tried to clone it.
  it('takes a solid picked in the viewport, not only a preselected one', async () => {
    for (const command of ['ROTATE', 'SCALE'] as const) {
      const kit = setup();
      const solid = ball(kit);
      kit.doc.clearSelection();

      kit.manager.startCommand(command);
      await kit.manager.handleClick({ x: 0, y: 0 }, undefined, solid.id);
      await kit.manager.submitInput(''); // Enter: finished selecting
      await kit.manager.handleClick({ x: 0, y: 0 });
      if (command === 'ROTATE') await kit.manager.submitInput('90');
      else {
        await kit.manager.handleClick({ x: 1, y: 0 });
        await kit.manager.handleClick({ x: 2, y: 0 });
      }

      expect(kit.doc.solids, `${command} lost the solid`).toHaveLength(1);
      expect(kit.log, `${command} failed`).not.toHaveBeenCalledWith(expect.stringContaining('failed'));
      expect(kit.log).toHaveBeenCalledWith(expect.stringContaining('1 object(s)'));
    }
  });

  it('rotates a solid and a drawing together, which is what selecting both asks', async () => {
    const kit = setup();
    ball(kit);
    const line = kit.doc.createLine({ x: 0, y: 0 }, { x: 6, y: 0 });
    kit.doc.addEntity(line);
    kit.doc.selectEntity(line.id, true);

    kit.manager.startCommand('ROTATE');
    await kit.manager.handleClick({ x: 0, y: 0 });
    await kit.manager.submitInput('90');

    expect(kit.log).toHaveBeenCalledWith(expect.stringContaining('Rotated 2 object(s)'));
  });

  it('still bakes what it honestly cannot write down', async () => {
    const kit = setup();
    const solid = kit.doc.createSolid(
      primitiveMesh({ kind: 'primitive', primitive: 'sphere', center: { x: 0, y: 0 }, radius: 4, height: 8 }),
      'Imported', 8, [],
    );
    // A mesh has no history to keep, so there is nothing to carry along.
    expect(solid.feature.kind).toBe('mesh');
    kit.doc.addSolid(solid);
    kit.doc.selectSolid(solid.id);
    kit.manager.startCommand('SCALE');
    await kit.manager.handleClick({ x: 0, y: 0 });
    await kit.manager.submitInput('2');
    expect(kit.doc.solids[0].feature.kind).toBe('mesh');
  });
});

describe('EXTRUDE', () => {
  const extrude = async (height: string, plane?: Document['activeWorkPlane']) => {
    const kit = setup();
    if (plane) kit.doc.activeWorkPlane = plane;
    const profile = kit.doc.createRectangle({ x: 0, y: 0 }, { x: 10, y: 5 });
    kit.doc.addEntity(profile);
    kit.manager.startCommand('EXTRUDE');
    await kit.manager.handleClick({ x: 5, y: 2 }, profile);
    await kit.manager.submitInput('');
    await kit.manager.submitInput(height);
    const solid = kit.doc.solids[0];
    let minZ = Infinity, maxZ = -Infinity;
    for (let i = 2; i < (solid?.mesh.positions.length ?? 0); i += 3) {
      minZ = Math.min(minZ, solid.mesh.positions[i]);
      maxZ = Math.max(maxZ, solid.mesh.positions[i + 0]);
      maxZ = Math.max(maxZ, solid.mesh.positions[i]);
    }
    return { ...kit, solid, minZ, maxZ };
  };

  it('goes up for a positive height', async () => {
    const { solid, minZ, maxZ } = await extrude('10');
    expect(solid).toBeDefined();
    expect(solid.exact?.revision).toBe(solid.revision);
    expect(minZ).toBeCloseTo(0, 4);
    expect(maxZ).toBeCloseTo(10, 4);
  });

  // Math.abs used to throw the sign away: -10 built the same solid as +10, on
  // the reasoning that direction is the UCS's business. Being handed the
  // opposite of what you asked for is not a convention.
  it('goes down for a negative height', async () => {
    const { minZ, maxZ } = await extrude('-10');
    expect(minZ).toBeCloseTo(-10, 4);
    expect(maxZ).toBeCloseTo(0, 4);
  });

  it('keeps a downward extrusion regenerable', async () => {
    const { solid } = await extrude('-10');
    expect(solid.feature.kind).toBe('extrusion');
    if (solid.feature.kind !== 'extrusion') throw new Error('expected an extrusion');
    // A downward extrusion is the same positive-height feature placed below
    // by its own height — which regeneration already knew how to honour.
    expect(solid.feature.height).toBe(10);
    expect(solid.feature.reverse).toBe(true);
    expect(solid.feature.transform.translateZ).toBe(-10);
  });

  it('refuses a height of zero rather than building nothing', async () => {
    const { doc, log } = await extrude('0');
    expect(doc.solids).toHaveLength(0);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('cannot be zero'));
  });

  it('does not hand its work plane out to the next extrusion', async () => {
    const { solid } = await extrude('10');
    if (solid.feature.kind !== 'extrusion') throw new Error('expected an extrusion');
    // The fallback is a shared constant; storing it would give every extrusion
    // in the document the same work plane object to scribble on.
    expect(solid.feature.workPlane).not.toBe(WORLD_WORK_PLANE);
    expect(solid.feature.workPlane).toEqual(WORLD_WORK_PLANE);
  });

  it('extrudes every gathered profile in one undoable command', async () => {
    const kit = setup();
    const first = kit.doc.createRectangle({ x: 0, y: 0 }, { x: 4, y: 3 });
    const second = kit.doc.createCircle({ x: 10, y: 2 }, 2);
    kit.doc.addEntity(first); kit.doc.addEntity(second);
    kit.manager.startCommand('EXTRUDE');
    await kit.manager.handleClick({ x: 1, y: 1 }, first);
    await kit.manager.handleClick({ x: 10, y: 2 }, second);
    expect(kit.manager.active?.stepIndex).toBe(0);
    await kit.manager.submitInput('');
    await kit.manager.submitInput('6');

    expect(kit.doc.entities).toHaveLength(0);
    expect(kit.doc.solids).toHaveLength(2);
    expect(kit.doc.solids.every((solid) => solid.feature.kind === 'extrusion')).toBe(true);
    expect(kit.doc.solids.every((solid) => solid.exact?.revision === solid.revision)).toBe(true);
    expect(kit.history.undo()).toBe(true);
    expect(kit.doc.entities).toHaveLength(2);
    expect(kit.doc.solids).toHaveLength(0);
  });

  it('uses AutoCAD-style Path after the profile selection', async () => {
    const kit = setup();
    const profile = kit.doc.createRectangle({ x: -1, y: -1 }, { x: 1, y: 1 });
    const path = kit.doc.createLine({ x: 0, y: 0 }, { x: 10, y: 0 });
    kit.doc.addEntity(profile); kit.doc.addEntity(path);

    kit.manager.startCommand('EXTRUDE');
    await kit.manager.handleClick({ x: 0, y: 0 }, profile);
    await kit.manager.submitInput('');
    await kit.manager.submitInput('Path');
    expect(kit.manager.currentPrompt()).toBe('Select extrusion path:');
    await kit.manager.handleClick({ x: 5, y: 0 }, path);

    expect(kit.doc.solids).toHaveLength(1);
    expect(kit.doc.solids[0].feature).toMatchObject({ kind: 'sweep', createdBy: 'extrude' });
    if (kit.doc.solids[0].feature.kind !== 'sweep') throw new Error('expected a path extrusion');
    expect(kit.doc.solids[0].feature.profile.id).toBe(profile.id);
    expect(kit.doc.solids[0].feature.path.id).toBe(path.id);
    expect(kit.doc.solids[0].exact?.revision).toBe(kit.doc.solids[0].revision);
    expect(kit.doc.entities.map((entity) => entity.id)).toEqual([path.id]);
  });

  it('respects the work plane of a spatial LINE path', async () => {
    const kit = setup();
    const profile = kit.doc.createCircle({ x: 0, y: 0 }, 1);
    const path = kit.doc.createLine({ x: 0, y: 0 }, { x: 10, y: 0 });
    path.workPlane = workPlaneFromXAxis(
      { x: 0, y: 0, z: 0 },
      { x: 0, y: 0, z: 10 },
      { x: 0, y: 1, z: 0 },
    );
    kit.doc.addEntity(profile); kit.doc.addEntity(path);

    kit.manager.startCommand('EXTRUDE');
    await kit.manager.handleClick({ x: 0, y: 0 }, profile);
    await kit.manager.submitInput('');
    await kit.manager.submitInput('P');
    await kit.manager.handleClick({ x: 0, y: 0, z: 5 }, path);

    const positions = kit.doc.solids[0].mesh.positions;
    const zs = Array.from(positions).filter((_value, index) => index % 3 === 2);
    expect(Math.min(...zs)).toBeCloseTo(0, 4);
    expect(Math.max(...zs)).toBeCloseTo(10, 4);
    expect(kit.doc.solids[0].exact?.revision).toBe(kit.doc.solids[0].revision);
  });

  it('extrudes in the 3D vector specified by two Direction points', async () => {
    const kit = setup();
    const profile = kit.doc.createRectangle({ x: 0, y: 0 }, { x: 2, y: 2 });
    kit.doc.addEntity(profile);

    kit.manager.startCommand('EXTRUDE');
    await kit.manager.handleClick({ x: 1, y: 1 }, profile);
    await kit.manager.submitInput('');
    await kit.manager.submitInput('D');
    await kit.manager.handleClick({ x: 0, y: 0, z: 0 });
    await kit.manager.handleClick({ x: 5, y: 0, z: 10 });

    const solid = kit.doc.solids[0];
    expect(solid?.feature).toMatchObject({ kind: 'extrusion', direction: { x: 5, y: 0, z: 10 } });
    expect(solid.exact?.revision).toBe(solid.revision);
    const xs = Array.from(solid.mesh.positions).filter((_value, index) => index % 3 === 0);
    const zs = Array.from(solid.mesh.positions).filter((_value, index) => index % 3 === 2);
    expect(Math.max(...xs)).toBeCloseTo(7, 4);
    expect(Math.max(...zs)).toBeCloseTo(10, 4);
  });

  it('stores and regenerates the Taper angle option', async () => {
    const kit = setup();
    const profile = kit.doc.createRectangle({ x: 0, y: 0 }, { x: 10, y: 10 });
    kit.doc.addEntity(profile);

    kit.manager.startCommand('EXTRUDE');
    await kit.manager.handleClick({ x: 5, y: 5 }, profile);
    await kit.manager.submitInput('');
    await kit.manager.submitInput('Taper angle');
    await kit.manager.submitInput('5');
    await kit.manager.submitInput('10');

    const solid = kit.doc.solids[0];
    expect(solid?.feature).toMatchObject({ kind: 'extrusion', height: 10, taperAngle: 5 });
    expect(solid.exact?.revision).toBe(solid.revision);
    const topX: number[] = [];
    for (let i = 0; i < solid.mesh.positions.length; i += 3) {
      if (Math.abs(solid.mesh.positions[i + 2] - 10) < 1e-5) topX.push(solid.mesh.positions[i]);
    }
    expect(Math.max(...topX) - Math.min(...topX)).toBeLessThan(10);
  });

  it('keeps the original profile at zero when a tapered extrusion goes down', async () => {
    const kit = setup();
    const profile = kit.doc.createRectangle({ x: 0, y: 0 }, { x: 10, y: 10 });
    kit.doc.addEntity(profile);

    kit.manager.startCommand('EXTRUDE');
    await kit.manager.handleClick({ x: 5, y: 5 }, profile);
    await kit.manager.submitInput('');
    await kit.manager.submitInput('T');
    await kit.manager.submitInput('5');
    await kit.manager.submitInput('-10');

    const mesh = kit.doc.solids[0].mesh;
    expect(kit.doc.solids[0].exact?.revision).toBe(kit.doc.solids[0].revision);
    const widthAt = (z: number) => {
      const xs: number[] = [];
      for (let i = 0; i < mesh.positions.length; i += 3) {
        if (Math.abs(mesh.positions[i + 2] - z) < 1e-5) xs.push(mesh.positions[i]);
      }
      return Math.max(...xs) - Math.min(...xs);
    };
    expect(widthAt(0)).toBeCloseTo(10, 4);
    expect(widthAt(-10)).toBeLessThan(10);
  });
});

describe('PRESSPULL', () => {
  it('rejects a solid hit without a planar face instead of modifying the whole body', async () => {
    const kit = setup();
    const solid = kit.doc.createSolid(createBoxMesh(10, 6, 4), 'Box', 4, []);
    kit.doc.addSolid(solid);

    kit.manager.startCommand('PRESSPULL');
    await kit.manager.handleClick({ x: 0, y: 0, z: 0 }, undefined, solid.id);

    expect(kit.manager.active?.stepIndex).toBe(0);
    expect(kit.log).toHaveBeenCalledWith(expect.stringContaining('planar face'));
  });

  it('keeps a bounded face pull as an editable feature and one undo restores the source', async () => {
    const kit = setup();
    const feature = boxLikePrimitiveFeature('box', { x: -5, y: -3 }, { x: 5, y: 3 }, 4, WORLD_WORK_PLANE)!;
    const sourceExact = await buildExactFeature(feature);
    const sourceMesh = sourceExact!.mesh;
    const solid = kit.doc.createSolid(sourceMesh, 'Box', 4, [], undefined, feature);
    solid.exact = sourceExact!.exact;
    kit.doc.addSolid(solid);
    kit.doc.activeWorkPlane.origin.z = 4;
    const divider = kit.doc.createLine({ x: -5, y: 0 }, { x: 5, y: 0 });
    const top = solidPlanarFaces(sourceMesh).find((candidate) => candidate.normal.z > 0.9)!;
    const region = planarFaceRegionAt(top, [divider], { x: 0, y: 2, z: 4 })!;

    kit.manager.startCommand('PRESSPULL');
    await kit.manager.handleClick(
      { x: 0, y: 2, z: 4 },
      undefined,
      solid.id,
      { solidId: solid.id, vertexIndices: top.vertexIndices, normal: top.normal, region },
    );
    await kit.manager.submitInput('3');

    expect(kit.doc.solids[0].feature).toMatchObject({ kind: 'presspull-region', distance: 3 });
    expect(kit.doc.solids[0].exact?.revision).toBe(kit.doc.solids[0].revision);
    expect(Math.max(...Array.from(kit.doc.solids[0].mesh.positions).filter((_value, index) => index % 3 === 2))).toBeCloseTo(7, 4);
    expect(kit.history.undo()).toBe(true);
    expect(kit.doc.solids[0].feature).toMatchObject({ kind: 'primitive', primitive: 'box' });
    expect(kit.doc.solids[0].mesh.positions).toEqual(sourceMesh.positions);
  });
});

describe('remembered command values', () => {
  it('uses the previous circle radius when Enter answers the next radius prompt', async () => {
    const { doc, manager } = setup();
    manager.startCommand('CIRCLE');
    await manager.handleClick({ x: 0, y: 0 });
    await manager.handleClick({ x: 5, y: 0 });
    await manager.handleClick({ x: 20, y: 10 });
    await manager.submitInput('');

    expect(doc.entities).toHaveLength(2);
    expect(doc.entities[1]).toMatchObject({ type: 'circle', center: { x: 20, y: 10 }, radius: 5 });
  });

  it('reuses the last successful FILLET radius', async () => {
    const { doc, history, manager } = setup();
    const solid = doc.createSolid(primitiveMesh({
      kind: 'primitive', primitive: 'box', center: { x: 0, y: 0 }, width: 10, depth: 6, height: 4,
    }), 'box', 4, []);
    doc.addSolid(solid);
    const edge = {
      solidId: solid.id,
      start: { x: 5, y: 3, z: 0 }, end: { x: 5, y: 3, z: 4 },
      normalA: { x: 1, y: 0, z: 0 }, normalB: { x: 0, y: 1, z: 0 },
    };

    manager.startCommand('FILLET');
    await manager.handleClick({ x: 0, y: 0 }, undefined, undefined, undefined, edge);
    await manager.submitInput('1');
    expect(manager.active).toBeNull();
    expect(doc.solids[0].feature).toMatchObject({
      kind: 'edge-modification', operation: 'fillet', amount: 1,
    });
    if (doc.solids[0].feature.kind !== 'edge-modification') throw new Error('expected an edge feature');
    expect(Array.isArray(doc.solids[0].feature.sourceMesh!.positions)).toBe(true);
    expect(history.undo()).toBe(true);

    manager.startCommand('FILLET');
    await manager.handleClick({ x: 0, y: 0 }, undefined, undefined, undefined, edge);
    await manager.submitInput('');
    expect(manager.active).toBeNull();
    expect(doc.solids[0].mesh.indices.length).toBeGreaterThan(primitiveMesh({
      kind: 'primitive', primitive: 'box', center: { x: 0, y: 0 }, width: 10, depth: 6, height: 4,
    }).indices.length);
  });

  it('reuses both successful CHAMFER distances independently', async () => {
    const { doc, history, manager } = setup();
    const solid = doc.createSolid(primitiveMesh({
      kind: 'primitive', primitive: 'box', center: { x: 0, y: 0 }, width: 10, depth: 6, height: 4,
    }), 'box', 4, []);
    doc.addSolid(solid);
    const edge = {
      solidId: solid.id,
      start: { x: 5, y: 3, z: 0 }, end: { x: 5, y: 3, z: 4 },
      normalA: { x: 1, y: 0, z: 0 }, normalB: { x: 0, y: 1, z: 0 },
    };

    manager.startCommand('CHAMFER');
    await manager.handleClick({ x: 0, y: 0 }, undefined, undefined, undefined, edge);
    expect(manager.currentPrompt()).toBe('Enter chamfer distance (1, 1):');
    await manager.submitInput('1, 2');
    expect(manager.active).toBeNull();
    expect(doc.solids[0].feature).toMatchObject({
      kind: 'edge-modification', operation: 'chamfer', amount: 1, amount2: 2,
    });
    expect(history.undo()).toBe(true);

    manager.startCommand('CHAMFER');
    await manager.handleClick({ x: 0, y: 0 }, undefined, undefined, undefined, edge);
    expect(manager.currentPrompt()).toBe('Enter chamfer distance (1, 2):');
    await manager.submitInput('');

    expect(manager.active).toBeNull();
    expect(doc.solids[0].feature).toMatchObject({
      kind: 'edge-modification', operation: 'chamfer', amount: 1, amount2: 2,
    });
  });

  it('keeps FILLET on a topology-selected edge in the exact kernel', async () => {
    const { doc, manager } = setup();
    const feature = {
      kind: 'primitive' as const, primitive: 'box' as const,
      center: { x: 0, y: 0 }, width: 10, depth: 6, height: 4,
    };
    const geometry = await buildExactFeature(feature);
    const solid = doc.createSolid(geometry!.mesh, 'box', 4, [], undefined, feature);
    solid.exact = geometry!.exact;
    doc.addSolid(solid);
    const incident = new Map<string, { vertices: [number, number]; faces: Set<number> }>();
    for (let offset = 0; offset < solid.mesh.indices.length; offset += 3) {
      const ids = [solid.mesh.indices[offset], solid.mesh.indices[offset + 1], solid.mesh.indices[offset + 2]];
      for (let index = 0; index < 3; index++) {
        const a = ids[index], b = ids[(index + 1) % 3];
        const key = a < b ? `${a}:${b}` : `${b}:${a}`;
        const item = incident.get(key) ?? { vertices: [a, b] as [number, number], faces: new Set<number>() };
        item.faces.add(solid.mesh.triangleFaceIds![offset / 3]);
        incident.set(key, item);
      }
    }
    const selected = [...incident.values()].find((item) => item.faces.size === 2)!;
    const point = (index: number) => ({
      x: solid.mesh.positions[index * 3],
      y: solid.mesh.positions[index * 3 + 1],
      z: solid.mesh.positions[index * 3 + 2],
    });
    const edge = {
      solidId: solid.id,
      topologyFaceIds: [...selected.faces] as [number, number],
      start: point(selected.vertices[0]),
      end: point(selected.vertices[1]),
      normalA: { x: 1, y: 0, z: 0 },
      normalB: { x: 0, y: 1, z: 0 },
    };

    manager.startCommand('FILLET');
    await manager.handleClick({ x: 0, y: 0 }, undefined, undefined, undefined, edge);
    await manager.submitInput('1');

    expect(doc.solids[0].feature).toMatchObject({ kind: 'edge-modification', operation: 'fillet' });
    expect(doc.solids[0].exact?.revision).toBe(doc.solids[0].revision);
  });
});

describe('DELETEFACE', () => {
  it('removes a picked face introduced by the latest chamfer and undo restores it', async () => {
    const { doc, history, manager } = setup();
    const source = createBoxMesh(10, 6, 4);
    const solid = doc.createSolid(source, 'box', 4, []);
    doc.addSolid(solid);
    const edge = {
      solidId: solid.id,
      start: { x: 5, y: 3, z: 0 }, end: { x: 5, y: 3, z: 4 },
      normalA: { x: 1, y: 0, z: 0 }, normalB: { x: 0, y: 1, z: 0 },
    };
    manager.startCommand('CHAMFER');
    await manager.handleClick({ x: 0, y: 0 }, undefined, undefined, undefined, edge);
    await manager.submitInput('1, 1');
    const chamfered = doc.solids[0];
    const sourceFaces = solidPlanarFaces(source);
    const generated = solidPlanarFaces(chamfered.mesh).find((face) => !sourceFaces.some((candidate) => {
      const parallel = Math.abs(
        face.normal.x * candidate.normal.x + face.normal.y * candidate.normal.y + face.normal.z * candidate.normal.z,
      ) > 1 - 1e-6;
      const offset = face.normal.x * face.plane.origin.x + face.normal.y * face.plane.origin.y + face.normal.z * face.plane.origin.z;
      const candidateOffset = face.normal.x * candidate.plane.origin.x + face.normal.y * candidate.plane.origin.y + face.normal.z * candidate.plane.origin.z;
      return parallel && Math.abs(offset - candidateOffset) < 1e-5;
    }))!;
    const selection = {
      solidId: solid.id,
      vertexIndices: generated.vertexIndices,
      normal: generated.normal,
      hitPoint: generated.plane.origin,
      region: { plane: generated.plane, loops: generated.loops },
    };

    manager.startCommand('DELETEFACE');
    await manager.handleClick(generated.plane.origin, undefined, undefined, selection);

    expect(manager.active).toBeNull();
    expect(doc.solids[0].feature.kind).toBe('mesh');
    expect(doc.solids[0].exact?.revision).toBe(doc.solids[0].revision);
    const kernel = await openCascadeKernel();
    const restored = await openExactShape(doc.solids[0], kernel);
    expect(restored).not.toBeNull();
    if (restored) {
      expect(kernel.inspect(restored)).toMatchObject({
        bounds: { min: { x: -5, y: -3, z: expect.closeTo(0, 10) }, max: { x: 5, y: 3, z: 4 } },
        faceCount: 6,
        solidCount: 1,
        valid: true,
        volume: expect.closeTo(240, 6),
      });
      restored.dispose();
    }
    expect(history.undo()).toBe(true);
    expect(doc.solids[0].feature).toMatchObject({ kind: 'edge-modification', operation: 'chamfer' });
  });

  it('deletes a hole by clicking its wall, filling it back to the base', async () => {
    const { doc, history, manager } = setup();
    const feature = {
      kind: 'boolean', operation: 'subtract', operands: [
        { kind: 'primitive', primitive: 'box', center: { x: 0, y: 0 }, width: 20, depth: 20, height: 20 },
        { kind: 'primitive', primitive: 'cylinder', center: { x: 0, y: 0 }, radius: 3, height: 30 },
      ],
    } as never;
    const geometry = await buildExactFeature(feature);
    const mesh = geometry!.mesh;
    const solid = doc.createSolid(mesh, 'holed block', 20, [], undefined, feature);
    solid.exact = geometry!.exact;
    doc.addSolid(solid);
    // A curved hole wall gives no planar face — the pointer handler hands Delete
    // Face the raw surface point instead (empty vertexIndices + a hitPoint).
    // A rendered curved triangle may expose the cutter-side orientation. The
    // command must still identify and remove the complete cylinder feature.
    const selection = { solidId: solid.id, vertexIndices: [], normal: { x: 1, y: 0, z: 0 }, hitPoint: { x: 3, y: 0, z: 10 } };
    manager.startCommand('DELETEFACE');
    await manager.handleClick({ x: 3, y: 0, z: 10 }, undefined, undefined, selection);

    expect(manager.active).toBeNull();
    expect(doc.solids[0].feature).toMatchObject({ kind: 'primitive', primitive: 'box' });
    expect(doc.solids[0].exact?.revision).toBe(doc.solids[0].revision);
    expect(history.undo()).toBe(true);
    expect(doc.solids[0].feature).toMatchObject({ kind: 'boolean', operation: 'subtract' });
  });
});

describe('staged SUBTRACT', () => {
  it('confirms the base with Enter and subtracts every gathered cutter with the next Enter', async () => {
    const { doc, history, manager } = setup();
    const makeBox = (name: string, centerX: number, width: number) => doc.createSolid(primitiveMesh({
      kind: 'primitive', primitive: 'box', center: { x: centerX, y: 0 }, width, depth: 8, height: 8,
    }), name, 8, []);
    const base = makeBox('base', 0, 20);
    const first = makeBox('first cutter', -4, 2);
    const second = makeBox('second cutter', 4, 2);
    doc.addSolid(base); doc.addSolid(first); doc.addSolid(second);

    manager.startCommand('SUBTRACT');
    await manager.handleClick({ x: 0, y: 0 }, undefined, base.id);
    expect(manager.active?.stepIndex).toBe(0);
    await manager.submitInput('');
    expect(manager.active?.stepIndex).toBe(1);
    await manager.handleClick({ x: 0, y: 0 }, undefined, first.id);
    await manager.handleClick({ x: 0, y: 0 }, undefined, second.id);
    expect(manager.active?.stepIndex).toBe(1);
    await manager.submitInput('');

    expect(manager.active).toBeNull();
    expect(doc.solids).toHaveLength(1);
    expect(doc.solids[0].feature).toMatchObject({ kind: 'boolean', operation: 'subtract' });
    expect(history.undo()).toBe(true);
    expect(doc.solids).toHaveLength(3);
  });

  it('keeps SUBTRACT exact and INTERSECT creates the exact shared volume', async () => {
    const exactBox = async (doc: Document, name: string, centerX: number) => {
      const feature = {
        kind: 'primitive' as const, primitive: 'box' as const,
        center: { x: centerX, y: 0 }, width: 10, depth: 10, height: 10,
      };
      const geometry = await buildExactFeature(feature);
      const solid = doc.createSolid(geometry!.mesh, name, 10, [], undefined, feature);
      solid.exact = geometry!.exact;
      doc.addSolid(solid);
      return solid;
    };

    const subtract = setup();
    const subtractBase = await exactBox(subtract.doc, 'base', 0);
    const subtractTool = await exactBox(subtract.doc, 'tool', 5);
    subtract.manager.startCommand('SUBTRACT');
    await subtract.manager.handleClick({ x: 0, y: 0 }, undefined, subtractBase.id);
    await subtract.manager.submitInput('');
    await subtract.manager.handleClick({ x: 0, y: 0 }, undefined, subtractTool.id);
    await subtract.manager.submitInput('');
    expect(subtract.doc.solids).toHaveLength(1);
    expect(subtract.doc.solids[0].exact?.revision).toBe(subtract.doc.solids[0].revision);

    const intersect = setup();
    const first = await exactBox(intersect.doc, 'first', 0);
    const second = await exactBox(intersect.doc, 'second', 5);
    intersect.manager.startCommand('INTERSECT');
    await intersect.manager.handleClick({ x: 0, y: 0 }, undefined, first.id);
    await intersect.manager.handleClick({ x: 0, y: 0 }, undefined, second.id);
    await intersect.manager.submitInput('');
    expect(intersect.doc.solids).toHaveLength(1);
    const common = intersect.doc.solids[0];
    expect(common).toMatchObject({
      name: 'Intersect',
      feature: { kind: 'boolean', operation: 'intersect' },
      exact: { kernel: 'opencascade', revision: common.revision },
    });
    const kernel = await openCascadeKernel();
    const shape = await openExactShape(common, kernel);
    try {
      expect(kernel.inspect(shape!)).toMatchObject({
        bounds: { min: { x: 0, y: -5, z: 0 }, max: { x: 5, y: 5, z: 10 } },
        volume: expect.closeTo(500, 8),
        valid: true,
      });
    } finally {
      shape?.dispose();
    }
  });
});

describe('linear and aligned dimensions', () => {
  // The points form a 3-4-5 triangle, so the answer says which one it measured.
  // Enter at the end declines to move the text, which is the ordinary way through.
  const measure = async (name: 'MEASURE' | 'DIMALIGNED', offset: { x: number; y: number }) => {
    const kit = setup();
    kit.manager.startCommand(name);
    await kit.manager.handleClick({ x: 0, y: 0 });
    await kit.manager.handleClick({ x: 3, y: 4 });
    await kit.manager.handleClick(offset);
    await kit.manager.submitInput('');
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

  it('creates an aligned dimension for a truly spatial edge', async () => {
    const kit = setup();
    kit.manager.startCommand('DIMALIGNED');
    await kit.manager.handleClick({ x: 2, y: 3, z: 0 });
    await kit.manager.handleClick({ x: 2, y: 3, z: 12 });
    await kit.manager.handleClick({ x: 8, y: 3, z: 4 });
    await kit.manager.submitInput('');

    const dimension = kit.doc.entities[0];
    if (dimension.type !== 'dimension') throw new Error('expected a dimension');
    expect(dimensionGeometry(dimension).text).toBe('12.00');
    const startWorld = localToWorld(dimension.workPlane!, dimension.start);
    const endWorld = localToWorld(dimension.workPlane!, dimension.end);
    expect(startWorld).toMatchObject({ x: 2, y: 3, z: 0 });
    expect(endWorld).toMatchObject({ x: 2, y: 3, z: 12 });
  });

  it('uses a vertical UCS plane for a linear Z dimension', async () => {
    const kit = setup();
    const sidePlane = {
      origin: { x: 0, y: 4, z: 0 },
      xAxis: { x: 1, y: 0, z: 0 },
      yAxis: { x: 0, y: 0, z: 1 },
      zAxis: { x: 0, y: -1, z: 0 },
    };
    kit.doc.activeWorkPlane = sidePlane;
    kit.manager.startCommand('MEASURE');
    await kit.manager.handleClick({ x: 2, y: 0 });
    await kit.manager.handleClick({ x: 2, y: 12 });
    await kit.manager.handleClick({ x: 8, y: 6 });
    await kit.manager.submitInput('');

    const dimension = kit.doc.entities[0];
    if (dimension.type !== 'dimension') throw new Error('expected a dimension');
    expect(dimensionGeometry(dimension).text).toBe('12.00');
    expect(dimension.workPlane).toEqual(sidePlane);
    expect(localToWorld(dimension.workPlane!, dimension.start)).toEqual({ x: 2, y: 4, z: 0 });
    expect(localToWorld(dimension.workPlane!, dimension.end)).toEqual({ x: 2, y: 4, z: 12 });
  });

  it('is reachable as its own command', () => {
    const { manager } = setup();
    expect(manager.resolveAlias('dal')).toBe('DIMALIGNED');
    expect(manager.commandSuggestions('DIM')).toContain('DIMALIGNED');
  });

  it('leaves the text centred when the last step is skipped', async () => {
    const { dimension } = await measure('MEASURE', { x: 1.5, y: 9 });
    expect(dimension).toMatchObject({ type: 'dimension' });
    expect((dimension as { textPosition?: unknown }).textPosition).toBeUndefined();
    // Centred on the dimension line, which for this one runs along y = 9.
    if (dimension.type === 'dimension') expect(dimensionGeometry(dimension).textPoint.x).toBeCloseTo(1.5);
  });

  it('puts the text where a fourth click asks for it', async () => {
    const kit = setup();
    kit.manager.startCommand('MEASURE');
    await kit.manager.handleClick({ x: 0, y: 0 });
    await kit.manager.handleClick({ x: 3, y: 4 });
    await kit.manager.handleClick({ x: 1.5, y: 9 });
    // Nothing is drawn yet: the dimension is one entity, made once, so that
    // undo takes back the whole dimension rather than just its text.
    expect(kit.doc.entities).toHaveLength(0);

    await kit.manager.handleClick({ x: 8, y: 12 });

    expect(kit.doc.entities).toHaveLength(1);
    const dimension = kit.doc.entities[0];
    if (dimension.type !== 'dimension') throw new Error('expected a dimension');
    expect(dimension.textPosition).toEqual({ x: 8, y: 12 });
    expect(dimensionGeometry(dimension).textPoint).toEqual({ x: 8, y: 12 });
    // Dragging the text does not change what the dimension measures.
    expect(dimensionGeometry(dimension).text).toBe('3.00');

    kit.history.undo();
    expect(kit.doc.entities).toHaveLength(0);
  });

  it('restarts sticky with the style it was started with', async () => {
    const kit = setup();
    kit.doc.dimensionStyle.precision = 3;
    kit.manager.startCommand('DIMALIGNED');
    await kit.manager.handleClick({ x: 0, y: 0 });
    await kit.manager.handleClick({ x: 3, y: 4 });
    await kit.manager.handleClick({ x: -4, y: 5 });
    await kit.manager.submitInput('');

    // Sticky, so it is on its first step again — and the preview reads the style
    // from the command's own data, which the restart used to throw away.
    expect(kit.manager.active?.stepIndex).toBe(0);
    expect(kit.manager.active?.data.dimensionStyle).toMatchObject({ precision: 3 });
  });
});

describe('which leg a linear dimension reads', () => {
  const reads = (start: { x: number; y: number }, end: { x: number; y: number }, offset: { x: number; y: number }) => {
    const rotation = linearDimensionRotation(start, end, offset);
    return Math.abs((end.x - start.x) * Math.cos(rotation) + (end.y - start.y) * Math.sin(rotation));
  };

  // Dimensioning a horizontal line read 0 unless the line was dragged far above
  // it: the choice was made from the offset to the midpoint, so drifting along
  // the line looked like being pulled sideways.
  it('always reads the length of a horizontal line, wherever it is placed', () => {
    const start = { x: 0, y: 0 }, end = { x: 10, y: 0 };
    for (const offset of [{ x: 5, y: 0.5 }, { x: 7, y: 1 }, { x: 9, y: 1 }, { x: 9, y: 3 }, { x: 12, y: 1 }, { x: 5, y: -2 }]) {
      expect(reads(start, end, offset), `placed at ${JSON.stringify(offset)}`).toBeCloseTo(10);
    }
  });

  it('always reads the length of a vertical line, wherever it is placed', () => {
    const start = { x: 0, y: 0 }, end = { x: 0, y: 7 };
    for (const offset of [{ x: 1, y: 3.5 }, { x: 1, y: 6 }, { x: 3, y: 9 }, { x: -2, y: 1 }]) {
      expect(reads(start, end, offset), `placed at ${JSON.stringify(offset)}`).toBeCloseTo(7);
    }
  });

  it('never reads zero, whatever is thrown at it', () => {
    const cases: Array<[{ x: number; y: number }, { x: number; y: number }]> = [
      [{ x: 0, y: 0 }, { x: 10, y: 0 }],
      [{ x: 0, y: 0 }, { x: 0, y: 10 }],
      [{ x: 2, y: 3 }, { x: 9, y: 3 }],
    ];
    for (const [start, end] of cases) {
      for (let x = -5; x <= 15; x += 2.5) {
        for (let y = -5; y <= 15; y += 2.5) {
          expect(reads(start, end, { x, y }), `${JSON.stringify(start)}→${JSON.stringify(end)} at ${x},${y}`).toBeGreaterThan(0);
        }
      }
    }
  });

  // A diagonal has two real legs, so where the line is pulled genuinely chooses.
  it('lets a diagonal be dimensioned either way', () => {
    const start = { x: 0, y: 0 }, end = { x: 3, y: 4 };
    expect(reads(start, end, { x: 1.5, y: 9 })).toBeCloseTo(3);   // pulled above
    expect(reads(start, end, { x: -6, y: 2 })).toBeCloseTo(4);    // pulled aside
  });
});
