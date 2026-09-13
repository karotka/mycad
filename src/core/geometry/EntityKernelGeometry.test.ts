import { describe, expect, it } from 'vitest';
import type { Vec2 } from '../../math/geometry';
import type { WorkPlane } from '../../math/workplane';
import type { ArcEntity, BezierEntity } from '../entities/types';
import { entityKernelPath, entityKernelProfile } from './EntityKernelGeometry';

const base = { id: 'e1', layer: '0', aci: 256, color: 0xffffff, selected: false };
const elevated = (x: number, y: number, z: number): Vec2 => ({ x, y, z }) as Vec2;
const plane: WorkPlane = {
  origin: { x: 10, y: 20, z: 30 },
  xAxis: { x: 0, y: 1, z: 0 },
  yAxis: { x: 0, y: 0, z: 1 },
  zAxis: { x: 1, y: 0, z: 0 },
};

describe('entityKernelPath', () => {
  it('keeps every Bezier pole elevation while placing it through its work plane', () => {
    const curve: BezierEntity = {
      ...base,
      type: 'bezier',
      start: elevated(1, 2, 3),
      segments: [{
        control1: elevated(2, 3, 4),
        control2: elevated(3, 4, 5),
        end: elevated(4, 5, 6),
      }],
    };

    expect(entityKernelPath(curve, plane)).toEqual([{
      kind: 'bezier',
      poles: [
        { x: 13, y: 21, z: 32 },
        { x: 14, y: 22, z: 33 },
        { x: 15, y: 23, z: 34 },
        { x: 16, y: 24, z: 35 },
      ],
    }]);
  });

  it('keeps arcs analytic and carries an elevated center into world space', () => {
    const arc: ArcEntity = {
      ...base,
      type: 'arc', center: elevated(2, 3, 4), radius: 5,
      startAngle: 0.25, sweepAngle: 1.5,
    };

    expect(entityKernelPath(arc, plane)).toEqual([{
      kind: 'arc', center: { x: 14, y: 22, z: 33 },
      normal: plane.zAxis, xAxis: plane.xAxis,
      radius: 5, startAngle: 0.25, sweepAngle: 1.5,
    }]);
  });
});

describe('entityKernelProfile', () => {
  it('uses exact connected Bezier edges for a closed profile', () => {
    const loop: BezierEntity = {
      ...base,
      type: 'bezier', start: { x: 0, y: 0 },
      segments: [
        { control1: { x: 1, y: 0 }, control2: { x: 2, y: 0 }, end: { x: 3, y: 0 } },
        { control1: { x: 2, y: 1 }, control2: { x: 1, y: 1 }, end: { x: 0, y: 0 } },
      ],
    };

    const profile = entityKernelProfile(loop, plane);
    expect(profile?.kind).toBe('wire');
    if (!profile || profile.kind !== 'wire') return;
    expect(profile.edges).toHaveLength(2);
    expect(profile.edges[0].kind).toBe('bezier');
    expect(profile.edges[1].kind).toBe('bezier');
    if (profile.edges[0].kind !== 'bezier' || profile.edges[1].kind !== 'bezier') return;
    expect(profile.edges[1].poles[0]).toEqual(profile.edges[0].poles[3]);
    expect(profile.edges[1].poles[3]).toEqual(profile.edges[0].poles[0]);
  });

  it('rejects an open Bezier as a solid sweep profile', () => {
    const open: BezierEntity = {
      ...base,
      type: 'bezier', start: { x: 0, y: 0 },
      segments: [{ control1: { x: 1, y: 0 }, control2: { x: 2, y: 0 }, end: { x: 3, y: 0 } }],
    };
    expect(entityKernelProfile(open, plane)).toBeNull();
  });
});
