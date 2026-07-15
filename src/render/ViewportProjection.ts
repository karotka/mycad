import * as THREE from 'three';
import type { Vec2, Vec3 } from '../math/geometry';
import { worldToLocal, type WorkPlane } from '../math/workplane';

type Camera = THREE.PerspectiveCamera | THREE.OrthographicCamera;

export class ViewportProjection {
  private readonly raycaster = new THREE.Raycaster();
  private readonly mouse = new THREE.Vector2();

  constructor(private readonly camera: () => Camera, private readonly target: () => THREE.Vector3) {}

  projectCadPoint(canvas: HTMLCanvasElement, point: Vec3): Vec2 | null {
    const rect = canvas.getBoundingClientRect();
    const projected = new THREE.Vector3(point.x, point.z, -point.y).project(this.camera());
    if (projected.z < -1 || projected.z > 1) return null;
    return { x: (projected.x + 1) * rect.width / 2, y: (1 - projected.y) * rect.height / 2 };
  }

  groundPoint(canvas: HTMLCanvasElement, sx: number, sy: number): Vec2 | null {
    this.setRay(canvas, sx, sy);
    const hit = new THREE.Vector3();
    if (!this.raycaster.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), hit)) return null;
    return { x: hit.x, y: -hit.z };
  }

  workPlanePoint(canvas: HTMLCanvasElement, sx: number, sy: number, plane: WorkPlane): Vec2 | null {
    this.setRay(canvas, sx, sy);
    const normal = new THREE.Vector3(plane.zAxis.x, plane.zAxis.z, -plane.zAxis.y);
    const origin = new THREE.Vector3(plane.origin.x, plane.origin.z, -plane.origin.y);
    const hit = new THREE.Vector3();
    if (!this.raycaster.ray.intersectPlane(new THREE.Plane().setFromNormalAndCoplanarPoint(normal, origin), hit)) return null;
    const local = worldToLocal(plane, { x: hit.x, y: -hit.z, z: hit.y });
    return { x: local.x, y: local.y };
  }

  viewPlanePoint(canvas: HTMLCanvasElement, sx: number, sy: number): Vec2 | null {
    this.setRay(canvas, sx, sy);
    const normal = new THREE.Vector3();
    this.camera().getWorldDirection(normal);
    const target = this.target();
    const hit = new THREE.Vector3();
    if (!this.raycaster.ray.intersectPlane(new THREE.Plane().setFromNormalAndCoplanarPoint(normal, target), hit)) return null;
    const offset = hit.sub(target);
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(this.camera().quaternion);
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(this.camera().quaternion);
    return { x: offset.dot(right), y: offset.dot(up) };
  }

  cadPointToViewPlane(point: Vec3): Vec2 {
    const offset = new THREE.Vector3(point.x, point.z, -point.y).sub(this.target());
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(this.camera().quaternion);
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(this.camera().quaternion);
    return { x: offset.dot(right), y: offset.dot(up) };
  }

  private setRay(canvas: HTMLCanvasElement, sx: number, sy: number): void {
    const rect = canvas.getBoundingClientRect();
    this.mouse.set(((sx - rect.left) / rect.width) * 2 - 1, -((sy - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(this.mouse, this.camera());
  }
}
