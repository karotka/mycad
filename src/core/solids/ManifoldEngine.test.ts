import { describe, expect, it } from 'vitest';
import type { ExtrusionFeature } from '../entities/types';
import { createBoxMesh, pressPullFace, regenerateSolidFeature } from './ManifoldEngine';

describe('parametric solid regeneration', () => {
  it('moves a selected side face along its normal', () => {
    const mesh = createBoxMesh(10, 6, 4);
    const changed = pressPullFace(mesh, [1, 2, 5, 6], { x: 1, y: 0, z: 0 }, 3);
    expect(changed).not.toBeNull();
    expect(changed!.positions[3]).toBeCloseTo(8);
    expect(changed!.positions[0]).toBeCloseTo(-5);
  });

  it('regenerates an extrusion from profile, transform and height', async () => {
    const feature: ExtrusionFeature = {
      kind: 'extrusion',
      profile: {
        id: 'circle_profile', type: 'circle', layer: '0', color: 0xffffff, selected: false,
        center: { x: 0, y: 0 }, radius: 2,
      },
      height: 5,
      transform: { translateX: 10, translateY: -3, scaleX: 2, scaleY: 0.5 },
    };
    const mesh = await regenerateSolidFeature(feature);
    expect(mesh).not.toBeNull();
    const positions = mesh!.positions;
    const xs: number[] = [], ys: number[] = [], zs: number[] = [];
    for (let i = 0; i < positions.length; i += 3) {
      xs.push(positions[i]); ys.push(positions[i + 1]); zs.push(positions[i + 2]);
    }
    expect(Math.min(...xs)).toBeCloseTo(6, 4);
    expect(Math.max(...xs)).toBeCloseTo(14, 4);
    expect(Math.min(...ys)).toBeCloseTo(-4, 4);
    expect(Math.max(...ys)).toBeCloseTo(-2, 4);
    expect(Math.min(...zs)).toBeCloseTo(0, 4);
    expect(Math.max(...zs)).toBeCloseTo(5, 4);
  });
});
