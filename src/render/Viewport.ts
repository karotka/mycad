import * as THREE from 'three';
import type { Document } from '../core/Document';
import type { Entity, Solid, SolidFaceSelection } from '../core/entities/types';
import { entityBounds, getEntityPoints } from '../core/entities/types';
import type { Vec2, Vec3 } from '../math/geometry';
import { worldToScreen } from '../math/geometry';
import { cloneWorkPlane, localToWorld, WORLD_WORK_PLANE, worldToLocal, type WorkPlane } from '../math/workplane';

export class Canvas2DRenderer {
  private ctx: CanvasRenderingContext2D;
  pan: Vec2 = { x: 0, y: 0 };
  zoom = 20;

  constructor(private canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D not supported');
    this.ctx = ctx;
  }

  resize(w: number, h: number): void {
    this.canvas.width = w * devicePixelRatio;
    this.canvas.height = h * devicePixelRatio;
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
    this.ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
  }

  clear(w: number, h: number): void {
    this.ctx.fillStyle = '#0d1117';
    this.ctx.fillRect(0, 0, w, h);
  }

  drawGrid(w: number, h: number, gridSize: number): void {
    if (!Number.isFinite(gridSize) || gridSize <= 0) return;
    const topLeft = this.screenToWorld(0, 0, w, h);
    const bottomRight = this.screenToWorld(w, h, w, h);

    const startX = Math.floor(topLeft.x / gridSize) * gridSize;
    const endX = Math.ceil(bottomRight.x / gridSize) * gridSize;
    const startY = Math.floor(bottomRight.y / gridSize) * gridSize;
    const endY = Math.ceil(topLeft.y / gridSize) * gridSize;

    this.ctx.strokeStyle = '#1c2333';
    this.ctx.lineWidth = 1;

    for (let x = startX; x <= endX; x += gridSize) {
      const s = worldToScreen({ x, y: 0 }, w, h, this.pan, this.zoom);
      this.ctx.beginPath();
      this.ctx.moveTo(s.x, 0);
      this.ctx.lineTo(s.x, h);
      this.ctx.stroke();
    }

    for (let y = startY; y <= endY; y += gridSize) {
      const s = worldToScreen({ x: 0, y }, w, h, this.pan, this.zoom);
      this.ctx.beginPath();
      this.ctx.moveTo(0, s.y);
      this.ctx.lineTo(w, s.y);
      this.ctx.stroke();
    }

    // axes
    const ox = worldToScreen({ x: 0, y: 0 }, w, h, this.pan, this.zoom);
    this.ctx.strokeStyle = '#334155';
    this.ctx.beginPath();
    this.ctx.moveTo(0, ox.y);
    this.ctx.lineTo(w, ox.y);
    this.ctx.moveTo(ox.x, 0);
    this.ctx.lineTo(ox.x, h);
    this.ctx.stroke();
  }

  screenToWorld(sx: number, sy: number, w: number, h: number): Vec2 {
    const cx = w / 2;
    const cy = h / 2;
    return {
      x: (sx - cx) / this.zoom + this.pan.x,
      y: -(sy - cy) / this.zoom + this.pan.y,
    };
  }

  render(
    doc: Document,
    w: number,
    h: number,
    preview?: { type: string; data: unknown },
    grips: Array<{ point: Vec2; hot: boolean; shape?: 'square' | 'edge' }> = []
  ): void {
    this.clear(w, h);
    this.drawGrid(w, h, doc.gridSize);

    for (const solid of doc.solids) {
      this.drawSolidProjection(solid, w, h);
    }

    for (const entity of doc.entities) {
      this.drawEntity(entity, w, h, entity.selected);
    }

    if (preview) this.drawPreview(preview, w, h);
    this.drawGrips(grips, w, h);
  }

  private drawSolidProjection(solid: Solid, w: number, h: number): void {
    const positions = solid.mesh.positions;
    const indices = solid.mesh.indices;
    this.ctx.strokeStyle = solid.selected ? '#65c7ff' : '#ffffff';
    this.ctx.lineWidth = 1;
    this.ctx.beginPath();
    for (let i = 0; i < indices.length; i += 3) {
      const triangle = [indices[i], indices[i + 1], indices[i + 2], indices[i]];
      for (let j = 0; j < triangle.length; j++) {
        const index = triangle[j] * 3;
        const point = worldToScreen(
          { x: positions[index], y: positions[index + 1] },
          w, h, this.pan, this.zoom
        );
        if (j === 0) this.ctx.moveTo(point.x, point.y);
        else this.ctx.lineTo(point.x, point.y);
      }
    }
    this.ctx.stroke();
  }

  private drawGrips(grips: Array<{ point: Vec2; hot: boolean; shape?: 'square' | 'edge' }>, w: number, h: number): void {
    for (const grip of grips) {
      const p = worldToScreen(grip.point, w, h, this.pan, this.zoom);
      const size = grip.hot ? 10 : 8;
      this.ctx.fillStyle = grip.hot ? '#ff4d4d' : '#0d1117';
      this.ctx.strokeStyle = grip.hot ? '#ffffff' : '#00aaff';
      this.ctx.lineWidth = 1.5;
      const gripWidth = grip.shape === 'edge' ? size + 5 : size;
      const gripHeight = grip.shape === 'edge' ? Math.max(5, size - 3) : size;
      this.ctx.fillRect(p.x - gripWidth / 2, p.y - gripHeight / 2, gripWidth, gripHeight);
      this.ctx.strokeRect(p.x - gripWidth / 2, p.y - gripHeight / 2, gripWidth, gripHeight);
    }
  }

  private colorHex(c: number, selected: boolean): string {
    if (selected) return '#65c7ff';
    return `#${c.toString(16).padStart(6, '0')}`;
  }

  private drawEntity(entity: Entity, w: number, h: number, selected: boolean): void {
    this.ctx.strokeStyle = this.colorHex(entity.color, selected);
    this.ctx.fillStyle = this.colorHex(entity.color, selected);
    this.ctx.lineWidth = 1;

    switch (entity.type) {
      case 'line': {
        const a = worldToScreen(entity.start, w, h, this.pan, this.zoom);
        const b = worldToScreen(entity.end, w, h, this.pan, this.zoom);
        this.ctx.beginPath();
        this.ctx.moveTo(a.x, a.y);
        this.ctx.lineTo(b.x, b.y);
        this.ctx.stroke();
        break;
      }
      case 'circle': {
        const c = worldToScreen(entity.center, w, h, this.pan, this.zoom);
        const r = entity.radius * this.zoom;
        this.ctx.beginPath();
        this.ctx.arc(c.x, c.y, r, 0, Math.PI * 2);
        this.ctx.stroke();
        break;
      }
      case 'rectangle': {
        const first = worldToScreen(entity.first, w, h, this.pan, this.zoom);
        const opposite = worldToScreen(entity.opposite, w, h, this.pan, this.zoom);
        this.ctx.strokeRect(first.x, first.y, opposite.x - first.x, opposite.y - first.y);
        break;
      }
      case 'octagon':
      case 'polyline': {
        const verts = entity.type === 'octagon' ? entity.vertices : entity.vertices;
        if (verts.length < 2) break;
        this.ctx.beginPath();
        const first = worldToScreen(verts[0], w, h, this.pan, this.zoom);
        this.ctx.moveTo(first.x, first.y);
        for (let i = 1; i < verts.length; i++) {
          const p = worldToScreen(verts[i], w, h, this.pan, this.zoom);
          this.ctx.lineTo(p.x, p.y);
        }
        if (entity.type === 'octagon' || (entity.type === 'polyline' && entity.closed)) {
          this.ctx.closePath();
        }
        this.ctx.stroke();
        break;
      }
    }
  }

  private drawPreview(preview: { type: string; data: unknown }, w: number, h: number): void {
    this.ctx.strokeStyle = '#888888';
    this.ctx.setLineDash([4, 4]);
    this.ctx.lineWidth = 1;

    const d = preview.data as Record<string, Vec2 & { radius?: number }>;
    const polygonData = preview.data as { center?: Vec2; cursor?: Vec2; sides?: number };
    let label = '';
    let labelPoint: Vec2 | undefined;

    if (preview.type === 'line' && d.start && d.end) {
      const a = worldToScreen(d.start, w, h, this.pan, this.zoom);
      const b = worldToScreen(d.end, w, h, this.pan, this.zoom);
      this.ctx.beginPath();
      this.ctx.moveTo(a.x, a.y);
      this.ctx.lineTo(b.x, b.y);
      this.ctx.stroke();
      label = `L = ${Math.hypot(d.end.x - d.start.x, d.end.y - d.start.y).toFixed(2)} mm`;
      labelPoint = d.end;
    } else if (preview.type === 'circle' && d.center && d.cursor) {
      const r = Math.sqrt((d.cursor.x - d.center.x) ** 2 + (d.cursor.y - d.center.y) ** 2);
      const c = worldToScreen(d.center, w, h, this.pan, this.zoom);
      this.ctx.beginPath();
      this.ctx.arc(c.x, c.y, r * this.zoom, 0, Math.PI * 2);
      this.ctx.stroke();
      label = `R = ${r.toFixed(2)} mm`;
      labelPoint = d.cursor;
    } else if (preview.type === 'rectangle' && d.start && d.end) {
      const first = worldToScreen(d.start, w, h, this.pan, this.zoom);
      const opposite = worldToScreen(d.end, w, h, this.pan, this.zoom);
      this.ctx.strokeRect(first.x, first.y, opposite.x - first.x, opposite.y - first.y);
      label = `${Math.abs(d.end.x - d.start.x).toFixed(2)} × ${Math.abs(d.end.y - d.start.y).toFixed(2)} mm`;
      labelPoint = d.end;
    } else if (preview.type === 'octagon' && d.center && d.cursor) {
      const r = Math.hypot(d.cursor.x - d.center.x, d.cursor.y - d.center.y);
      const center = worldToScreen(d.center, w, h, this.pan, this.zoom);
      this.ctx.beginPath();
      for (let i = 0; i < 8; i++) {
        const angle = i * Math.PI / 4 + Math.PI / 8;
        const x = center.x + Math.cos(angle) * r * this.zoom;
        const y = center.y - Math.sin(angle) * r * this.zoom;
        if (i === 0) this.ctx.moveTo(x, y);
        else this.ctx.lineTo(x, y);
      }
      this.ctx.closePath();
      this.ctx.stroke();
      label = `R = ${r.toFixed(2)} mm`;
      labelPoint = d.cursor;
    } else if (preview.type === 'polygon' && polygonData.center && polygonData.cursor && polygonData.sides) {
      const { center, cursor, sides } = polygonData;
      const apothem = Math.hypot(cursor.x - center.x, cursor.y - center.y);
      const radius = apothem / Math.cos(Math.PI / sides);
      const normalAngle = Math.atan2(cursor.y - center.y, cursor.x - center.x);
      this.ctx.beginPath();
      for (let i = 0; i < sides; i++) {
        const angle = normalAngle + Math.PI / sides + i * Math.PI * 2 / sides;
        const point = worldToScreen({ x: center.x + Math.cos(angle) * radius, y: center.y + Math.sin(angle) * radius }, w, h, this.pan, this.zoom);
        if (i === 0) this.ctx.moveTo(point.x, point.y); else this.ctx.lineTo(point.x, point.y);
      }
      this.ctx.closePath();
      this.ctx.stroke();
      label = `a = ${apothem.toFixed(2)} mm · ${sides} sides`;
      labelPoint = cursor;
    }

    this.ctx.setLineDash([]);
    if (label && labelPoint) {
      const p = worldToScreen(labelPoint, w, h, this.pan, this.zoom);
      this.ctx.font = '12px SFMono-Regular, Menlo, monospace';
      const textWidth = this.ctx.measureText(label).width;
      this.ctx.fillStyle = 'rgba(13, 17, 23, 0.9)';
      this.ctx.fillRect(p.x + 12, p.y - 24, textWidth + 12, 20);
      this.ctx.fillStyle = '#9cdcfe';
      this.ctx.fillText(label, p.x + 18, p.y - 10);
    }
  }

  zoomExtents(doc: Document, w: number, h: number): void {
    let minX = -10, minY = -10, maxX = 10, maxY = 10;
    if (doc.entities.length > 0) {
      minX = Infinity; minY = Infinity; maxX = -Infinity; maxY = -Infinity;
      for (const e of doc.entities) {
        const b = entityBounds(e);
        minX = Math.min(minX, b.min.x);
        minY = Math.min(minY, b.min.y);
        maxX = Math.max(maxX, b.max.x);
        maxY = Math.max(maxY, b.max.y);
      }
    }
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    const span = Math.max(maxX - minX, maxY - minY, 1);
    this.pan = { x: cx, y: cy };
    this.zoom = Math.min(w, h) / (span * 1.4);
  }
}

export class Viewport3D {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera | THREE.OrthographicCamera;
  renderer: THREE.WebGLRenderer;
  private solidMeshes = new Map<string, THREE.Mesh>();
  private entityObjects = new Map<string, THREE.Line>();
  private previewObject: THREE.Line | null = null;
  private gripObjects: THREE.Points | null = null;
  private faceHighlight: THREE.Mesh | null = null;
  private grid: THREE.GridHelper;
  private raycaster = new THREE.Raycaster();
  private mouse = new THREE.Vector2();
  private isDragging = false;
  private lastX = 0;
  private lastY = 0;
  orbitTheta = Math.PI / 4;
  orbitPhi = Math.PI / 4;
  orbitRadius = 30;
  orbitTarget = new THREE.Vector3(0, 0, 0);
  activeStandardView: 'top' | 'front' | 'left' | 'right' | null = null;
  private viewportAspect = 1;
  private activeWorkPlane: WorkPlane = cloneWorkPlane(WORLD_WORK_PLANE);
  private visualStyle: 'wireframe' | 'shaded' = 'wireframe';

  constructor(container: HTMLElement) {
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x0d1117);

    this.camera = new THREE.PerspectiveCamera(50, 1, 0.1, 10000);
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(devicePixelRatio);
    container.appendChild(this.renderer.domElement);

    this.grid = new THREE.GridHelper(100, 100, 0x334155, 0x1c2333);
    this.scene.add(this.grid);

    const amb = new THREE.AmbientLight(0xffffff, 0.5);
    this.scene.add(amb);
    const dir = new THREE.DirectionalLight(0xffffff, 0.8);
    dir.position.set(10, 20, 10);
    this.scene.add(dir);

    const axes = new THREE.AxesHelper(5);
    this.scene.add(axes);

    this.updateCamera();
  }

  setWorkPlane(plane: WorkPlane): void {
    const toThree = (axis: { x: number; y: number; z: number }) => new THREE.Vector3(axis.x, axis.z, -axis.y);
    const oldX = toThree(this.activeWorkPlane.xAxis).normalize();
    const oldY = toThree(this.activeWorkPlane.yAxis).normalize();
    const oldZ = toThree(this.activeWorkPlane.zAxis).normalize();
    const newX = toThree(plane.xAxis).normalize();
    const newY = toThree(plane.yAxis).normalize();
    const newZ = toThree(plane.zAxis).normalize();
    const intoNewUcs = (vector: THREE.Vector3): THREE.Vector3 => new THREE.Vector3()
      .addScaledVector(newX, vector.dot(oldX))
      .addScaledVector(newY, vector.dot(oldY))
      .addScaledVector(newZ, vector.dot(oldZ));

    const cameraOffset = this.camera.position.clone().sub(this.orbitTarget);
    if (cameraOffset.lengthSq() > 1e-9) {
      const rotatedOffset = intoNewUcs(cameraOffset);
      const rotatedUp = intoNewUcs(this.camera.up).normalize();
      this.camera.position.copy(this.orbitTarget).add(rotatedOffset);
      this.camera.up.copy(rotatedUp);
      this.camera.lookAt(this.orbitTarget);
    }

    this.activeWorkPlane = cloneWorkPlane(plane);
    const matrix = new THREE.Matrix4().makeBasis(newX, newZ, newY);
    const origin = toThree(plane.origin);
    matrix.setPosition(origin);
    this.grid.matrixAutoUpdate = false;
    this.grid.matrix.copy(matrix);
    this.grid.updateMatrixWorld(true);
    this.render();
  }

  setVisualStyle(style: 'wireframe' | 'shaded'): void {
    this.visualStyle = style;
    for (const mesh of this.solidMeshes.values()) this.applySolidStyle(mesh, Boolean(mesh.userData.selected));
    this.render();
  }

  private disposeSolidEdges(mesh: THREE.Mesh): void {
    const edges = mesh.getObjectByName('solid-edges') as THREE.LineSegments | undefined;
    if (!edges) return;
    edges.geometry.dispose();
    (edges.material as THREE.Material).dispose();
    mesh.remove(edges);
  }

  private applySolidStyle(mesh: THREE.Mesh, selected: boolean): void {
    const material = mesh.material as THREE.MeshPhongMaterial;
    material.wireframe = this.visualStyle === 'wireframe';
    material.color.setHex(selected ? 0x65c7ff : this.visualStyle === 'wireframe' ? 0xffffff : 0xaeb9c4);
    material.shininess = this.visualStyle === 'wireframe' ? 0 : 18;
    this.disposeSolidEdges(mesh);
    if (this.visualStyle === 'shaded') {
      const edges = new THREE.LineSegments(
        new THREE.EdgesGeometry(mesh.geometry, 24),
        new THREE.LineBasicMaterial({ color: selected ? 0x9fe2ff : 0x27313a }),
      );
      edges.name = 'solid-edges';
      edges.renderOrder = 2;
      mesh.add(edges);
    }
    mesh.userData.styledVisualStyle = this.visualStyle;
    mesh.userData.styledSelected = selected;
    mesh.userData.styledRevision = mesh.userData.revision;
  }

  resize(w: number, h: number): void {
    this.viewportAspect = w / h;
    this.updateProjection();
    this.renderer.setSize(w, h);
  }

  updateCamera(): void {
    const x = this.orbitTarget.x + this.orbitRadius * Math.sin(this.orbitPhi) * Math.cos(this.orbitTheta);
    const y = this.orbitTarget.y + this.orbitRadius * Math.cos(this.orbitPhi);
    const z = this.orbitTarget.z + this.orbitRadius * Math.sin(this.orbitPhi) * Math.sin(this.orbitTheta);
    this.camera.position.set(x, y, z);
    this.camera.lookAt(this.orbitTarget);
    this.updateProjection();
  }

  setStandardView(view: 'top' | 'front' | 'left' | 'right'): void {
    this.switchToOrthographic();
    this.activeStandardView = view;
    const toThree = (axis: { x: number; y: number; z: number }) => new THREE.Vector3(axis.x, axis.z, -axis.y);
    const xAxis = toThree(this.activeWorkPlane.xAxis);
    const yAxis = toThree(this.activeWorkPlane.yAxis);
    const zAxis = toThree(this.activeWorkPlane.zAxis);
    let direction: THREE.Vector3;
    let up: THREE.Vector3;
    switch (view) {
      case 'top':
        direction = zAxis;
        up = yAxis;
        break;
      case 'front':
        direction = yAxis.clone().negate();
        up = zAxis;
        break;
      case 'left':
        direction = xAxis.clone().negate();
        up = zAxis;
        break;
      case 'right':
        direction = xAxis;
        up = zAxis;
        break;
    }
    this.camera.position.copy(this.orbitTarget).add(direction.normalize().multiplyScalar(this.orbitRadius));
    this.camera.up.copy(up.normalize());
    this.camera.lookAt(this.orbitTarget);
    this.updateProjection();
    this.render();
  }

  formatMoveDelta(delta: Vec2): string {
    const distance = Math.hypot(delta.x, delta.y);
    if (this.activeStandardView === 'top') return `ΔX ${delta.x.toFixed(2)} · ΔY ${delta.y.toFixed(2)} · ${distance.toFixed(2)} mm`;
    if (this.activeStandardView === 'front') return `ΔX ${delta.x.toFixed(2)} · ΔZ ${delta.y.toFixed(2)} · ${distance.toFixed(2)} mm`;
    if (this.activeStandardView === 'left') return `ΔY ${(-delta.x).toFixed(2)} · ΔZ ${delta.y.toFixed(2)} · ${distance.toFixed(2)} mm`;
    if (this.activeStandardView === 'right') return `ΔY ${delta.x.toFixed(2)} · ΔZ ${delta.y.toFixed(2)} · ${distance.toFixed(2)} mm`;
    return `Move ${distance.toFixed(2)} mm`;
  }

  private switchToOrthographic(): void {
    if (this.camera instanceof THREE.OrthographicCamera) return;
    this.camera = new THREE.OrthographicCamera();
    this.camera.near = 0.1;
    this.camera.far = 100000;
  }

  private switchToPerspective(): void {
    if (this.camera instanceof THREE.PerspectiveCamera) return;
    const position = this.camera.position.clone();
    this.camera = new THREE.PerspectiveCamera(50, this.viewportAspect, 0.1, 10000);
    this.camera.position.copy(position);
    this.camera.up.set(0, 1, 0);
    this.camera.lookAt(this.orbitTarget);
  }

  private updateProjection(): void {
    if (this.camera instanceof THREE.PerspectiveCamera) {
      this.camera.aspect = this.viewportAspect;
    } else {
      const halfHeight = Math.max(1, this.orbitRadius * 0.55);
      this.camera.left = -halfHeight * this.viewportAspect;
      this.camera.right = halfHeight * this.viewportAspect;
      this.camera.top = halfHeight;
      this.camera.bottom = -halfHeight;
    }
    this.camera.updateProjectionMatrix();
  }

  private orbitByScreenDelta(dx: number, dy: number): void {
    const offset = this.camera.position.clone().sub(this.orbitTarget);
    const ucsZ = new THREE.Vector3(
      this.activeWorkPlane.zAxis.x,
      this.activeWorkPlane.zAxis.z,
      -this.activeWorkPlane.zAxis.y,
    ).normalize();
    offset.applyAxisAngle(ucsZ, -dx * 0.01);
    const viewDirection = offset.clone().normalize().negate();
    const horizontalAxis = new THREE.Vector3()
      .crossVectors(viewDirection, ucsZ)
      .normalize();
    if (horizontalAxis.lengthSq() <= 0.000001) {
      horizontalAxis.set(
        this.activeWorkPlane.xAxis.x,
        this.activeWorkPlane.xAxis.z,
        -this.activeWorkPlane.xAxis.y,
      ).normalize();
    }
    offset.applyAxisAngle(horizontalAxis, -dy * 0.01);
    this.orbitRadius = offset.length();
    this.camera.position.copy(this.orbitTarget).add(offset);
    this.camera.up.copy(ucsZ);
    this.camera.lookAt(this.orbitTarget);
    this.updateProjection();
  }

  frameEntities(entities: Entity[]): void {
    if (entities.length === 0) {
      this.orbitTarget.set(0, 0, 0);
      this.orbitRadius = 30;
      this.updateCamera();
      return;
    }
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const entity of entities) {
      const bounds = entityBounds(entity);
      minX = Math.min(minX, bounds.min.x);
      minY = Math.min(minY, bounds.min.y);
      maxX = Math.max(maxX, bounds.max.x);
      maxY = Math.max(maxY, bounds.max.y);
    }
    const span = Math.max(maxX - minX, maxY - minY, 1);
    this.orbitTarget.set((minX + maxX) / 2, 0, -(minY + maxY) / 2);
    this.orbitRadius = Math.max(3, span * 1.6);
    this.updateCamera();
  }

  frameContent(entities: Entity[], solids: Solid[]): void {
    if (solids.length === 0) {
      this.frameEntities(entities);
      return;
    }
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (const entity of entities) {
      const bounds = entityBounds(entity);
      minX = Math.min(minX, bounds.min.x); maxX = Math.max(maxX, bounds.max.x);
      minY = Math.min(minY, bounds.min.y); maxY = Math.max(maxY, bounds.max.y);
      minZ = Math.min(minZ, 0); maxZ = Math.max(maxZ, 0);
    }
    for (const solid of solids) {
      const positions = solid.mesh.positions;
      for (let i = 0; i < positions.length; i += 3) {
        minX = Math.min(minX, positions[i]); maxX = Math.max(maxX, positions[i]);
        minY = Math.min(minY, positions[i + 1]); maxY = Math.max(maxY, positions[i + 1]);
        minZ = Math.min(minZ, positions[i + 2]); maxZ = Math.max(maxZ, positions[i + 2]);
      }
    }
    const span = Math.max(maxX - minX, maxY - minY, maxZ - minZ, 1);
    this.orbitTarget.set((minX + maxX) / 2, (minZ + maxZ) / 2, -(minY + maxY) / 2);
    this.orbitRadius = Math.max(3, span * 1.8);
    this.updateCamera();
  }

  attachControls(canvas: HTMLElement): void {
    canvas.addEventListener('mousedown', (e) => {
      if (e.button === 0 && e.metaKey) {
        this.switchToPerspective();
        this.isDragging = true;
        this.lastX = e.clientX;
        this.lastY = e.clientY;
      }
    });
    window.addEventListener('mousemove', (e) => {
      if (!this.isDragging) return;
      this.activeStandardView = null;
      const dx = e.clientX - this.lastX;
      const dy = e.clientY - this.lastY;
      this.orbitByScreenDelta(dx, dy);
      this.render();
      this.lastX = e.clientX;
      this.lastY = e.clientY;
    });
    window.addEventListener('mouseup', () => {
      this.isDragging = false;
    });
    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      if (e.metaKey) {
        // Command is an orbit-only modifier: neither axis may zoom.
        this.switchToPerspective();
        this.activeStandardView = null;
        this.orbitByScreenDelta(e.deltaX * 0.6, e.deltaY * 0.6);
      } else if (Math.abs(e.deltaY) > 0.01) {
        // Zoom is available only without Command.
        const zoomFactor = Math.exp(e.deltaY * 0.0025);
        const nextRadius = Math.max(2, Math.min(10000, this.orbitRadius * zoomFactor));
        const offset = this.camera.position.clone().sub(this.orbitTarget).setLength(nextRadius);
        this.orbitRadius = nextRadius;
        this.camera.position.copy(this.orbitTarget).add(offset);
        this.camera.lookAt(this.orbitTarget);
        this.updateProjection();
      }
      this.render();
    }, { passive: false });
  }

  panByScreenDelta(dx: number, dy: number): void {
    const scale = Math.max(0.001, this.orbitRadius * 0.0018);
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(this.camera.quaternion);
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(this.camera.quaternion);
    const shift = right.multiplyScalar(-dx * scale).add(up.multiplyScalar(dy * scale));
    this.orbitTarget.add(shift);
    this.camera.position.add(shift);
    this.camera.lookAt(this.orbitTarget);
  }

  syncSolids(solids: Solid[]): void {
    const ids = new Set(solids.map((s) => s.id));

    for (const [id, mesh] of this.solidMeshes) {
      if (!ids.has(id)) {
        this.disposeSolidEdges(mesh);
        this.scene.remove(mesh);
        mesh.geometry.dispose();
        (mesh.material as THREE.Material).dispose();
        this.solidMeshes.delete(id);
      }
    }

    for (const solid of solids) {
      let mesh = this.solidMeshes.get(solid.id);
      if (!mesh) {
        const geom = this.solidToGeometry(solid);
        const mat = new THREE.MeshPhongMaterial({
          color: solid.selected ? 0x65c7ff : 0xffffff,
          side: THREE.DoubleSide,
          flatShading: false,
          wireframe: true,
        });
        mesh = new THREE.Mesh(geom, mat);
        mesh.userData.revision = solid.revision;
        mesh.userData.selected = solid.selected;
        this.applySolidStyle(mesh, solid.selected);
        this.solidMeshes.set(solid.id, mesh);
        this.scene.add(mesh);
      } else {
        let geometryChanged = false;
        if (mesh.userData.revision !== solid.revision) {
          this.disposeSolidEdges(mesh);
          mesh.geometry.dispose();
          mesh.geometry = this.solidToGeometry(solid);
          mesh.userData.revision = solid.revision;
          geometryChanged = true;
        }
        mesh.userData.selected = solid.selected;
        if (geometryChanged
          || mesh.userData.styledVisualStyle !== this.visualStyle
          || mesh.userData.styledSelected !== solid.selected) {
          this.applySolidStyle(mesh, solid.selected);
        }
      }
    }
  }

  syncEntities(entities: Entity[]): void {
    const ids = new Set(entities.map((entity) => entity.id));
    for (const [id, object] of this.entityObjects) {
      if (!ids.has(id)) {
        this.scene.remove(object);
        object.geometry.dispose();
        (object.material as THREE.Material).dispose();
        this.entityObjects.delete(id);
      }
    }

    for (const entity of entities) {
      const previous = this.entityObjects.get(entity.id);
      if (previous) {
        this.scene.remove(previous);
        previous.geometry.dispose();
        (previous.material as THREE.Material).dispose();
      }
      const object = this.entityToObject(entity);
      this.entityObjects.set(entity.id, object);
      this.scene.add(object);
    }
  }

  syncPreview(preview?: { type: string; data: unknown }): void {
    if (this.previewObject) {
      this.scene.remove(this.previewObject);
      this.previewObject.geometry.dispose();
      (this.previewObject.material as THREE.Material).dispose();
      this.previewObject = null;
    }
    if (!preview) return;
    const data = preview.data as Record<string, Vec2> & { sides?: number };
    const points: Vec2[] = [];
    let loop = false;
    if (preview.type === 'line' && data.start && data.end) {
      points.push(data.start, data.end);
    } else if (preview.type === 'rectangle' && data.start && data.end) {
      points.push(
        data.start,
        { x: data.end.x, y: data.start.y },
        data.end,
        { x: data.start.x, y: data.end.y },
      );
      loop = true;
    } else if ((preview.type === 'circle' || preview.type === 'octagon') && data.center && data.cursor) {
      const radius = Math.hypot(data.cursor.x - data.center.x, data.cursor.y - data.center.y);
      const segments = preview.type === 'circle' ? 96 : 8;
      const offset = preview.type === 'octagon' ? Math.PI / 8 : 0;
      for (let i = 0; i < segments; i++) {
        const angle = i * Math.PI * 2 / segments + offset;
        points.push({ x: data.center.x + Math.cos(angle) * radius, y: data.center.y + Math.sin(angle) * radius });
      }
      loop = true;
    } else if (preview.type === 'polygon' && data.center && data.cursor && data.sides) {
      const apothem = Math.hypot(data.cursor.x - data.center.x, data.cursor.y - data.center.y);
      const radius = apothem / Math.cos(Math.PI / data.sides);
      const normalAngle = Math.atan2(data.cursor.y - data.center.y, data.cursor.x - data.center.x);
      for (let i = 0; i < data.sides; i++) {
        const angle = normalAngle + Math.PI / data.sides + i * Math.PI * 2 / data.sides;
        points.push({ x: data.center.x + Math.cos(angle) * radius, y: data.center.y + Math.sin(angle) * radius });
      }
      loop = true;
    }
    if (points.length < 2) return;
    const geometry = new THREE.BufferGeometry().setFromPoints(
      points.map((point) => {
        const world = localToWorld(this.activeWorkPlane, point, 0.025);
        return new THREE.Vector3(world.x, world.z, -world.y);
      })
    );
    const material = new THREE.LineDashedMaterial({ color: 0xaaaaaa, dashSize: 0.3, gapSize: 0.2, depthTest: false });
    const object = loop ? new THREE.LineLoop(geometry, material) : new THREE.Line(geometry, material);
    object.computeLineDistances();
    object.renderOrder = 20;
    this.previewObject = object;
    this.scene.add(object);
  }

  syncGrips(grips: Array<{ point: Vec2 & { z?: number }; hot: boolean; shape?: 'square' | 'edge' }>): void {
    if (this.gripObjects) {
      this.scene.remove(this.gripObjects);
      this.gripObjects.geometry.dispose();
      (this.gripObjects.material as THREE.Material).dispose();
      this.gripObjects = null;
    }
    if (grips.length === 0) return;
    const geometry = new THREE.BufferGeometry().setFromPoints(
      grips.map((grip) => new THREE.Vector3(grip.point.x, (grip.point.z ?? 0) + 0.04, -grip.point.y))
    );
    const material = new THREE.PointsMaterial({
      color: grips.some((grip) => grip.hot) ? 0xff4d4d : 0x00aaff,
      size: 9,
      sizeAttenuation: false,
      depthTest: false,
    });
    this.gripObjects = new THREE.Points(geometry, material);
    this.gripObjects.renderOrder = 30;
    this.scene.add(this.gripObjects);
  }

  pickGripIndex(
    canvas: HTMLCanvasElement,
    grips: Array<{ point: Vec2 & { z?: number }; index: number }>,
    sx: number,
    sy: number,
    tolerance = 12
  ): number {
    const rect = canvas.getBoundingClientRect();
    let best = -1;
    let bestDistance = tolerance;
    for (const grip of grips) {
      const projected = new THREE.Vector3(grip.point.x, grip.point.z ?? 0, -grip.point.y).project(this.camera);
      const px = rect.left + (projected.x + 1) * rect.width / 2;
      const py = rect.top + (1 - projected.y) * rect.height / 2;
      const distance = Math.hypot(sx - px, sy - py);
      if (projected.z >= -1 && projected.z <= 1 && distance <= bestDistance) {
        bestDistance = distance;
        best = grip.index;
      }
    }
    return best;
  }

  private entityToObject(entity: Entity): THREE.Line {
    const points: Vec2[] = [];
    let loop = false;
    switch (entity.type) {
      case 'line':
        points.push(entity.start, entity.end);
        break;
      case 'circle': {
        const segments = 96;
        for (let i = 0; i < segments; i++) {
          const angle = i * Math.PI * 2 / segments;
          points.push({
            x: entity.center.x + Math.cos(angle) * entity.radius,
            y: entity.center.y + Math.sin(angle) * entity.radius,
          });
        }
        loop = true;
        break;
      }
      case 'rectangle':
        points.push(
          entity.first,
          { x: entity.opposite.x, y: entity.first.y },
          entity.opposite,
          { x: entity.first.x, y: entity.opposite.y },
        );
        loop = true;
        break;
      case 'octagon':
        points.push(...entity.vertices);
        loop = true;
        break;
      case 'polyline':
        points.push(...entity.vertices);
        loop = entity.closed;
        break;
    }

    const geometry = new THREE.BufferGeometry().setFromPoints(
      points.map((point) => {
        const world = localToWorld(entity.workPlane ?? WORLD_WORK_PLANE, point, 0.015);
        return new THREE.Vector3(world.x, world.z, -world.y);
      })
    );
    const material = new THREE.LineBasicMaterial({
      color: entity.selected ? 0x65c7ff : entity.color,
      depthTest: false,
    });
    const object = loop ? new THREE.LineLoop(geometry, material) : new THREE.Line(geometry, material);
    object.renderOrder = 10;
    return object;
  }

  private solidToGeometry(solid: Solid): THREE.BufferGeometry {
    const geom = new THREE.BufferGeometry();
    const pos = solid.mesh.positions;
    // Manifold uses Z-up; Three.js is Y-up — swap Y and Z
    const swapped = new Float32Array(pos.length);
    for (let i = 0; i < pos.length; i += 3) {
      swapped[i] = pos[i];
      swapped[i + 1] = pos[i + 2];
      swapped[i + 2] = -pos[i + 1];
    }
    geom.setAttribute('position', new THREE.BufferAttribute(swapped, 3));
    geom.setIndex(Array.from(solid.mesh.indices));
    geom.computeVertexNormals();
    return geom;
  }

  render(): void {
    this.renderer.render(this.scene, this.camera);
  }

  pickSolidFace(canvas: HTMLCanvasElement, sx: number, sy: number): SolidFaceSelection | null {
    const rect = canvas.getBoundingClientRect();
    this.mouse.x = ((sx - rect.left) / rect.width) * 2 - 1;
    this.mouse.y = -((sy - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.mouse, this.camera);
    const hit = this.raycaster.intersectObjects(Array.from(this.solidMeshes.values()))[0];
    if (!hit || hit.faceIndex == null) return null;
    const entry = Array.from(this.solidMeshes.entries()).find(([, object]) => object === hit.object);
    if (!entry) return null;
    const [solidId] = entry;
    const geometry = (hit.object as THREE.Mesh).geometry;
    const index = geometry.index;
    const position = geometry.getAttribute('position');
    if (!index) return null;
    const triangleOffset = hit.faceIndex * 3;
    const seed = [index.getX(triangleOffset), index.getX(triangleOffset + 1), index.getX(triangleOffset + 2)];
    const a = new THREE.Vector3().fromBufferAttribute(position, seed[0]);
    const b = new THREE.Vector3().fromBufferAttribute(position, seed[1]);
    const c = new THREE.Vector3().fromBufferAttribute(position, seed[2]);
    const normal = new THREE.Vector3().crossVectors(b.clone().sub(a), c.clone().sub(a)).normalize();
    const vertices = new Set<number>();
    const highlightPositions: number[] = [];
    for (let i = 0; i < index.count; i += 3) {
      const ids = [index.getX(i), index.getX(i + 1), index.getX(i + 2)];
      const p0 = new THREE.Vector3().fromBufferAttribute(position, ids[0]);
      const p1 = new THREE.Vector3().fromBufferAttribute(position, ids[1]);
      const p2 = new THREE.Vector3().fromBufferAttribute(position, ids[2]);
      const candidate = new THREE.Vector3().crossVectors(p1.clone().sub(p0), p2.clone().sub(p0)).normalize();
      if (Math.abs(candidate.dot(normal)) < 0.999 || Math.abs(normal.dot(p0.clone().sub(a))) > 0.001) continue;
      ids.forEach((id) => vertices.add(id));
      for (const point of [p0, p1, p2]) highlightPositions.push(point.x, point.y, point.z);
    }
    this.showFaceHighlight(highlightPositions);
    return {
      solidId,
      vertexIndices: Array.from(vertices),
      normal: { x: normal.x, y: -normal.z, z: normal.y },
    };
  }

  nearestMeasurementPoint(
    canvas: HTMLCanvasElement,
    entities: Entity[],
    solids: Solid[],
    sx: number,
    sy: number,
    tolerance = 14,
  ): Vec3 | null {
    const rect = canvas.getBoundingClientRect();
    let result: Vec3 | null = null;
    let best = tolerance;
    const consider = (point: Vec3): void => {
      const projected = new THREE.Vector3(point.x, point.z, -point.y).project(this.camera);
      const px = rect.left + (projected.x + 1) * rect.width / 2;
      const py = rect.top + (1 - projected.y) * rect.height / 2;
      const distance = Math.hypot(sx - px, sy - py);
      if (projected.z >= -1 && projected.z <= 1 && distance <= best) {
        best = distance;
        result = point;
      }
    };
    for (const entity of entities) {
      for (const point of getEntityPoints(entity)) {
        consider(localToWorld(entity.workPlane ?? WORLD_WORK_PLANE, point));
      }
    }
    for (const solid of solids) {
      const positions = solid.mesh.positions;
      for (let i = 0; i < positions.length; i += 3) {
        consider({ x: positions[i], y: positions[i + 1], z: positions[i + 2] });
      }
    }
    return result;
  }

  projectCadPoint(canvas: HTMLCanvasElement, point: Vec3): Vec2 | null {
    const rect = canvas.getBoundingClientRect();
    const projected = new THREE.Vector3(point.x, point.z, -point.y).project(this.camera);
    if (projected.z < -1 || projected.z > 1) return null;
    return {
      x: (projected.x + 1) * rect.width / 2,
      y: (1 - projected.y) * rect.height / 2,
    };
  }

  clearFaceHighlight(): void {
    if (!this.faceHighlight) return;
    this.scene.remove(this.faceHighlight);
    this.faceHighlight.geometry.dispose();
    (this.faceHighlight.material as THREE.Material).dispose();
    this.faceHighlight = null;
  }

  private showFaceHighlight(positions: number[]): void {
    this.clearFaceHighlight();
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    const material = new THREE.MeshBasicMaterial({ color: 0x32aaff, transparent: true, opacity: 0.42, side: THREE.DoubleSide, depthTest: false });
    this.faceHighlight = new THREE.Mesh(geometry, material);
    this.faceHighlight.renderOrder = 40;
    this.scene.add(this.faceHighlight);
  }

  pickSolid(canvas: HTMLCanvasElement, sx: number, sy: number, excludedIds: ReadonlySet<string> = new Set()): string | null {
    const rect = canvas.getBoundingClientRect();
    this.mouse.x = ((sx - rect.left) / rect.width) * 2 - 1;
    this.mouse.y = -((sy - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.mouse, this.camera);
    const meshes = Array.from(this.solidMeshes.values());
    const hits = this.raycaster.intersectObjects(meshes);
    if (hits.length === 0) return null;
    let fallback: string | null = null;
    for (const hit of hits) {
      for (const [id, mesh] of this.solidMeshes) {
        if (mesh !== hit.object) continue;
        fallback ??= id;
        if (!excludedIds.has(id)) return id;
      }
    }
    return fallback;
  }

  groundPoint(canvas: HTMLCanvasElement, sx: number, sy: number): Vec2 | null {
    const rect = canvas.getBoundingClientRect();
    this.mouse.x = ((sx - rect.left) / rect.width) * 2 - 1;
    this.mouse.y = -((sy - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.mouse, this.camera);
    const hit = new THREE.Vector3();
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    if (!this.raycaster.ray.intersectPlane(plane, hit)) return null;
    return { x: hit.x, y: -hit.z };
  }

  workPlanePoint(canvas: HTMLCanvasElement, sx: number, sy: number): Vec2 | null {
    const rect = canvas.getBoundingClientRect();
    this.mouse.x = ((sx - rect.left) / rect.width) * 2 - 1;
    this.mouse.y = -((sy - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.mouse, this.camera);
    const normal = new THREE.Vector3(
      this.activeWorkPlane.zAxis.x,
      this.activeWorkPlane.zAxis.z,
      -this.activeWorkPlane.zAxis.y,
    );
    const origin = new THREE.Vector3(
      this.activeWorkPlane.origin.x,
      this.activeWorkPlane.origin.z,
      -this.activeWorkPlane.origin.y,
    );
    const hit = new THREE.Vector3();
    if (!this.raycaster.ray.intersectPlane(new THREE.Plane().setFromNormalAndCoplanarPoint(normal, origin), hit)) return null;
    const local = worldToLocal(this.activeWorkPlane, { x: hit.x, y: -hit.z, z: hit.y });
    return { x: local.x, y: local.y };
  }

  viewPlanePoint(canvas: HTMLCanvasElement, sx: number, sy: number): Vec2 | null {
    const rect = canvas.getBoundingClientRect();
    this.mouse.x = ((sx - rect.left) / rect.width) * 2 - 1;
    this.mouse.y = -((sy - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.mouse, this.camera);
    const normal = new THREE.Vector3();
    this.camera.getWorldDirection(normal);
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(normal, this.orbitTarget);
    const hit = new THREE.Vector3();
    if (!this.raycaster.ray.intersectPlane(plane, hit)) return null;
    const offset = hit.sub(this.orbitTarget);
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(this.camera.quaternion);
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(this.camera.quaternion);
    return { x: offset.dot(right), y: offset.dot(up) };
  }

  screenDeltaToCad(delta: Vec2): { x: number; y: number; z: number } {
    if (this.activeStandardView === 'top') return { x: delta.x, y: delta.y, z: 0 };
    if (this.activeStandardView === 'front') return { x: delta.x, y: 0, z: delta.y };
    if (this.activeStandardView === 'left') return { x: 0, y: -delta.x, z: delta.y };
    if (this.activeStandardView === 'right') return { x: 0, y: delta.x, z: delta.y };
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(this.camera.quaternion);
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(this.camera.quaternion);
    const world = right.multiplyScalar(delta.x).add(up.multiplyScalar(delta.y));
    return { x: world.x, y: -world.z, z: world.y };
  }
}
