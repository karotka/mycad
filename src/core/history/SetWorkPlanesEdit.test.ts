import { describe, expect, it } from 'vitest';
import { Document } from '../Document';
import { CommandHistory } from './CommandHistory';
import { SetWorkPlanesEdit, captureWorkPlanes, worldWorkPlaneState } from './edits';

const wp = (x: number) => ({
  origin: { x, y: 0, z: 0 },
  xAxis: { x: 1, y: 0, z: 0 }, yAxis: { x: 0, y: 1, z: 0 }, zAxis: { x: 0, y: 0, z: 1 },
});

describe('SetWorkPlanesEdit', () => {
  it('resets the coordinate systems to the World system and restores them on undo', () => {
    const doc = new Document();
    const history = new CommandHistory(doc);
    doc.addNamedWorkPlane(wp(1), 'UCS A');
    doc.addNamedWorkPlane(wp(2), 'UCS B');
    const before = captureWorkPlanes(doc);
    expect(doc.namedWorkPlanes).toHaveLength(2);
    expect(doc.activeNamedWorkPlaneId).not.toBeNull();

    // Importing a drawing wipes the previous UCS — this is that step.
    history.execute(new SetWorkPlanesEdit('Import coordinate systems', before, worldWorkPlaneState()));
    expect(doc.namedWorkPlanes).toHaveLength(0);
    expect(doc.activeNamedWorkPlaneId).toBeNull();

    // Undo brings the whole UCS list back — it is part of the document's history.
    expect(history.undo()).toBe(true);
    expect(doc.namedWorkPlanes.map((plane) => plane.name)).toEqual(['UCS A', 'UCS B']);
    expect(doc.activeNamedWorkPlaneId).toBe(before.activeNamedWorkPlaneId);
  });

  it('deep-clones so later document edits do not leak into the snapshot', () => {
    const doc = new Document();
    doc.addNamedWorkPlane(wp(5), 'UCS A');
    const snapshot = captureWorkPlanes(doc);
    doc.namedWorkPlanes[0].workPlane.origin.x = 999;
    expect(snapshot.namedWorkPlanes[0].workPlane.origin.x).toBe(5);
  });
});
