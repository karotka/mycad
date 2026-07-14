import type { Document } from '../core/Document';

export function serializeProject(doc: Document): string {
  return JSON.stringify({
    format: 'mycad',
    version: 1,
    units: 'mm',
    settings: {
      currentLayer: doc.currentLayer,
      gridSize: doc.gridSize,
      snapSize: doc.snapSize,
      snapEnabled: doc.snapEnabled,
      activeWorkPlane: doc.activeWorkPlane,
    },
    entities: doc.entities,
    solids: doc.solids.map((solid) => ({
      ...solid,
      selected: false,
      mesh: {
        positions: Array.from(solid.mesh.positions),
        indices: Array.from(solid.mesh.indices),
      },
    })),
  }, null, 2);
}

export function loadProject(doc: Document, content: string): void {
  const value = JSON.parse(content) as Record<string, unknown>;
  if (value.format !== 'mycad' || value.version !== 1) throw new Error('Unsupported project format.');
  if (!Array.isArray(value.entities) || !Array.isArray(value.solids)) throw new Error('The project does not contain valid CAD data.');
  const entities = value.entities as unknown[];
  const solids = value.solids as unknown[];
  const settings = (value.settings ?? {}) as Record<string, unknown>;
  doc.transaction(() => {
    doc.entities = entities.map((entity: unknown) => ({ ...(entity as object), selected: false })) as Document['entities'];
    doc.solids = solids.map((raw: unknown) => {
      const solid = raw as Record<string, unknown>;
      const mesh = solid.mesh as { positions?: unknown; indices?: unknown };
      if (!mesh || !Array.isArray(mesh.positions) || !Array.isArray(mesh.indices)) throw new Error('The project contains an invalid 3D solid.');
      return {
        ...solid,
        selected: false,
        mesh: { positions: new Float32Array(mesh.positions as number[]), indices: new Uint32Array(mesh.indices as number[]) },
      };
    }) as Document['solids'];
    doc.currentLayer = typeof settings.currentLayer === 'string' ? settings.currentLayer : '0';
    doc.gridSize = typeof settings.gridSize === 'number' ? settings.gridSize : 1;
    doc.snapSize = typeof settings.snapSize === 'number' ? settings.snapSize : 0.5;
    doc.snapEnabled = typeof settings.snapEnabled === 'boolean' ? settings.snapEnabled : true;
    if (settings.activeWorkPlane && typeof settings.activeWorkPlane === 'object') {
      doc.activeWorkPlane = JSON.parse(JSON.stringify(settings.activeWorkPlane));
    }
    doc.viewMode = '2d';
    doc.selectedEntityIds.clear();
    doc.selectedSolidIds.clear();
    doc.notify();
  });
}

export function exportAsciiStl(doc: Document, name = 'MyCAD'): string {
  const lines = [`solid ${sanitizeName(name)}`];
  for (const solid of doc.solids) {
    const positions = solid.mesh.positions;
    const indices = solid.mesh.indices;
    for (let i = 0; i + 2 < indices.length; i += 3) {
      const a = vertex(positions, indices[i]);
      const b = vertex(positions, indices[i + 1]);
      const c = vertex(positions, indices[i + 2]);
      const normal = triangleNormal(a, b, c);
      lines.push(`  facet normal ${normal.join(' ')}`);
      lines.push('    outer loop');
      lines.push(`      vertex ${a.join(' ')}`);
      lines.push(`      vertex ${b.join(' ')}`);
      lines.push(`      vertex ${c.join(' ')}`);
      lines.push('    endloop');
      lines.push('  endfacet');
    }
  }
  lines.push(`endsolid ${sanitizeName(name)}`);
  return `${lines.join('\n')}\n`;
}

function vertex(positions: Float32Array, index: number): [number, number, number] {
  const offset = index * 3;
  return [positions[offset], positions[offset + 1], positions[offset + 2]];
}

function triangleNormal(a: number[], b: number[], c: number[]): [number, number, number] {
  const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
  const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
  const x = uy * vz - uz * vy;
  const y = uz * vx - ux * vz;
  const z = ux * vy - uy * vx;
  const length = Math.hypot(x, y, z);
  return length < 1e-12 ? [0, 0, 0] : [x / length, y / length, z / length];
}

function sanitizeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]+/g, '_');
}
