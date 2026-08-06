import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { localToWorld } from '../math/workplane';
import { CadMcpSession } from './CadMcpSession';

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'mycad-mcp-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('CadMcpSession', () => {
  it('creates, subtracts, saves, reloads and exports solids', async () => {
    const directory = await temporaryDirectory();
    const projectPath = join(directory, 'fixture.mycad');
    const stlPath = join(directory, 'fixture.stl');
    const session = new CadMcpSession();

    const base = await session.createPrimitive({
      primitive: 'box', center: { x: 0, y: 0 }, width: 80, depth: 50, height: 10,
    });
    const firstHole = await session.createPrimitive({
      primitive: 'cylinder', center: { x: 15, y: 15, z: -1 }, radius: 2, height: 12,
    });
    const secondHole = await session.createPrimitive({
      primitive: 'cylinder', center: { x: 65, y: 35, z: -1 }, radius: 2, height: 12,
    });
    const result = await session.booleanOperation('subtract', [
      String(base.id), String(firstHole.id), String(secondHole.id),
    ], 'Plate');

    expect(session.summary()).toMatchObject({ entityCount: 0, solidCount: 1, canUndo: true });
    expect(session.getObject(String(result.id))).toMatchObject({
      kind: 'solid', name: 'Plate', featureKind: 'boolean',
    });
    expect(session.document.solids[0].exact?.revision).toBe(session.document.solids[0].revision);

    await session.saveProject(projectPath);
    await session.exportStl(stlPath);
    expect(JSON.parse(await readFile(projectPath, 'utf8'))).toMatchObject({ version: expect.any(Number) });
    expect(await readFile(stlPath, 'utf8')).toContain('facet normal');

    const reloaded = new CadMcpSession();
    await reloaded.openProject(projectPath);
    expect(reloaded.summary()).toMatchObject({ projectPath, entityCount: 0, solidCount: 1 });
    expect(reloaded.listObjects()).toEqual([
      expect.objectContaining({ kind: 'solid', name: 'Plate', featureKind: 'boolean' }),
    ]);
  });

  it('keeps exact MCP primitives in the normal undo and redo history', async () => {
    const session = new CadMcpSession();
    await session.createPrimitive({
      primitive: 'box', center: { x: 0, y: 0 }, width: 10, depth: 10, height: 10,
    });

    expect(session.summary()).toMatchObject({ solidCount: 1, canUndo: true, canRedo: false });
    expect(session.document.solids[0].exact?.revision).toBe(session.document.solids[0].revision);
    expect(session.undo()).toMatchObject({ solidCount: 0, canUndo: false, canRedo: true });
    expect(session.redo()).toMatchObject({ solidCount: 1, canUndo: true, canRedo: false });
  });

  it('intersects MCP solids as an exact boolean', async () => {
    const session = new CadMcpSession();
    const first = await session.createPrimitive({
      primitive: 'box', center: { x: 0, y: 0 }, width: 10, depth: 10, height: 10,
    });
    const second = await session.createPrimitive({
      primitive: 'box', center: { x: 5, y: 0 }, width: 10, depth: 10, height: 10,
    });

    const common = await session.booleanOperation('intersect', [String(first.id), String(second.id)]);

    expect(common).toMatchObject({ name: 'Intersect', featureKind: 'boolean' });
    expect(session.document.solids).toHaveLength(1);
    expect(session.document.solids[0].exact?.revision).toBe(session.document.solids[0].revision);
    expect(session.document.solids[0].feature).toMatchObject({ kind: 'boolean', operation: 'intersect' });
  });

  it('creates horizontal and vertical line entities between 3D UCS points', () => {
    const session = new CadMcpSession();
    const created = session.createLines([
      { start: { x: 0, y: 0, z: 0 }, end: { x: 20, y: 0, z: 0 } },
      { start: { x: 20, y: 30, z: 0 }, end: { x: 20, y: 30, z: 40 } },
    ]);

    expect(created).toHaveLength(2);
    expect(session.summary()).toMatchObject({ viewMode: '3d', entityCount: 2, selectedEntityIds: created.map((line) => line.id) });
    const vertical = session.document.getEntity(String(created[1].id));
    expect(vertical?.type).toBe('line');
    if (!vertical || vertical.type !== 'line' || !vertical.workPlane) throw new Error('Missing test line work plane.');
    expect(localToWorld(vertical.workPlane, vertical.start)).toEqual({ x: 20, y: 30, z: 0 });
    expect(localToWorld(vertical.workPlane, vertical.end)).toEqual({ x: 20, y: 30, z: 40 });
  });

  it('extrudes a points outline into a solid from its traced elevation', async () => {
    const session = new CadMcpSession();
    // A 40×20 outline traced 50 up the active plane, pulled 5 mm.
    const solid = await session.extrude({
      points: [
        { x: 0, y: 0, z: 50 }, { x: 40, y: 0, z: 50 }, { x: 40, y: 20, z: 50 }, { x: 0, y: 20, z: 50 },
      ],
      height: 5,
      name: 'Base',
    });

    // Only the solid is committed — the traced outline is not left behind.
    expect(session.summary()).toMatchObject({ viewMode: '3d', entityCount: 0, solidCount: 1 });
    expect(solid).toMatchObject({ name: 'Base', featureKind: 'extrusion' });
    expect(solid.bounds).toMatchObject({
      min: { x: expect.closeTo(0, 5), y: expect.closeTo(0, 5), z: expect.closeTo(50, 5) },
      max: { x: expect.closeTo(40, 5), y: expect.closeTo(20, 5), z: expect.closeTo(55, 5) },
    });
    expect(session.document.solids[0].exact?.revision).toBe(session.document.solids[0].revision);
    expect(session.undo()).toMatchObject({ solidCount: 0, canRedo: true });
  });

  it('extrudes an existing closed profile and consumes it', async () => {
    const session = new CadMcpSession();
    const profile = session.document.createPolyline(
      [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }],
      true,
    );
    session.document.addEntity(profile);
    expect(session.summary()).toMatchObject({ entityCount: 1, solidCount: 0 });

    const solid = await session.extrude({ profileId: profile.id, height: 3 });

    expect(solid).toMatchObject({ featureKind: 'extrusion' });
    // The profile is replaced by the extrusion, not left alongside it.
    expect(session.summary()).toMatchObject({ entityCount: 0, solidCount: 1 });
    expect(session.document.getEntity(profile.id)).toBeUndefined();
  });

  it('rejects an extrusion of an open or missing profile', async () => {
    const session = new CadMcpSession();
    await expect(session.extrude({ profileId: 'nope', height: 5 })).rejects.toThrow('does not exist');
    await expect(session.extrude({ points: [{ x: 0, y: 0 }], height: 5 })).rejects.toThrow('three points');
    await expect(session.extrude({ points: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }], height: 0 })).rejects.toThrow('non-zero');
  });

  it('rejects unrelated file types', async () => {
    const session = new CadMcpSession();
    await expect(session.saveProject('/tmp/not-a-project.json')).rejects.toThrow('Expected a .mycad file path');
    await expect(session.exportStl('/tmp/not-a-model.obj', [])).rejects.toThrow('Expected a .stl file path');
  });
});
