import * as THREE from 'three';
import type { Vec2, Vec3 } from '../math/geometry';

type Camera = THREE.PerspectiveCamera | THREE.OrthographicCamera;

export function chooseObjectId(
  hitObjects: readonly THREE.Object3D[],
  objects: ReadonlyMap<string, THREE.Object3D>,
  excludedIds: ReadonlySet<string>,
): string | null {
  let fallback: string | null = null;
  for (const hit of hitObjects) {
    for (const [id, object] of objects) {
      if (object !== hit) continue;
      fallback ??= id;
      if (!excludedIds.has(id)) return id;
    }
  }
  return fallback;
}

export function closestProjectedIndex(
  cursor: Vec2,
  points: ReadonlyArray<{ x: number; y: number; z: number; index: number }>,
  tolerance: number,
): number {
  let best = -1;
  let bestDistance = tolerance;
  for (const point of points) {
    if (point.z < -1 || point.z > 1) continue;
    const distance = Math.hypot(cursor.x - point.x, cursor.y - point.y);
    if (distance <= bestDistance) {
      bestDistance = distance;
      best = point.index;
    }
  }
  return best;
}

export class ViewportPicking {
  private readonly raycaster = new THREE.Raycaster();
  private readonly mouse = new THREE.Vector2();

  constructor(private readonly camera: () => Camera) {}

  firstIntersection(canvas: HTMLCanvasElement, sx: number, sy: number, objects: Iterable<THREE.Object3D>): THREE.Intersection | null {
    this.setRay(canvas, sx, sy);
    return this.raycaster.intersectObjects(Array.from(objects))[0] ?? null;
  }

  pickObjectId(
    canvas: HTMLCanvasElement,
    sx: number,
    sy: number,
    objects: ReadonlyMap<string, THREE.Object3D>,
    excludedIds: ReadonlySet<string> = new Set(),
  ): string | null {
    this.setRay(canvas, sx, sy);
    const hits = this.raycaster.intersectObjects(Array.from(objects.values()));
    return chooseObjectId(hits.map((hit) => hit.object), objects, excludedIds);
  }

  pickGripIndex(
    canvas: HTMLCanvasElement,
    grips: Array<{ point: Vec2 & { z?: number }; index: number }>,
    sx: number,
    sy: number,
    tolerance: number,
  ): number {
    const rect = canvas.getBoundingClientRect();
    const points = grips.map((grip) => {
      const projected = new THREE.Vector3(grip.point.x, grip.point.z ?? 0, -grip.point.y).project(this.camera());
      return {
        x: rect.left + (projected.x + 1) * rect.width / 2,
        y: rect.top + (1 - projected.y) * rect.height / 2,
        z: projected.z,
        index: grip.index,
      };
    });
    return closestProjectedIndex({ x: sx, y: sy }, points, tolerance);
  }

  /**
   * The ray under the pointer, in CAD coordinates rather than the scene's —
   * the caller reasons about the model, and three's Y-up is this file's problem
   * to keep. An orthographic camera puts the origin at the near plane and the
   * direction is the view direction; both come out of setFromCamera already.
   */
  pointerRay(canvas: HTMLCanvasElement, sx: number, sy: number): { origin: Vec3; direction: Vec3 } {
    this.setRay(canvas, sx, sy);
    const { origin, direction } = this.raycaster.ray;
    return {
      origin: { x: origin.x, y: -origin.z, z: origin.y },
      direction: { x: direction.x, y: -direction.z, z: direction.y },
    };
  }

  private setRay(canvas: HTMLCanvasElement, sx: number, sy: number): void {
    const rect = canvas.getBoundingClientRect();
    this.mouse.set(((sx - rect.left) / rect.width) * 2 - 1, -((sy - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(this.mouse, this.camera());
  }
}
