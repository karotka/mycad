import { describe, expect, it } from 'vitest';
import { buildExactFeature } from '../geometry/ExactSolid';
import { solidDesignEdges } from './SolidTopology';
import type { SolidFeature } from '../entities/types';

/**
 * With an exact kernel every triangle knows its B-rep face, so the wireframe is
 * drawn straight from that map — no coplanarity or smooth-group guessing.
 */
describe('solidDesignEdges from exact face ids', () => {
  it('draws a box as exactly its twelve edges, no triangulation diagonals', async () => {
    const box = await buildExactFeature({
      kind: 'primitive', primitive: 'box', center: { x: 0, y: 0 }, width: 10, depth: 10, height: 10,
    } as SolidFeature);
    expect(box?.mesh.triangleFaceIds).toBeDefined();
    expect(solidDesignEdges(box!.mesh).length).toBe(12);
  });

  it('hides a cylindrical hole’s wall facets and keeps its rims', async () => {
    const holed = await buildExactFeature({
      kind: 'boolean', operation: 'subtract', operands: [
        { kind: 'primitive', primitive: 'box', center: { x: 0, y: 0 }, width: 20, depth: 20, height: 20 },
        { kind: 'primitive', primitive: 'cylinder', center: { x: 0, y: 0 }, radius: 3, height: 30 },
      ],
    } as SolidFeature);
    const edges = solidDesignEdges(holed!.mesh);
    // The bore is one B-rep face: no vertical near-axis facet edge should survive.
    const wallFacets = edges.filter((edge) => {
      const mx = (edge.start.x + edge.end.x) / 2, my = (edge.start.y + edge.end.y) / 2;
      return Math.hypot(mx, my) < 5 && Math.abs(edge.start.z - edge.end.z) > 1;
    });
    expect(wallFacets.length).toBe(0);
    expect(edges.length).toBeGreaterThan(12); // the box edges plus the two rim loops
  });
});
