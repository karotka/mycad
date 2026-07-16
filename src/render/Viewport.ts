import * as THREE from 'three';
import type { Document } from '../core/Document';
import type { ProjectViewState } from '../io/ProjectIO';
import { entityRenderKey } from './entityRenderKey';
import type { Entity, Solid, SolidEdgeSelection, SolidFaceSelection, SolidMesh } from '../core/entities/types';
import { axisOffsetUnderRay, verticesCentre } from '../interaction/AxisDrag';
import { curvePoints, dimensionGeometry, ellipsePoints, entityBounds } from '../core/entities/types';
import type { Vec2, Vec3 } from '../math/geometry';
import { worldToScreen } from '../math/geometry';
import { cloneWorkPlane, localToWorld, workPlaneFromXYAxes, WORLD_WORK_PLANE, worldToLocal, type WorkPlane } from '../math/workplane';
import { standardViewDelta } from './ViewportCoordinates';
import { ViewportProjection } from './ViewportProjection';
import { ViewportPicking } from './ViewportPicking';

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

    // A fixed 1 mm grid becomes prohibitively expensive after zoom-to-extents on
    // architectural DXFs. Keep the logical grid size unchanged for snapping, but
    // draw only every Nth line so adjacent lines stay several pixels apart.
    const minimumPixelSpacing = 8;
    const multiplier = Math.max(1, Math.ceil(minimumPixelSpacing / (gridSize * this.zoom)));
    const magnitude = 10 ** Math.floor(Math.log10(multiplier));
    const normalized = multiplier / magnitude;
    const pleasantMultiplier = (normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10) * magnitude;
    const visibleGridSize = gridSize * pleasantMultiplier;

    const startX = Math.floor(topLeft.x / visibleGridSize) * visibleGridSize;
    const endX = Math.ceil(bottomRight.x / visibleGridSize) * visibleGridSize;
    const startY = Math.floor(bottomRight.y / visibleGridSize) * visibleGridSize;
    const endY = Math.ceil(topLeft.y / visibleGridSize) * visibleGridSize;

    this.ctx.strokeStyle = '#1c2333';
    this.ctx.lineWidth = 1;

    for (let x = startX; x <= endX; x += visibleGridSize) {
      const s = worldToScreen({ x, y: 0 }, w, h, this.pan, this.zoom);
      this.ctx.beginPath();
      this.ctx.moveTo(s.x, 0);
      this.ctx.lineTo(s.x, h);
      this.ctx.stroke();
    }

    for (let y = startY; y <= endY; y += visibleGridSize) {
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
    grips: Array<{ point: Vec2; hot: boolean; shape?: 'square' | 'edge' }> = [],
    joinMode = false
  ): void {
    this.clear(w, h);
    this.drawGrid(w, h, doc.gridSize);

    for (const solid of doc.solids.filter((item) => !doc.hiddenLayers.has(item.layer))) {
      this.drawSolidProjection(solid, w, h);
    }

    for (const entity of doc.entities.filter((item) => !doc.hiddenLayers.has(item.layer))) {
      this.drawEntity(entity, w, h, entity.selected, joinMode);
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

  private drawGrips(grips: Array<{ point: Vec2; hot: boolean; shape?: 'square' | 'edge'; angle?: number }>, w: number, h: number): void {
    for (const grip of grips) {
      const p = worldToScreen(grip.point, w, h, this.pan, this.zoom);
      const size = grip.hot ? 10 : 8;
      this.ctx.fillStyle = grip.hot ? '#ff4d4d' : '#0d1117';
      this.ctx.strokeStyle = grip.hot ? '#ffffff' : '#00aaff';
      this.ctx.lineWidth = 1.5;
      const gripWidth = grip.shape === 'edge' ? size + 5 : size;
      const gripHeight = grip.shape === 'edge' ? Math.max(5, size - 3) : size;
      this.ctx.save();
      this.ctx.translate(p.x, p.y);
      // An edge grip is a bar lying along its edge, so it has to turn with it.
      // Screen Y grows downward, hence the negated angle.
      if (grip.shape === 'edge' && grip.angle) this.ctx.rotate(-grip.angle);
      this.ctx.fillRect(-gripWidth / 2, -gripHeight / 2, gripWidth, gripHeight);
      this.ctx.strokeRect(-gripWidth / 2, -gripHeight / 2, gripWidth, gripHeight);
      this.ctx.restore();
    }
  }

  private colorHex(c: number, selected: boolean): string {
    if (selected) return '#65c7ff';
    return `#${c.toString(16).padStart(6, '0')}`;
  }

  private drawEntity(entity: Entity, w: number, h: number, selected: boolean, joinMode = false): void {
    this.ctx.save();
    this.ctx.strokeStyle = this.colorHex(entity.color, selected);
    this.ctx.fillStyle = this.colorHex(entity.color, selected);
    this.ctx.lineWidth = selected && joinMode ? 2.5 : 1;
    if (selected && joinMode) {
      this.ctx.shadowColor = '#65c7ff';
      this.ctx.shadowBlur = 4;
    }

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
      case 'ellipse': {
        const c = worldToScreen(entity.center, w, h, this.pan, this.zoom);
        this.ctx.beginPath();
        // Screen Y grows downward, so the rotation flips with it.
        this.ctx.ellipse(c.x, c.y, entity.radiusX * this.zoom, entity.radiusY * this.zoom, -entity.rotation, 0, Math.PI * 2);
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
      case 'arc':
      case 'bezier': { const verts=curvePoints(entity); this.ctx.beginPath(); verts.forEach((v,i)=>{const p=worldToScreen(v,w,h,this.pan,this.zoom); if(i===0)this.ctx.moveTo(p.x,p.y);else this.ctx.lineTo(p.x,p.y);}); this.ctx.stroke(); break; }
      case 'text': {
        const p=worldToScreen(entity.position,w,h,this.pan,this.zoom);
        this.ctx.save();
        this.ctx.translate(p.x, p.y);
        this.ctx.rotate(-(entity.rotation ?? 0));
        this.ctx.font=`${Math.max(8,entity.height*this.zoom)}px ${JSON.stringify(entity.font ?? 'Arial')}`;
        this.ctx.fillText(entity.text,0,0);
        this.ctx.restore();
        break;
      }
      case 'dimension': {
        const geometry = dimensionGeometry(entity);
        const segment = ([start, end]: [Vec2, Vec2]): void => {
          const a = worldToScreen(start, w, h, this.pan, this.zoom), b = worldToScreen(end, w, h, this.pan, this.zoom);
          this.ctx.beginPath(); this.ctx.moveTo(a.x, a.y); this.ctx.lineTo(b.x, b.y); this.ctx.stroke();
        };
        segment(geometry.extensionStart); segment(geometry.extensionEnd); segment(geometry.dimensionLine);
        for (const arrow of geometry.arrows) {
          const points = arrow.map(point => worldToScreen(point, w, h, this.pan, this.zoom));
          this.ctx.beginPath();
          if (entity.arrowType === 'tick') {
            this.ctx.moveTo(points[1].x, points[1].y); this.ctx.lineTo(points[2].x, points[2].y); this.ctx.stroke();
          } else {
            this.ctx.moveTo(points[0].x, points[0].y); this.ctx.lineTo(points[1].x, points[1].y); this.ctx.moveTo(points[0].x, points[0].y); this.ctx.lineTo(points[2].x, points[2].y);
            if (entity.arrowType === 'closed') { this.ctx.lineTo(points[1].x, points[1].y); this.ctx.closePath(); this.ctx.fill(); } else this.ctx.stroke();
          }
        }
        const text = worldToScreen(geometry.textPoint, w, h, this.pan, this.zoom);
        this.ctx.save(); this.ctx.translate(text.x, text.y); this.ctx.rotate(-geometry.textAngle);
        this.ctx.font = `${Math.max(8, entity.textHeight * entity.scale * this.zoom)}px Arial`;
        this.ctx.textAlign = 'center'; this.ctx.textBaseline = 'middle'; this.ctx.fillText(geometry.text, 0, 0); this.ctx.restore();
        break;
      }
    }
    this.ctx.restore();
  }

  private drawPreview(preview: { type: string; data: unknown }, w: number, h: number): void {
    this.ctx.strokeStyle = '#888888';
    this.ctx.setLineDash([4, 4]);
    this.ctx.lineWidth = 1;

    const d = preview.data as Record<string, Vec2 & { radius?: number }>;
    const polygonData = preview.data as { center?: Vec2; cursor?: Vec2; sides?: number };
    let label = '';
    let labelPoint: Vec2 | undefined;

    if (preview.type === 'copy' || preview.type === 'scale') {
      const copy = preview.data as { start: Vec2; end: Vec2; entities: Entity[] };
      this.ctx.save();
      this.ctx.globalAlpha = 0.9;
      this.ctx.setLineDash([5, 4]);
      copy.entities.forEach((entity) => this.drawEntity(entity, w, h, false));
      this.ctx.restore();
      const a = worldToScreen(copy.start, w, h, this.pan, this.zoom);
      const b = worldToScreen(copy.end, w, h, this.pan, this.zoom);
      this.ctx.strokeStyle = '#67c9ff';
      this.ctx.beginPath(); this.ctx.moveTo(a.x, a.y); this.ctx.lineTo(b.x, b.y); this.ctx.stroke();
      label = preview.type === 'scale'
        ? `Scale ${(preview.data as { factor?: number }).factor?.toFixed(3) ?? ''}`
        : `Copy ${Math.hypot(copy.end.x - copy.start.x, copy.end.y - copy.start.y).toFixed(2)} mm`;
      labelPoint = copy.end;
    } else if (preview.type === 'rotate') {
      const rotation = preview.data as { start: Vec2; end: Vec2; entities: Entity[] };
      this.ctx.save();
      this.ctx.globalAlpha = 0.95;
      this.ctx.setLineDash([5, 4]);
      rotation.entities.forEach((entity) => this.drawEntity(entity, w, h, false));
      this.ctx.restore();
      this.ctx.strokeStyle = '#ffc857';
      this.ctx.lineWidth = 1.5;
      this.ctx.setLineDash([]);
      const a = worldToScreen(rotation.start, w, h, this.pan, this.zoom);
      const b = worldToScreen(rotation.end, w, h, this.pan, this.zoom);
      this.ctx.beginPath();
      this.ctx.moveTo(a.x, a.y);
      this.ctx.lineTo(b.x, b.y);
      this.ctx.stroke();
      const angle = Math.atan2(rotation.end.y - rotation.start.y, rotation.end.x - rotation.start.x);
      const radius = Math.min(38, Math.max(16, Math.hypot(b.x - a.x, b.y - a.y) * 0.35));
      this.ctx.beginPath();
      this.ctx.arc(a.x, a.y, radius, 0, -angle, angle > 0);
      this.ctx.stroke();
      label = `A = ${(Math.atan2(rotation.end.y - rotation.start.y, rotation.end.x - rotation.start.x) * 180 / Math.PI).toFixed(2)}°`;
      labelPoint = rotation.end;
    } else if (preview.type === 'dimension') {
      const value = preview.data as { start: Vec2; end: Vec2; offset: Vec2; textPosition?: Vec2; kind?: 'linear' | 'aligned' | 'radius' | 'diameter'; rotation?: number; style?: { textHeight: number; arrowSize: number; arrowType: 'closed' | 'open' | 'tick'; extensionBeyond: number; extensionOffset: number; textOffset: number; precision: number; scale: number; layer: string } };
      const style = value.style ?? { textHeight: 2.5, arrowSize: 2.5, arrowType: 'closed' as const, extensionBeyond: 1.25, extensionOffset: 0.625, textOffset: 0.625, precision: 2, scale: 1, layer: 'dims' };
      // No label beside it: a dimension is the one preview that already writes
      // its own measurement, so one here would print the number twice.
      this.drawEntity({ id: 'preview-dimension', type: 'dimension', dimensionKind: value.kind ?? 'linear', rotation: value.rotation, textPosition: value.textPosition, color: 0x888888, selected: false, start: value.start, end: value.end, offset: value.offset, ...style }, w, h, false);
    } else if (preview.type === 'line' && d.start && d.end) {
      const a = worldToScreen(d.start, w, h, this.pan, this.zoom);
      const b = worldToScreen(d.end, w, h, this.pan, this.zoom);
      this.ctx.beginPath();
      this.ctx.moveTo(a.x, a.y);
      this.ctx.lineTo(b.x, b.y);
      this.ctx.stroke();
      label = `L = ${Math.hypot(d.end.x - d.start.x, d.end.y - d.start.y).toFixed(2)} mm`;
      labelPoint = d.end;
    } else if (preview.type === 'move' && d.start && d.end) {
      const a = worldToScreen(d.start, w, h, this.pan, this.zoom);
      const b = worldToScreen(d.end, w, h, this.pan, this.zoom);
      this.ctx.beginPath();
      this.ctx.moveTo(a.x, a.y);
      this.ctx.lineTo(b.x, b.y);
      this.ctx.stroke();
      const delta = { x: d.end.x - d.start.x, y: d.end.y - d.start.y };
      label = `ΔX ${delta.x.toFixed(2)} · ΔY ${delta.y.toFixed(2)} · ${Math.hypot(delta.x, delta.y).toFixed(2)} mm`;
      labelPoint = d.end;
    } else if (preview.type === 'polyline') {
      const chain = preview.data as unknown as { vertices: Vec2[]; cursor: Vec2 };
      const screen = chain.vertices.map((vertex) => worldToScreen(vertex, w, h, this.pan, this.zoom));
      const last = chain.vertices[chain.vertices.length - 1];
      // Settled segments are drawn solid and the one on the cursor dashed, so
      // the chain shows at a glance how much of it is already decided.
      if (screen.length > 1) {
        this.ctx.save();
        this.ctx.setLineDash([]);
        this.ctx.strokeStyle = '#67c9ff';
        this.ctx.beginPath();
        this.ctx.moveTo(screen[0].x, screen[0].y);
        for (const point of screen.slice(1)) this.ctx.lineTo(point.x, point.y);
        this.ctx.stroke();
        this.ctx.restore();
      }
      const a = screen[screen.length - 1];
      const b = worldToScreen(chain.cursor, w, h, this.pan, this.zoom);
      this.ctx.beginPath();
      this.ctx.moveTo(a.x, a.y);
      this.ctx.lineTo(b.x, b.y);
      this.ctx.stroke();
      label = `L = ${Math.hypot(chain.cursor.x - last.x, chain.cursor.y - last.y).toFixed(2)} mm`;
      labelPoint = chain.cursor;
    } else if (preview.type === 'circleDiameter' && d.center && d.cursor) {
      // The cursor distance is the diameter here, so the circle is half of it.
      const diameter = Math.hypot(d.cursor.x - d.center.x, d.cursor.y - d.center.y);
      const c = worldToScreen(d.center, w, h, this.pan, this.zoom);
      this.ctx.beginPath();
      this.ctx.arc(c.x, c.y, (diameter / 2) * this.zoom, 0, Math.PI * 2);
      this.ctx.stroke();
      label = `\u00d8 = ${diameter.toFixed(2)} mm`;
      labelPoint = d.cursor;
    } else if (preview.type === 'ellipse' && d.center && d.axisPoint && d.cursor) {
      const radiusX = Math.hypot(d.axisPoint.x - d.center.x, d.axisPoint.y - d.center.y);
      const rotation = Math.atan2(d.axisPoint.y - d.center.y, d.axisPoint.x - d.center.x);
      const radiusY = Math.abs(-(d.cursor.x - d.center.x) * Math.sin(rotation) + (d.cursor.y - d.center.y) * Math.cos(rotation));
      const c = worldToScreen(d.center, w, h, this.pan, this.zoom);
      this.ctx.beginPath();
      this.ctx.ellipse(c.x, c.y, radiusX * this.zoom, Math.max(radiusY, 1e-6) * this.zoom, -rotation, 0, Math.PI * 2);
      this.ctx.stroke();
      label = `RX = ${radiusX.toFixed(2)} · RY = ${radiusY.toFixed(2)} mm`;
      labelPoint = d.cursor;
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
    } else if (preview.type === 'arc') {
      const q=preview.data as {center:Vec2;start:Vec2;cursor:Vec2}; const c=worldToScreen(q.center,w,h,this.pan,this.zoom); const r=Math.hypot(q.start.x-q.center.x,q.start.y-q.center.y); let sweep=Math.atan2(q.cursor.y-q.center.y,q.cursor.x-q.center.x)-Math.atan2(q.start.y-q.center.y,q.start.x-q.center.x);if(sweep<=0)sweep+=Math.PI*2; this.ctx.beginPath();this.ctx.arc(c.x,c.y,r*this.zoom,-Math.atan2(q.start.y-q.center.y,q.start.x-q.center.x),-(Math.atan2(q.start.y-q.center.y,q.start.x-q.center.x)+sweep),true);this.ctx.stroke();
    } else if (preview.type === 'bezier') {
      const q=preview.data as {start:Vec2;control1:Vec2;control2:Vec2;end:Vec2}; const a=worldToScreen(q.start,w,h,this.pan,this.zoom),b=worldToScreen(q.control1,w,h,this.pan,this.zoom),c=worldToScreen(q.control2,w,h,this.pan,this.zoom),d2=worldToScreen(q.end,w,h,this.pan,this.zoom);this.ctx.beginPath();this.ctx.moveTo(a.x,a.y);this.ctx.bezierCurveTo(b.x,b.y,c.x,c.y,d2.x,d2.y);this.ctx.stroke();
    } else if (preview.type === 'text') {
      const q=preview.data as {position:Vec2;text:string;font?:string;height?:number};const p=worldToScreen(q.position,w,h,this.pan,this.zoom);this.ctx.setLineDash([]);this.ctx.font=`${Math.max(8,(q.height ?? 2.5)*this.zoom)}px ${JSON.stringify(q.font ?? 'Arial')}`;this.ctx.fillStyle='#888';this.ctx.fillText(q.text,p.x,p.y);
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
    const visibleEntities = doc.entities.filter((entity) => !doc.hiddenLayers.has(entity.layer));
    if (visibleEntities.length > 0) {
      minX = Infinity; minY = Infinity; maxX = -Infinity; maxY = -Infinity;
      for (const e of visibleEntities) {
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

  zoomWindow(a: Vec2, b: Vec2, w: number, h: number): void {
    const windowWidth = Math.abs(b.x - a.x);
    const windowHeight = Math.abs(b.y - a.y);
    if (windowWidth < 1e-9 || windowHeight < 1e-9) return;
    this.pan = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    this.zoom = Math.max(1e-6, Math.min(100_000, Math.min(w / windowWidth, h / windowHeight) * 0.94));
  }
}

export class Viewport3D {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera | THREE.OrthographicCamera;
  renderer: THREE.WebGLRenderer;
  private solidMeshes = new Map<string, THREE.Mesh>();
  private entityObjects = new Map<string, THREE.Object3D>();
  private entityRenderKeys = new Map<string, string>();
  private previewObject: THREE.Object3D | null = null;
  /** The solid a preview is standing in for, hidden until the preview clears. */
  private previewHiddenSolid: string | null = null;
  private gripObjects: THREE.Points | null = null;
  private faceHighlight: THREE.Mesh | null = null;
  private edgeHighlight: THREE.Line | null = null;
  private grid: THREE.GridHelper;
  private axisTriad: THREE.Group;
  private isDragging = false;
  private lastX = 0;
  private lastY = 0;
  private dragStartX = 0;
  private dragStartY = 0;
  private orbitDragStarted = false;
  orbitTheta = Math.PI / 4;
  orbitPhi = Math.PI / 4;
  orbitRadius = 30;
  orbitTarget = new THREE.Vector3(0, 0, 0);
  private readonly projection = new ViewportProjection(() => this.camera, () => this.orbitTarget);
  private readonly picking = new ViewportPicking(() => this.camera);
  activeStandardView: 'top' | 'front' | 'left' | 'right' | null = null;
  private viewportAspect = 1;
  private activeWorkPlane: WorkPlane = cloneWorkPlane(WORLD_WORK_PLANE);
  private visualStyle: 'wireframe' | 'shaded' | 'xray' = 'wireframe';

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

    this.axisTriad = this.createAxisTriad();
    this.scene.add(this.axisTriad);

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
    const triadBasis = new THREE.Matrix4().makeBasis(newX, newY, newZ);
    this.axisTriad.position.copy(origin);
    this.axisTriad.quaternion.setFromRotationMatrix(triadBasis);
    this.axisTriad.updateMatrixWorld(true);
    this.render();
  }

  captureViewState(): ProjectViewState['threeD'] {
    const vector = (value: THREE.Vector3): { x: number; y: number; z: number } => ({ x: value.x, y: value.y, z: value.z });
    return {
      position: vector(this.camera.position),
      target: vector(this.orbitTarget),
      up: vector(this.camera.up),
      projection: this.camera instanceof THREE.OrthographicCamera ? 'orthographic' : 'perspective',
      orbitRadius: this.orbitRadius,
      activeStandardView: this.activeStandardView,
    };
  }

  restoreViewState(state: ProjectViewState['threeD']): void {
    if (state.projection === 'orthographic') this.switchToOrthographic();
    else this.switchToPerspective();
    this.orbitTarget.set(state.target.x, state.target.y, state.target.z);
    this.orbitRadius = state.orbitRadius;
    this.camera.position.set(state.position.x, state.position.y, state.position.z);
    this.camera.up.set(state.up.x, state.up.y, state.up.z).normalize();
    this.activeStandardView = state.activeStandardView;
    this.camera.lookAt(this.orbitTarget);
    this.updateProjection();
    this.render();
  }

  private createAxisTriad(): THREE.Group {
    const group = new THREE.Group();
    group.name = 'ucs-axis-triad';
    const length = 5;
    const headLength = 0.65;
    const headWidth = 0.36;
    const axes: Array<{ name: string; direction: THREE.Vector3; color: number; labelPosition: THREE.Vector3 }> = [
      { name: 'X', direction: new THREE.Vector3(1, 0, 0), color: 0xf05b5b, labelPosition: new THREE.Vector3(5.7, 0, 0) },
      { name: 'Y', direction: new THREE.Vector3(0, 1, 0), color: 0x62d47a, labelPosition: new THREE.Vector3(0, 5.7, 0) },
      { name: 'Z', direction: new THREE.Vector3(0, 0, 1), color: 0x58a6ff, labelPosition: new THREE.Vector3(0, 0, 5.7) },
    ];
    for (const axis of axes) {
      const arrow = new THREE.ArrowHelper(axis.direction, new THREE.Vector3(), length, axis.color, headLength, headWidth);
      (arrow.line.material as THREE.Material).depthTest = false;
      (arrow.cone.material as THREE.Material).depthTest = false;
      arrow.renderOrder = 5;
      group.add(arrow);
      const label = this.createAxisLabel(axis.name, axis.color);
      label.position.copy(axis.labelPosition);
      label.renderOrder = 6;
      group.add(label);
    }
    return group;
  }

  private createAxisLabel(text: string, color: number): THREE.Sprite {
    const canvas = document.createElement('canvas');
    canvas.width = 96;
    canvas.height = 96;
    const context = canvas.getContext('2d')!;
    context.font = '700 64px Arial';
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.lineWidth = 8;
    context.strokeStyle = '#0d1117';
    context.strokeText(text, 48, 50);
    context.fillStyle = `#${color.toString(16).padStart(6, '0')}`;
    context.fillText(text, 48, 50);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    const material = new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false });
    const sprite = new THREE.Sprite(material);
    sprite.scale.set(1.15, 1.15, 1.15);
    return sprite;
  }

  setVisualStyle(style: 'wireframe' | 'shaded' | 'xray'): void {
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
    material.color.setHex(selected ? 0x65c7ff : (mesh.userData.baseColor as number ?? 0xffffff));
    material.shininess = this.visualStyle === 'wireframe' ? 0 : 18;
    material.transparent = this.visualStyle === 'xray';
    material.opacity = this.visualStyle === 'xray' ? (selected ? 0.42 : 0.28) : 1;
    material.depthWrite = this.visualStyle !== 'xray';
    material.side = THREE.DoubleSide;
    material.needsUpdate = true;
    this.disposeSolidEdges(mesh);
    if (this.visualStyle === 'shaded' || this.visualStyle === 'xray') {
      const edges = new THREE.LineSegments(
        new THREE.EdgesGeometry(mesh.geometry, 24),
        new THREE.LineBasicMaterial({
          color: selected ? 0x9fe2ff : this.visualStyle === 'xray' ? 0x8fc8e8 : 0x27313a,
          transparent: this.visualStyle === 'xray', opacity: this.visualStyle === 'xray' ? 0.9 : 1,
          depthTest: this.visualStyle !== 'xray',
        }),
      );
      edges.name = 'solid-edges';
      edges.renderOrder = 2;
      mesh.add(edges);
    }
    mesh.userData.styledVisualStyle = this.visualStyle;
    mesh.userData.styledSelected = selected;
    mesh.userData.styledRevision = mesh.userData.revision;
    mesh.userData.styledColor = mesh.userData.baseColor;
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

  orbitByScreenDelta(dx: number, dy: number): void {
    this.switchToPerspective();
    this.activeStandardView = null;
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

  zoomByWheelDelta(deltaY: number): void {
    const factor = Math.exp(deltaY * 0.0025);
    const nextRadius = Math.max(2, Math.min(10000, this.orbitRadius * factor));
    const offset = this.camera.position.clone().sub(this.orbitTarget).setLength(nextRadius);
    this.orbitRadius = nextRadius;
    this.camera.position.copy(this.orbitTarget).add(offset);
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

  attachControls(canvas: HTMLElement, onOrbitStart?: () => void): void {
    canvas.addEventListener('mousedown', (e) => {
      if (e.button === 0 && e.metaKey) {
        this.isDragging = true;
        this.lastX = e.clientX;
        this.lastY = e.clientY;
        this.dragStartX = e.clientX;
        this.dragStartY = e.clientY;
        this.orbitDragStarted = false;
      }
    });
    window.addEventListener('mousemove', (e) => {
      if (!this.isDragging) return;
      if (!e.metaKey) {
        this.isDragging = false;
        this.orbitDragStarted = false;
        return;
      }
      if (!this.orbitDragStarted) {
        if (Math.hypot(e.clientX - this.dragStartX, e.clientY - this.dragStartY) < 3) return;
        this.orbitDragStarted = true;
        onOrbitStart?.();
        this.switchToPerspective();
      }
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
      this.orbitDragStarted = false;
    });
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

  zoomScreenWindow(x1: number, y1: number, x2: number, y2: number, w: number, h: number): void {
    const windowWidth = Math.abs(x2 - x1);
    const windowHeight = Math.abs(y2 - y1);
    if (windowWidth < 4 || windowHeight < 4) return;
    const centerX = (x1 + x2) / 2;
    const centerY = (y1 + y2) / 2;
    this.panByScreenDelta(centerX - w / 2, centerY - h / 2);
    const factor = Math.max(windowWidth / w, windowHeight / h) / 0.94;
    const nextRadius = Math.max(1e-6, Math.min(1e9, this.orbitRadius * factor));
    const offset = this.camera.position.clone().sub(this.orbitTarget).setLength(nextRadius);
    this.orbitRadius = nextRadius;
    this.camera.position.copy(this.orbitTarget).add(offset);
    this.camera.lookAt(this.orbitTarget);
    this.updateProjection();
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
        const geom = this.solidToGeometry(solid.mesh);
        const mat = new THREE.MeshPhongMaterial({
          color: solid.selected ? 0x65c7ff : 0xffffff,
          side: THREE.DoubleSide,
          flatShading: false,
          wireframe: true,
        });
        mesh = new THREE.Mesh(geom, mat);
        mesh.userData.revision = solid.revision;
        mesh.userData.selected = solid.selected;
        mesh.userData.baseColor = solid.color;
        this.applySolidStyle(mesh, solid.selected);
        this.solidMeshes.set(solid.id, mesh);
        this.scene.add(mesh);
      } else {
        let geometryChanged = false;
        if (mesh.userData.revision !== solid.revision) {
          this.disposeSolidEdges(mesh);
          mesh.geometry.dispose();
          mesh.geometry = this.solidToGeometry(solid.mesh);
          mesh.userData.revision = solid.revision;
          geometryChanged = true;
        }
        mesh.userData.selected = solid.selected;
        mesh.userData.baseColor = solid.color;
        if (geometryChanged
          || mesh.userData.styledVisualStyle !== this.visualStyle
          || mesh.userData.styledSelected !== solid.selected
          || mesh.userData.styledColor !== solid.color) {
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
        this.disposeObject(object);
        this.entityObjects.delete(id);
        this.entityRenderKeys.delete(id);
      }
    }

    for (const entity of entities) {
      const previous = this.entityObjects.get(entity.id);
      // Entities are still mutable in the current document model, so object
      // identity alone cannot identify changes. A compact serialized render key
      // avoids disposing and rebuilding every Three.js object on every redraw.
      const renderKey = entityRenderKey(entity);
      if (previous && this.entityRenderKeys.get(entity.id) === renderKey) continue;
      if (previous) {
        this.scene.remove(previous);
        this.disposeObject(previous);
      }
      const object = this.entityToObject(entity);
      this.entityObjects.set(entity.id, object);
      this.entityRenderKeys.set(entity.id, renderKey);
      this.scene.add(object);
    }
  }

  syncPreview(preview?: { type: string; data: unknown }): void {
    if (this.previewObject) {
      this.scene.remove(this.previewObject);
      this.disposeObject(this.previewObject);
      this.previewObject = null;
    }
    // Whatever the last preview hid, it can have back.
    if (this.previewHiddenSolid) {
      const hidden = this.solidMeshes.get(this.previewHiddenSolid);
      if (hidden) hidden.visible = true;
      this.previewHiddenSolid = null;
    }
    if (!preview) return;
    if (preview.type === 'solid') {
      const data = preview.data as { solidId: string; mesh: SolidMesh };
      // The solid it replaces is hidden rather than drawn behind it: a face
      // pushed inwards would leave the ghost buried in the original, so the one
      // direction you most need to see would show nothing at all.
      const original = this.solidMeshes.get(data.solidId);
      if (original) {
        original.visible = false;
        this.previewHiddenSolid = data.solidId;
      }
      const geometry = this.solidToGeometry(data.mesh);
      const group = new THREE.Group();
      const surface = new THREE.Mesh(geometry, new THREE.MeshPhongMaterial({
        color: 0x67c9ff, side: THREE.DoubleSide, transparent: true, opacity: 0.55, depthWrite: false,
      }));
      surface.renderOrder = 20;
      group.add(surface);
      group.add(new THREE.LineSegments(
        new THREE.EdgesGeometry(geometry, 20),
        new THREE.LineBasicMaterial({ color: 0x9cdcfe }),
      ));
      this.previewObject = group;
      this.scene.add(group);
      return;
    }
    if (preview.type === 'ucs') {
      const data = preview.data as { origin?: Vec3; xPoint?: Vec3; yPoint?: Vec3; hover?: Vec3; step: number };
      const group = new THREE.Group();
      const toThree = (point: Vec3): THREE.Vector3 => new THREE.Vector3(point.x, point.z, -point.y);
      const marked = [data.origin, data.xPoint, data.yPoint, data.hover].filter((point): point is Vec3 => Boolean(point));
      if (marked.length > 0) {
        const points = new THREE.Points(
          new THREE.BufferGeometry().setFromPoints(marked.map(toThree)),
          new THREE.PointsMaterial({ color: 0xffd84d, size: 11, sizeAttenuation: false, depthTest: false }),
        );
        points.renderOrder = 50;
        group.add(points);
      }
      const origin = data.origin;
      const xPoint = data.xPoint ?? (data.step === 1 ? data.hover : undefined);
      if (origin && xPoint) {
        const origin3 = toThree(origin);
        const xVector = toThree(xPoint).sub(origin3);
        const length = Math.max(0.5, xVector.length());
        if (xVector.lengthSq() > 1e-10) {
          const xArrow = new THREE.ArrowHelper(xVector.normalize(), origin3, length, 0xf05b5b, Math.min(0.7, length * 0.18), Math.min(0.38, length * 0.1));
          (xArrow.line.material as THREE.Material).depthTest = false;
          (xArrow.cone.material as THREE.Material).depthTest = false;
          group.add(xArrow);
        }
        const yPoint = data.yPoint ?? (data.step === 2 ? data.hover : undefined);
        if (yPoint) {
          try {
            const plane = workPlaneFromXYAxes(origin, xPoint, yPoint);
            const axisLength = length;
            const axes = [
              { direction: plane.yAxis, color: 0x62d47a, name: 'Y' },
              { direction: plane.zAxis, color: 0x58a6ff, name: 'Z' },
            ];
            axes.forEach((axis) => {
              const direction = new THREE.Vector3(axis.direction.x, axis.direction.z, -axis.direction.y).normalize();
              const arrow = new THREE.ArrowHelper(direction, origin3, axisLength, axis.color, Math.min(0.7, axisLength * 0.18), Math.min(0.38, axisLength * 0.1));
              (arrow.line.material as THREE.Material).depthTest = false;
              (arrow.cone.material as THREE.Material).depthTest = false;
              group.add(arrow);
              const label = this.createAxisLabel(axis.name, axis.color);
              label.position.copy(origin3).add(direction.multiplyScalar(axisLength + 0.55));
              group.add(label);
            });
          } catch { /* Collinear hover point: keep showing the selected points. */ }
        }
      }
      this.previewObject = group;
      this.scene.add(group);
      return;
    }
    if (preview.type === 'copy' || preview.type === 'scale') {
      const copy = preview.data as { start: Vec2; end: Vec2; entities: Entity[] };
      const group = new THREE.Group();
      for (const entity of copy.entities) {
        const object = this.entityToObject(entity);
        object.traverse((child) => {
          const renderable = child as THREE.Line | THREE.Mesh;
          if (!renderable.material) return;
          const materials = Array.isArray(renderable.material) ? renderable.material : [renderable.material];
          materials.forEach((material) => { material.transparent = true; material.opacity = 0.75; material.depthTest = false; });
        });
        group.add(object);
      }
      this.previewObject = group;
      this.scene.add(group);
      return;
    }
    if (preview.type === 'rotate') {
      const rotation = preview.data as { start: Vec2; end: Vec2; entities: Entity[] };
      const group = new THREE.Group();
      for (const entity of rotation.entities) {
        const object = this.entityToObject(entity);
        object.traverse((child) => {
          const renderable = child as THREE.Line | THREE.Mesh;
          if (!renderable.material) return;
          const materials = Array.isArray(renderable.material) ? renderable.material : [renderable.material];
          materials.forEach((material) => {
            material.transparent = true;
            material.opacity = 0.9;
            material.depthTest = false;
          });
        });
        group.add(object);
      }
      const guideGeometry = new THREE.BufferGeometry().setFromPoints([rotation.start, rotation.end].map((point) => {
        const world = localToWorld(this.activeWorkPlane, point, 0.04);
        return new THREE.Vector3(world.x, world.z, -world.y);
      }));
      const guide = new THREE.Line(guideGeometry, new THREE.LineBasicMaterial({ color: 0xffc857, depthTest: false }));
      guide.renderOrder = 21;
      group.add(guide);
      group.renderOrder = 20;
      this.previewObject = group;
      this.scene.add(group);
      return;
    }
    if (preview.type === 'text') {
      const text = preview.data as { position: Vec2; text: string; font?: string; height?: number };
      if (!text.text) return;
      this.previewObject = this.textToObject(
        text.position, text.text, text.height ?? 2.5, text.font ?? 'Arial',
        this.activeWorkPlane, 0xaaaaaa, 0.72,
      );
      this.previewObject.renderOrder = 20;
      this.scene.add(this.previewObject);
      return;
    }
    const data = preview.data as Record<string, Vec2> & { sides?: number };
    const points: Vec2[] = [];
    let loop = false;
    if ((preview.type === 'line' || preview.type === 'move') && data.start && data.end) {
      points.push(data.start, data.end);
    } else if (preview.type === 'polyline') {
      const chain = preview.data as unknown as { vertices: Vec2[]; cursor: Vec2 };
      points.push(...chain.vertices, chain.cursor);
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
    } else if (preview.type === 'arc') {
      const q=preview.data as unknown as {center:Vec2;start:Vec2;cursor:Vec2};const r=Math.hypot(q.start.x-q.center.x,q.start.y-q.center.y);const start=Math.atan2(q.start.y-q.center.y,q.start.x-q.center.x);let sweep=Math.atan2(q.cursor.y-q.center.y,q.cursor.x-q.center.x)-start;if(sweep<=0)sweep+=Math.PI*2;for(let i=0;i<=64;i++){const a=start+sweep*i/64;points.push({x:q.center.x+Math.cos(a)*r,y:q.center.y+Math.sin(a)*r});}
    } else if (preview.type === 'bezier') {
      const q=preview.data as unknown as {start:Vec2;control1:Vec2;control2:Vec2;end:Vec2};for(let i=0;i<=64;i++){const t=i/64,u=1-t;points.push({x:u**3*q.start.x+3*u*u*t*q.control1.x+3*u*t*t*q.control2.x+t**3*q.end.x,y:u**3*q.start.y+3*u*u*t*q.control1.y+3*u*t*t*q.control2.y+t**3*q.end.y});}
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
    return this.picking.pickGripIndex(canvas, grips, sx, sy, tolerance);
  }

  pickEntity(canvas: HTMLCanvasElement, entities: Entity[], sx: number, sy: number, tolerance = 12): Entity | null {
    const rect = canvas.getBoundingClientRect();
    const project = (entity: Entity, point: Vec2): Vec2 | null => {
      const world = localToWorld(entity.workPlane ?? WORLD_WORK_PLANE, point);
      const projected = new THREE.Vector3(world.x, world.z, -world.y).project(this.camera);
      if (projected.z < -1 || projected.z > 1) return null;
      return {
        x: rect.left + (projected.x + 1) * rect.width / 2,
        y: rect.top + (1 - projected.y) * rect.height / 2,
      };
    };
    const distanceToSegment = (point: Vec2, start: Vec2, end: Vec2): number => {
      const dx = end.x - start.x, dy = end.y - start.y;
      const lengthSquared = dx * dx + dy * dy;
      const t = lengthSquared > 0
        ? Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared))
        : 0;
      return Math.hypot(point.x - start.x - dx * t, point.y - start.y - dy * t);
    };
    const cursor = { x: sx, y: sy };
    const polygonContains = (point: Vec2, polygon: Vec2[]): boolean => {
      let inside = false;
      for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index++) {
        const a = polygon[index], b = polygon[previous];
        if ((a.y > point.y) !== (b.y > point.y)
          && point.x < (b.x - a.x) * (point.y - a.y) / (b.y - a.y) + a.x) inside = !inside;
      }
      return inside;
    };
    const polygonArea = (polygon: Vec2[]): number => Math.abs(polygon.reduce((area, point, index) => {
      const next = polygon[(index + 1) % polygon.length];
      return area + point.x * next.y - next.x * point.y;
    }, 0)) / 2;
    let bestEdgeDistance = tolerance;
    let edgeResult: Entity | null = null;
    let bestInsideArea = Number.POSITIVE_INFINITY;
    let insideResult: Entity | null = null;
    for (let entityIndex = entities.length - 1; entityIndex >= 0; entityIndex--) {
      const entity = entities[entityIndex];
      let points: Vec2[] = [];
      let closed = false;
      switch (entity.type) {
        case 'line': points = [entity.start, entity.end]; break;
        case 'circle':
          for (let index = 0; index < 72; index++) {
            const angle = index * Math.PI * 2 / 72;
            points.push({ x: entity.center.x + Math.cos(angle) * entity.radius, y: entity.center.y + Math.sin(angle) * entity.radius });
          }
          closed = true;
          break;
        case 'rectangle': points = [entity.first, { x: entity.opposite.x, y: entity.first.y }, entity.opposite, { x: entity.first.x, y: entity.opposite.y }]; closed = true; break;
        case 'octagon': points = entity.vertices; closed = true; break;
        case 'polyline': points = entity.vertices; closed = entity.closed; break;
        case 'arc':
        case 'bezier': points = curvePoints(entity, 64); break;
        case 'text': {
          const bounds = entityBounds(entity);
          points = [bounds.min, { x: bounds.max.x, y: bounds.min.y }, bounds.max, { x: bounds.min.x, y: bounds.max.y }];
          closed = true;
          break;
        }
        case 'dimension': {
          const geometry = dimensionGeometry(entity);
          points = [geometry.extensionStart[0], geometry.extensionStart[1], geometry.dimensionLine[0], geometry.dimensionLine[1], geometry.extensionEnd[0], geometry.extensionEnd[1]];
          break;
        }
      }
      const projected = points.map((point) => project(entity, point));
      const projectedPolygon = projected.filter((point): point is Vec2 => Boolean(point));
      if (closed && projectedPolygon.length === projected.length && polygonContains(cursor, projectedPolygon)) {
        const area = polygonArea(projectedPolygon);
        if (area < bestInsideArea) {
          bestInsideArea = area;
          insideResult = entity;
        }
      }
      const segmentCount = closed ? projected.length : projected.length - 1;
      for (let index = 0; index < segmentCount; index++) {
        const start = projected[index], end = projected[(index + 1) % projected.length];
        if (!start || !end) continue;
        const distance = distanceToSegment(cursor, start, end);
        if (distance <= bestEdgeDistance) { bestEdgeDistance = distance; edgeResult = entity; }
      }
    }
    return edgeResult ?? insideResult;
  }

  private entityToObject(entity: Entity): THREE.Object3D {
    if (entity.type === 'text') {
      return this.textToObject(
        entity.position, entity.text, entity.height, entity.font ?? 'Arial',
        entity.workPlane ?? WORLD_WORK_PLANE, entity.selected ? 0x65c7ff : entity.color, 1, entity.rotation ?? 0,
      );
    }
    if (entity.type === 'dimension') {
      const geometry = dimensionGeometry(entity);
      const group = new THREE.Group();
      const material = new THREE.LineBasicMaterial({ color: entity.selected ? 0x65c7ff : entity.color });
      const addLine = (points: Vec2[], loop = false): void => {
        const vertices = points.map(point => { const world = localToWorld(entity.workPlane ?? WORLD_WORK_PLANE, point, 0.015); return new THREE.Vector3(world.x, world.z, -world.y); });
        group.add(loop ? new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(vertices), material) : new THREE.Line(new THREE.BufferGeometry().setFromPoints(vertices), material));
      };
      addLine(geometry.extensionStart); addLine(geometry.extensionEnd); addLine(geometry.dimensionLine);
      geometry.arrows.forEach(arrow => {
        if (entity.arrowType === 'tick') addLine([arrow[1], arrow[2]]);
        else addLine([arrow[1], arrow[0], arrow[2]], entity.arrowType === 'closed');
      });
      group.add(this.textToObject(geometry.textPoint, geometry.text, entity.textHeight * entity.scale, 'Arial', entity.workPlane ?? WORLD_WORK_PLANE, entity.selected ? 0x65c7ff : entity.color, 1, geometry.textAngle, true));
      return group;
    }
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
      case 'ellipse': {
        points.push(...ellipsePoints(entity, 96).slice(0, -1));
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
      case 'arc': points.push(...curvePoints(entity)); break;
      case 'bezier': points.push(...curvePoints(entity)); break;
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

  private textToObject(
    position: Vec2,
    text: string,
    height: number,
    font: string,
    plane: WorkPlane,
    color: number,
    opacity = 1,
    rotation = 0,
    centered = false,
  ): THREE.Mesh {
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d')!;
    const pixelHeight = 192;
    context.font = `${pixelHeight}px ${JSON.stringify(font)}`;
    const measuredWidth = Math.max(1, Math.ceil(context.measureText(text).width));
    canvas.width = measuredWidth + 16;
    canvas.height = pixelHeight + 32;
    context.font = `${pixelHeight}px ${JSON.stringify(font)}`;
    context.textBaseline = 'alphabetic';
    context.fillStyle = '#ffffff';
    context.fillText(text, 8, pixelHeight + 8);

    const aspect = canvas.width / canvas.height;
    const objectHeight = Math.max(0.001, height);
    const objectWidth = objectHeight * aspect;
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.minFilter = THREE.LinearFilter;
    const material = new THREE.MeshBasicMaterial({
      map: texture,
      color,
      transparent: true,
      opacity,
      depthTest: false,
      side: THREE.DoubleSide,
    });
    const object = new THREE.Mesh(new THREE.PlaneGeometry(objectWidth, objectHeight), material);
    const centerOffset = {
      x: Math.cos(rotation) * objectWidth / 2 - Math.sin(rotation) * objectHeight / 2,
      y: Math.sin(rotation) * objectWidth / 2 + Math.cos(rotation) * objectHeight / 2,
    };
    const center = localToWorld(plane, centered ? position : { x: position.x + centerOffset.x, y: position.y + centerOffset.y }, 0.02);
    object.position.set(center.x, center.z, -center.y);
    const toThree = (axis: Vec3): THREE.Vector3 => new THREE.Vector3(axis.x, axis.z, -axis.y).normalize();
    const basis = new THREE.Matrix4().makeBasis(toThree(plane.xAxis), toThree(plane.yAxis), toThree(plane.zAxis));
    object.quaternion.setFromRotationMatrix(basis);
    object.rotateZ(rotation);
    object.renderOrder = 10;
    return object;
  }

  private disposeObject(object: THREE.Object3D): void {
    object.traverse((child) => {
      const renderable = child as THREE.Mesh | THREE.Line;
      renderable.geometry?.dispose();
      const materials = renderable.material
        ? (Array.isArray(renderable.material) ? renderable.material : [renderable.material])
        : [];
      for (const material of materials) {
        const mapped = material as THREE.Material & { map?: THREE.Texture };
        mapped.map?.dispose();
        material.dispose();
      }
    });
  }

  /**
   * Takes the mesh rather than the solid, because the press-pull preview needs
   * the same conversion for a mesh no solid holds yet — and a second copy of
   * the axis swap is a sign error waiting to happen.
   */
  private solidToGeometry(mesh: SolidMesh): THREE.BufferGeometry {
    const geom = new THREE.BufferGeometry();
    const pos = mesh.positions;
    // Manifold uses Z-up; Three.js is Y-up — swap Y and Z
    const swapped = new Float32Array(pos.length);
    for (let i = 0; i < pos.length; i += 3) {
      swapped[i] = pos[i];
      swapped[i + 1] = pos[i + 2];
      swapped[i + 2] = -pos[i + 1];
    }
    geom.setAttribute('position', new THREE.BufferAttribute(swapped, 3));
    geom.setIndex(Array.from(mesh.indices));
    geom.computeVertexNormals();
    return geom;
  }

  render(): void {
    this.renderer.render(this.scene, this.camera);
  }

  pickSolidFace(canvas: HTMLCanvasElement, sx: number, sy: number): SolidFaceSelection | null {
    const hit = this.picking.firstIntersection(canvas, sx, sy, this.solidMeshes.values());
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

  /**
   * How far the pointer has dragged a face along its own normal. A face may
   * only travel that one way, so the pointer's other dimension is discarded
   * rather than guessed at.
   */
  /** The ray under the pointer, in CAD coordinates. */
  pointerRay(canvas: HTMLCanvasElement, sx: number, sy: number): { origin: Vec3; direction: Vec3 } {
    return this.picking.pointerRay(canvas, sx, sy);
  }

  faceDragDelta(canvas: HTMLCanvasElement, solid: Solid, face: SolidFaceSelection, sx: number, sy: number): number | null {
    const centre = verticesCentre(solid.mesh.positions, face.vertexIndices);
    if (!centre) return null;
    const ray = this.picking.pointerRay(canvas, sx, sy);
    return axisOffsetUnderRay(centre, face.normal, ray.origin, ray.direction);
  }

  projectCadPoint(canvas: HTMLCanvasElement, point: Vec3): Vec2 | null {
    return this.projection.projectCadPoint(canvas, point);
  }

  clearFaceHighlight(): void {
    if (!this.faceHighlight) return;
    this.scene.remove(this.faceHighlight);
    this.faceHighlight.geometry.dispose();
    (this.faceHighlight.material as THREE.Material).dispose();
    this.faceHighlight = null;
  }

  clearEdgeHighlight(): void {
    if (!this.edgeHighlight) return;
    this.scene.remove(this.edgeHighlight);
    this.edgeHighlight.geometry.dispose();
    (this.edgeHighlight.material as THREE.Material).dispose();
    this.edgeHighlight = null;
  }

  pickSolidEdge(canvas: HTMLCanvasElement, solids: Solid[], sx: number, sy: number, tolerance = 11): SolidEdgeSelection | null {
    const rect = canvas.getBoundingClientRect();
    type EdgeData = { a: number; b: number; normals: Vec3[] };
    let best = tolerance;
    let result: SolidEdgeSelection | null = null;
    const project = (point: Vec3): { x: number; y: number; z: number } => {
      const p = new THREE.Vector3(point.x, point.z, -point.y).project(this.camera);
      return { x: rect.left + (p.x + 1) * rect.width / 2, y: rect.top + (1 - p.y) * rect.height / 2, z: p.z };
    };
    for (const solid of solids) {
      const positions = solid.mesh.positions;
      const indices = solid.mesh.indices;
      const edges = new Map<string, EdgeData>();
      for (let i = 0; i < indices.length; i += 3) {
        const ids = [indices[i], indices[i + 1], indices[i + 2]];
        const point = (id: number): Vec3 => ({ x: positions[id * 3], y: positions[id * 3 + 1], z: positions[id * 3 + 2] });
        const p0 = point(ids[0]); const p1 = point(ids[1]); const p2 = point(ids[2]);
        const ux = p1.x - p0.x; const uy = p1.y - p0.y; const uz = p1.z - p0.z;
        const vx = p2.x - p0.x; const vy = p2.y - p0.y; const vz = p2.z - p0.z;
        const length = Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) || 1;
        const normal = { x: (uy * vz - uz * vy) / length, y: (uz * vx - ux * vz) / length, z: (ux * vy - uy * vx) / length };
        for (let e = 0; e < 3; e++) {
          const a = ids[e]; const b = ids[(e + 1) % 3];
          const key = a < b ? `${a}:${b}` : `${b}:${a}`;
          const edge = edges.get(key) ?? { a: Math.min(a, b), b: Math.max(a, b), normals: [] };
          edge.normals.push(normal);
          edges.set(key, edge);
        }
      }
      for (const edge of edges.values()) {
        if (edge.normals.length !== 2) continue;
        const dot = edge.normals[0].x * edge.normals[1].x + edge.normals[0].y * edge.normals[1].y + edge.normals[0].z * edge.normals[1].z;
        if (dot > 0.995) continue; // internal triangulation edge
        const a = { x: positions[edge.a * 3], y: positions[edge.a * 3 + 1], z: positions[edge.a * 3 + 2] };
        const b = { x: positions[edge.b * 3], y: positions[edge.b * 3 + 1], z: positions[edge.b * 3 + 2] };
        const pa = project(a); const pb = project(b);
        if (pa.z < -1 || pa.z > 1 || pb.z < -1 || pb.z > 1) continue;
        const dx = pb.x - pa.x; const dy = pb.y - pa.y;
        const t = Math.max(0, Math.min(1, ((sx - pa.x) * dx + (sy - pa.y) * dy) / (dx * dx + dy * dy || 1)));
        const distance = Math.hypot(sx - (pa.x + dx * t), sy - (pa.y + dy * t));
        if (distance <= best) {
          best = distance;
          result = { solidId: solid.id, start: a, end: b, normalA: edge.normals[0], normalB: edge.normals[1] };
        }
      }
    }
    this.clearEdgeHighlight();
    if (result) {
      const points = [result.start, result.end].map((point) => new THREE.Vector3(point.x, point.z, -point.y));
      this.edgeHighlight = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(points),
        new THREE.LineBasicMaterial({ color: 0x32aaff, depthTest: false }),
      );
      this.edgeHighlight.renderOrder = 50;
      this.scene.add(this.edgeHighlight);
    }
    return result;
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
    return this.picking.pickObjectId(canvas, sx, sy, this.solidMeshes, excludedIds);
  }

  groundPoint(canvas: HTMLCanvasElement, sx: number, sy: number): Vec2 | null {
    return this.projection.groundPoint(canvas, sx, sy);
  }

  workPlanePoint(canvas: HTMLCanvasElement, sx: number, sy: number, plane: WorkPlane = this.activeWorkPlane): Vec2 | null {
    return this.projection.workPlanePoint(canvas, sx, sy, plane);
  }

  viewPlanePoint(canvas: HTMLCanvasElement, sx: number, sy: number): Vec2 | null {
    return this.projection.viewPlanePoint(canvas, sx, sy);
  }

  cadPointToViewPlane(point: Vec3): Vec2 {
    return this.projection.cadPointToViewPlane(point);
  }

  screenDeltaToCad(delta: Vec2): { x: number; y: number; z: number } {
    const standardDelta = standardViewDelta(delta, this.activeStandardView);
    if (standardDelta) return standardDelta;
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(this.camera.quaternion);
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(this.camera.quaternion);
    const world = right.multiplyScalar(delta.x).add(up.multiplyScalar(delta.y));
    return { x: world.x, y: -world.z, z: world.y };
  }
}
