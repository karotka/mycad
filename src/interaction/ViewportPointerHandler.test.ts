import { describe, expect, it } from 'vitest';
import { isWorldPlane, ucsCursorLegEndpoints } from './ViewportPointerHandler';
import { WORLD_WORK_PLANE, type WorkPlane } from '../math/workplane';
import type { Vec2, Vec3 } from '../math/geometry';

const CENTER = 36; // matches UCS_CURSOR_CENTER — the SVG's own 72x72 canvas middle.
const LEG = 30; // matches UCS_CURSOR_LEG_LENGTH.

/** A camera looking straight down world Z: world (x, y, *) -> screen (x, -y),
 *  the usual screen-space Y flip. An axis pointing along Z is edge-on under
 *  this view (probing it moves nothing in x/y), which is deliberately used
 *  below to exercise the "collapses to the centre" case. */
function lookingDownZ(point: Vec3): Vec2 | null {
  return { x: point.x, y: -point.y };
}

describe('ucsCursorLegEndpoints', () => {
  it('draws X to the right and Y up, Z edge-on, for the plain WCS looked at from above', () => {
    const legs = ucsCursorLegEndpoints(WORLD_WORK_PLANE, { x: 5, y: -3, z: 2 }, lookingDownZ, 1);
    expect(legs).not.toBeNull();
    expect(legs!.x).toEqual({ x: CENTER + LEG, y: CENTER });
    // World +Y -> screen -Y (up on screen, in this mock's convention).
    expect(legs!.y).toEqual({ x: CENTER, y: CENTER - LEG });
    // Z points straight at/away from the camera: no x/y change at all.
    expect(legs!.z).toEqual({ x: CENTER, y: CENTER });
    expect(legs!.anyVisible).toBe(true);
  });

  it('rotates its legs with a tilted plane, not just the WCS', () => {
    // A plane whose own X axis is world Z (e.g. a UCS on a side face) —
    // under the same "looking down world Z" camera, that leg is now the
    // one that goes edge-on, and world Z's old edge-on axis (now the
    // plane's own Y or Z) picks up a real screen direction instead.
    const tilted: WorkPlane = {
      origin: { x: 0, y: 0, z: 0 },
      xAxis: { x: 0, y: 0, z: 1 },
      yAxis: { x: 0, y: 1, z: 0 },
      zAxis: { x: -1, y: 0, z: 0 },
    };
    const legs = ucsCursorLegEndpoints(tilted, { x: 0, y: 0, z: 0 }, lookingDownZ, 1);
    expect(legs).not.toBeNull();
    // Plane X (world Z) is now the edge-on one.
    expect(legs!.x).toEqual({ x: CENTER, y: CENTER });
    // Plane Y (world Y) is unchanged from the first test.
    expect(legs!.y).toEqual({ x: CENTER, y: CENTER - LEG });
    // Plane Z (world -X) now draws a real leg, pointing left.
    expect(legs!.z).toEqual({ x: CENTER - LEG, y: CENTER });
  });

  it('is hidden entirely when the cursor point itself does not project (behind the camera, off the far plane)', () => {
    const legs = ucsCursorLegEndpoints(WORLD_WORK_PLANE, { x: 0, y: 0, z: 0 }, () => null, 1);
    expect(legs).toBeNull();
  });

  it('collapses one axis to the centre without hiding the whole cross, when only that axis fails to project', () => {
    const project = (point: Vec3): Vec2 | null => {
      // The Z-probe point specifically (world z != 0, since the probe
      // moves along zAxis from a cursor at the origin) fails to project;
      // X and Y still resolve normally.
      if (Math.abs(point.z) > 1e-9) return null;
      return lookingDownZ(point);
    };
    const legs = ucsCursorLegEndpoints(WORLD_WORK_PLANE, { x: 0, y: 0, z: 0 }, project, 1);
    expect(legs).not.toBeNull();
    expect(legs!.z).toEqual({ x: CENTER, y: CENTER });
    expect(legs!.x).toEqual({ x: CENTER + LEG, y: CENTER });
    expect(legs!.anyVisible).toBe(true);
  });

  it('reports invisible only when every single axis is edge-on', () => {
    // An orthonormal 3-axis frame can have at most one axis parallel to any
    // given real view direction, so this degenerate "all three edge-on"
    // case cannot happen with a genuine camera — simulated directly here
    // (every probe point projects to the exact same point as the centre)
    // purely to confirm anyVisible really does turn off in that case,
    // rather than being hardcoded true.
    const legs = ucsCursorLegEndpoints(WORLD_WORK_PLANE, { x: 1, y: 2, z: 3 }, () => ({ x: 1, y: 2 }), 1);
    expect(legs).not.toBeNull();
    expect(legs!.anyVisible).toBe(false);
    expect(legs!.x).toEqual({ x: CENTER, y: CENTER });
    expect(legs!.y).toEqual({ x: CENTER, y: CENTER });
    expect(legs!.z).toEqual({ x: CENTER, y: CENTER });
  });

  it('always draws a leg exactly LEG pixels long, regardless of the probe distance', () => {
    const far = ucsCursorLegEndpoints(WORLD_WORK_PLANE, { x: 0, y: 0, z: 0 }, lookingDownZ, 1000);
    const near = ucsCursorLegEndpoints(WORLD_WORK_PLANE, { x: 0, y: 0, z: 0 }, lookingDownZ, 0.001);
    expect(far!.x).toEqual({ x: CENTER + LEG, y: CENTER });
    expect(near!.x).toEqual({ x: CENTER + LEG, y: CENTER });
  });
});

describe('isWorldPlane', () => {
  it('recognises the plain WCS, including a fresh clone carrying the same values', () => {
    expect(isWorldPlane(WORLD_WORK_PLANE)).toBe(true);
    expect(isWorldPlane({
      origin: { x: 0, y: 0, z: 0 },
      xAxis: { x: 1, y: 0, z: 0 },
      yAxis: { x: 0, y: 1, z: 0 },
      zAxis: { x: 0, y: 0, z: 1 },
    })).toBe(true);
  });

  it('rejects a plane with a shifted origin', () => {
    expect(isWorldPlane({ ...WORLD_WORK_PLANE, origin: { x: 5, y: 0, z: 0 } })).toBe(false);
  });

  it('rejects a plane turned onto a different axis (a named or dynamic UCS)', () => {
    const tilted: WorkPlane = {
      origin: { x: 0, y: 0, z: 0 },
      xAxis: { x: 0, y: 0, z: 1 },
      yAxis: { x: 0, y: 1, z: 0 },
      zAxis: { x: -1, y: 0, z: 0 },
    };
    expect(isWorldPlane(tilted)).toBe(false);
  });
});
