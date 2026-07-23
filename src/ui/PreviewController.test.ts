import { describe, expect, it, vi } from 'vitest';
import { PreviewController } from './PreviewController';

function element() {
  return { textContent: '', style: { left: '', top: '' }, hidden: true, dataset: {} } as unknown as HTMLElement;
}

describe('PreviewController', () => {
  it('owns preview state and resets all transient markers', () => {
    const dimension = element(), origin = element(), target = element(), snap = element();
    const controller = new PreviewController(dimension, origin, target, snap);
    controller.setPreview({ type: 'line', data: {} });
    controller.showMarker(origin, 10, 20);
    controller.showMarker(target, 30, 40);
    controller.showSnap({ x: 1, y: 2, z: 3 }, 50, 60);

    controller.reset();

    expect(controller.preview).toBeUndefined();
    expect([origin.hidden, target.hidden, snap.hidden]).toEqual([true, true, true]);
  });

  const active = (name: string, stepIndex: number, data: Record<string, unknown>) =>
    ({ name, stepIndex, data, steps: [] }) as unknown as Parameters<PreviewController['update']>[0];

  const previewOf = (command: ReturnType<typeof active>, cursor: { x: number; y: number }) => {
    const controller = new PreviewController(element(), element(), element(), element());
    controller.update(command, cursor, null);
    return controller.preview;
  };

  it('previews every settled polyline segment, not only the one being dragged', () => {
    const vertices = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 5 }];
    const preview = previewOf(active('POLYLINE', 1, { vertices, start: vertices[2] }), { x: 4, y: 5 });
    // Until the command ends there is no polyline entity, so a preview of just
    // the last segment is the whole drawing disappearing while it is drawn.
    expect(preview).toEqual({ type: 'polyline', data: { vertices, cursor: { x: 4, y: 5 } } });
  });

  it('has nothing to preview before the polyline has a first vertex', () => {
    expect(previewOf(active('POLYLINE', 0, { vertices: [] }), { x: 4, y: 5 })).toBeUndefined();
  });

  it('previews the radial base of every round primitive, including TORUS', () => {
    for (const name of ['CYLINDER', 'SPHERE', 'CONE', 'PYRAMID', 'TORUS']) {
      expect(previewOf(
        active(name, 1, { center: { x: 2, y: 3 } }),
        { x: 7, y: 3 },
      )).toEqual({
        type: 'circle',
        data: { center: { x: 2, y: 3 }, cursor: { x: 7, y: 3 } },
      });
    }
  });

  it('carries the moving objects in the move preview so they ride under the cursor', () => {
    const line = { id: 'l1', type: 'line', layer: '0', aci: 256, color: 0xffffff, selected: true, start: { x: 0, y: 0 }, end: { x: 10, y: 0 } };
    const preview = previewOf(active('MOVE', 2, { basePoint: { x: 0, y: 0 }, entities: [line] }), { x: 5, y: 3 });
    expect(preview?.type).toBe('move');
    const data = preview?.data as { entities: Array<{ start: { x: number; y: number }; end: { x: number; y: number }; color: number; selected: boolean }> };
    // The ghost is the selection shifted by the drag delta (5, 3), recoloured so
    // it reads as a preview and not as another selected object.
    expect(data.entities).toHaveLength(1);
    expect(data.entities[0].start).toEqual({ x: 5, y: 3 });
    expect(data.entities[0].end).toEqual({ x: 15, y: 3 });
    expect(data.entities[0].selected).toBe(false);
  });

  it('draws the dimension while the second point is still being picked', () => {
    const preview = previewOf(active('MEASURE', 1, { start: { x: 0, y: 0 } }), { x: 10, y: 0 });
    const data = preview?.data as { start: unknown; end: unknown; offset: unknown; rotation: number };
    // The cursor is the second point *and* stands in for the not-yet-chosen
    // location, so the dimension lies on the points and reads them.
    expect(data.end).toEqual({ x: 10, y: 0 });
    expect(data.offset).toEqual({ x: 10, y: 0 });
    expect(data.rotation).toBe(0);
  });

  it('keeps the settled points once the dimension line is being placed', () => {
    const preview = previewOf(
      active('MEASURE', 2, { start: { x: 0, y: 0 }, end: { x: 10, y: 0 } }),
      { x: 4, y: 9 },
    );
    const data = preview?.data as { end: unknown; offset: unknown };
    expect(data.end).toEqual({ x: 10, y: 0 });
    expect(data.offset).toEqual({ x: 4, y: 9 });
  });

  it('moves the visible dimension text with the cursor in the final placement step', () => {
    const preview = previewOf(
      active('DIMALIGNED', 3, {
        start: { x: 0, y: 0 },
        end: { x: 10, y: 0 },
        offset: { x: 5, y: 6 },
      }),
      { x: 13, y: 9 },
    );
    expect(preview).toMatchObject({
      type: 'dimension',
      data: {
        kind: 'aligned',
        offset: { x: 5, y: 6 },
        textPosition: { x: 13, y: 9 },
      },
    });
  });

  it('previews a solid-edge radius dimension in the circular edge plane', () => {
    const workPlane = {
      origin: { x: 0, y: 0, z: 10 },
      xAxis: { x: 1, y: 0, z: 0 },
      yAxis: { x: 0, y: 1, z: 0 },
      zAxis: { x: 0, y: 0, z: 1 },
    };
    const preview = previewOf(
      active('DIMRADIUS', 1, {
        radialSource: { center: { x: 0, y: 0 }, radius: 3, workPlane },
      }),
      { x: 6, y: 0 },
    );
    expect(preview).toMatchObject({
      type: 'dimension',
      data: {
        start: { x: 0, y: 0 },
        end: { x: 3, y: 0 },
        offset: { x: 6, y: 0 },
        kind: 'radius',
        workPlane,
      },
    });
  });

  it('keeps the angular arc fixed while its text follows the final cursor', () => {
    const workPlane = {
      origin: { x: 1, y: 2, z: 3 },
      xAxis: { x: 1, y: 0, z: 0 },
      yAxis: { x: 0, y: 0, z: 1 },
      zAxis: { x: 0, y: -1, z: 0 },
    };
    const preview = previewOf(
      active('DIMANGULAR', 6, {
        angularSource: {
          workPlane,
          vertex: { x: 0, y: 0 },
          first: { x: 10, y: 0 },
          second: { x: 0, y: 10 },
        },
        angularArcPoint: { x: 4, y: 4 },
      }),
      { x: 8, y: 7 },
    );
    expect(preview).toMatchObject({
      type: 'dimension',
      data: {
        kind: 'angular',
        arcPoint: { x: 4, y: 4 },
        textPosition: { x: 8, y: 7 },
        workPlane,
      },
    });
  });

  it('uses a projected 3D position for the snap marker', () => {
    const snap = element();
    const project = vi.fn(() => ({ x: 12, y: 34 }));
    const controller = new PreviewController(element(), element(), element(), snap, project);
    controller.showSnap({ x: 1, y: 2, z: 3 }, 90, 80);
    expect(snap.style.left).toBe('12px');
    expect(snap.style.top).toBe('34px');
  });
});
