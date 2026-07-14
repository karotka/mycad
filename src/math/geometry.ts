export interface Vec2 {
  x: number;
  y: number;
}

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export function vec2(x = 0, y = 0): Vec2 {
  return { x, y };
}

export function vec3(x = 0, y = 0, z = 0): Vec3 {
  return { x, y, z };
}

export function dist2(a: Vec2, b: Vec2): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  return Math.sqrt(dx * dx + dy * dy);
}

export function dist3(a: Vec3, b: Vec3): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const dz = b.z - a.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

export function snapValue(v: number, grid = 1): number {
  return Math.round(v / grid) * grid;
}

export function snapPoint2(p: Vec2, grid = 1): Vec2 {
  return { x: snapValue(p.x, grid), y: snapValue(p.y, grid) };
}

export function midpoint2(a: Vec2, b: Vec2): Vec2 {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

export function mirrorPoint2(p: Vec2, axisStart: Vec2, axisEnd: Vec2): Vec2 {
  const dx = axisEnd.x - axisStart.x;
  const dy = axisEnd.y - axisStart.y;
  const len2 = dx * dx + dy * dy;
  if (len2 < 1e-12) return { ...p };
  const t = ((p.x - axisStart.x) * dx + (p.y - axisStart.y) * dy) / len2;
  const proj = { x: axisStart.x + t * dx, y: axisStart.y + t * dy };
  return { x: 2 * proj.x - p.x, y: 2 * proj.y - p.y };
}

export function octagonVertices(center: Vec2, radius: number): Vec2[] {
  const verts: Vec2[] = [];
  for (let i = 0; i < 8; i++) {
    const angle = (Math.PI / 4) * i + Math.PI / 8;
    verts.push({
      x: center.x + radius * Math.cos(angle),
      y: center.y + radius * Math.sin(angle),
    });
  }
  return verts;
}

export function parsePoint(input: string): Vec2 | null {
  const parts = input.trim().split(/[,;\s]+/).filter(Boolean);
  if (parts.length < 2) return null;
  const x = parseFloat(parts[0]);
  const y = parseFloat(parts[1]);
  if (isNaN(x) || isNaN(y)) return null;
  return { x, y };
}

export function formatPoint(p: Vec2 | Vec3): string {
  if ('z' in p) {
    return `${p.x.toFixed(4)}, ${p.y.toFixed(4)}, ${p.z.toFixed(4)}`;
  }
  return `${p.x.toFixed(4)}, ${p.y.toFixed(4)}`;
}

export function screenToWorld(
  sx: number,
  sy: number,
  canvasW: number,
  canvasH: number,
  pan: Vec2,
  zoom: number
): Vec2 {
  const cx = canvasW / 2;
  const cy = canvasH / 2;
  return {
    x: (sx - cx) / zoom + pan.x,
    y: -(sy - cy) / zoom + pan.y,
  };
}

export function worldToScreen(
  p: Vec2,
  canvasW: number,
  canvasH: number,
  pan: Vec2,
  zoom: number
): { x: number; y: number } {
  const cx = canvasW / 2;
  const cy = canvasH / 2;
  return {
    x: (p.x - pan.x) * zoom + cx,
    y: -(p.y - pan.y) * zoom + cy,
  };
}

export function polygonSignedArea(verts: Vec2[]): number {
  let area = 0;
  for (let i = 0; i < verts.length; i++) {
    const j = (i + 1) % verts.length;
    area += verts[i].x * verts[j].y;
    area -= verts[j].x * verts[i].y;
  }
  return area / 2;
}

export function polygonArea(verts: Vec2[]): number {
  return Math.abs(polygonSignedArea(verts));
}

export function isClosedPolyline(verts: Vec2[], tol = 1e-6): boolean {
  if (verts.length < 3) return false;
  const first = verts[0];
  const last = verts[verts.length - 1];
  return dist2(first, last) < tol;
}

export function closePolyline(verts: Vec2[]): Vec2[] {
  if (verts.length < 3) return [...verts];
  const first = verts[0];
  const last = verts[verts.length - 1];
  if (dist2(first, last) < 1e-6) return [...verts];
  return [...verts, { ...first }];
}
