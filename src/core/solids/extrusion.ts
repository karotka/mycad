import { cloneEntity, type Entity, type ExtrusionFeature } from '../entities/types';
import { cloneWorkPlane, WORLD_WORK_PLANE } from '../../math/workplane';

/**
 * Which way a linear dimension measures, from where its line was pulled: drag it
 * up or down and it reads the horizontal distance, drag it aside and it reads the
 * vertical one. This is what AutoCAD does while you place it.
 */
/**
 * A profile pushed through a height, signed.
 *
 * A negative height used to be thrown away by `Math.abs`, on the reasoning that
 * an extrusion is a distance along the work plane's positive Z and a direction
 * is the UCS's business. But asking for -10 and being handed +10 is not a
 * convention, it is the app disagreeing with you in silence — and every CAD
 * program in the world extrudes downwards for a negative height.
 *
 * Manifold only extrudes along +Z, so downwards is the same prism built upwards
 * and dropped by its own height. `transform.translateZ` already existed for
 * exactly this kind of thing, and regeneration already honours it.
 */
export function extrusionFeature(profile: Entity, height: number): ExtrusionFeature {
  return {
    kind: 'extrusion',
    profile: cloneEntity(profile),
    height: Math.abs(height),
    // Cloned: the fallback is a shared constant, and a feature holding it would
    // hand every extrusion in the document the same work plane object.
    workPlane: cloneWorkPlane(profile.workPlane ?? WORLD_WORK_PLANE),
    transform: { translateX: 0, translateY: 0, scaleX: 1, scaleY: 1, translateZ: height < 0 ? height : 0 },
  };
}
