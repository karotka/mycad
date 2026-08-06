import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as z from 'zod/v4';
import type { CadMcpBackend } from './CadMcpBackend';
import { CadMcpSession } from './CadMcpSession';

const vec3 = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  z: z.number().finite(),
});

const center = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  z: z.number().finite().optional().describe('Base elevation along the active UCS Z axis.'),
});

function result(value: unknown) {
  const structured = { result: value };
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(structured, null, 2) }],
    structuredContent: structured,
  };
}

/** Registers the first headless MyCAD MCP surface around one document session. */
export function createMyCadMcpServer(session: CadMcpBackend = new CadMcpSession()): McpServer {
  const server = new McpServer(
    { name: 'mycad', version: '0.1.0' },
    {
      instructions: [
        'MyCAD works in millimetres.',
        'Call get_document or list_objects before editing an existing project.',
        'Primitive coordinates are expressed in the active UCS.',
        'Mutating tools participate in MyCAD Undo/Redo.',
        'In desktop mode, reads and edits target the document visible in the open MyCAD window.',
        'STL export requires explicit solidIds or a prior select_objects call.',
      ].join(' '),
    },
  );

  server.registerResource(
    'document',
    'mycad://document',
    { title: 'Current MyCAD document', description: 'Counts, selection and active UCS.', mimeType: 'application/json' },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(await session.summary(), null, 2) }] }),
  );

  server.registerResource(
    'selection',
    'mycad://selection',
    { title: 'Current MyCAD selection', description: 'Selected drawing entities and solids.', mimeType: 'application/json' },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(await session.listObjects(true), null, 2) }] }),
  );

  server.registerTool('new_document', {
    description: 'Replace the in-memory document with a new empty MyCAD drawing.',
    annotations: { destructiveHint: true, idempotentHint: false },
  }, async () => result(await session.newDocument()));

  server.registerTool('open_project', {
    description: 'Open a .mycad project, replacing the current in-memory document.',
    inputSchema: { path: z.string().min(1).describe('Absolute or working-directory-relative .mycad path.') },
    annotations: { destructiveHint: true, idempotentHint: true },
  }, async ({ path }) => result(await session.openProject(path)));

  server.registerTool('get_document', {
    description: 'Return document counts, current selection, active UCS and Undo/Redo availability.',
    annotations: { readOnlyHint: true, idempotentHint: true },
  }, async () => result(await session.summary()));

  server.registerTool('list_objects', {
    description: 'List lightweight summaries of drawing entities and 3D solids.',
    inputSchema: { selectedOnly: z.boolean().optional().default(false) },
    annotations: { readOnlyHint: true, idempotentHint: true },
  }, async ({ selectedOnly }) => result(await session.listObjects(selectedOnly)));

  server.registerTool('get_object', {
    description: 'Get one object, including an entity payload or a solid feature tree without raw mesh arrays.',
    inputSchema: { id: z.string().min(1) },
    annotations: { readOnlyHint: true, idempotentHint: true },
  }, async ({ id }) => result(await session.getObject(id)));

  server.registerTool('select_objects', {
    description: 'Replace, extend or reduce the current selection using stable MyCAD object IDs.',
    inputSchema: {
      ids: z.array(z.string().min(1)),
      mode: z.enum(['replace', 'add', 'remove']).optional().default('replace'),
    },
    annotations: { idempotentHint: true },
  }, async ({ ids, mode }) => result(await session.selectObjects(ids, mode)));

  server.registerTool('create_primitive', {
    description: 'Create one parametric primitive in the active UCS and select the new solid.',
    inputSchema: {
      primitive: z.enum(['box', 'wedge', 'sphere', 'cone', 'cylinder', 'pyramid', 'torus']),
      center,
      name: z.string().min(1).optional(),
      width: z.number().positive().optional().describe('Required for box and wedge.'),
      depth: z.number().positive().optional().describe('Required for box and wedge.'),
      height: z.number().positive().optional().describe('Required except for sphere and torus.'),
      radius: z.number().positive().optional().describe('Required for radial primitives.'),
      radiusTop: z.number().nonnegative().optional().describe('Optional far radius for a cone/frustum.'),
      tubeRadius: z.number().positive().optional().describe('Required for torus and smaller than radius.'),
    },
    annotations: { destructiveHint: false, idempotentHint: false },
  }, async (input) => result(await session.createPrimitive(input)));

  server.registerTool('create_lines', {
    description: 'Create one or more independent 3D line entities. Coordinates are expressed in the active UCS.',
    inputSchema: {
      segments: z.array(z.object({ start: center, end: center })).min(1).max(10000),
    },
    annotations: { destructiveHint: false, idempotentHint: false },
  }, async ({ segments }) => result(await session.createLines(segments)));

  server.registerTool('extrude', {
    description: 'Extrude a closed profile into a solid along the active UCS Z axis. Give an existing closed profile by profileId, or points to trace a closed outline in the active UCS. Height is signed — negative extrudes downward. Points may carry a z so an outline traced at a height extrudes from that height.',
    inputSchema: {
      profileId: z.string().min(1).optional().describe('ID of an existing closed profile (rectangle, circle, octagon or closed polyline). Provide this or points.'),
      points: z.array(center).min(3).optional().describe('Outline vertices in the active UCS; a closed polyline is built from them. Provide this or profileId.'),
      height: z.number().finite().describe('Extrusion distance in mm; negative extrudes downward.'),
      name: z.string().min(1).optional(),
    },
    annotations: { destructiveHint: false, idempotentHint: false },
  }, async (input) => result(await session.extrude(input)));

  server.registerTool('boolean_solids', {
    description: 'Union solids, subtract every later solid from the first, or keep their common volume. Sources are replaced by one parametric result.',
    inputSchema: {
      operation: z.enum(['union', 'subtract', 'intersect']),
      solidIds: z.array(z.string().min(1)).min(2),
      name: z.string().min(1).optional(),
    },
    annotations: { destructiveHint: true, idempotentHint: false },
  }, async ({ operation, solidIds, name }) => result(await session.booleanOperation(operation, solidIds, name)));

  server.registerTool('delete_feature', {
    description: 'Remove the modelling feature on an oriented solid surface, such as a hole, bump, fillet or chamfer.',
    inputSchema: {
      solidId: z.string().min(1),
      point: vec3.describe('World-space point on the surface.'),
      normal: vec3.describe('Outward world-space normal of the clicked final-solid surface.'),
    },
    annotations: { destructiveHint: true, idempotentHint: false },
  }, async ({ solidId, point, normal }) => result(await session.deleteFeature(solidId, point, normal)));

  server.registerTool('delete_objects', {
    description: 'Delete entities and solids by ID as one undoable edit.',
    inputSchema: { ids: z.array(z.string().min(1)).min(1) },
    annotations: { destructiveHint: true, idempotentHint: false },
  }, async ({ ids }) => result(await session.deleteObjects(ids)));

  server.registerTool('undo', {
    description: 'Undo the latest MCP modelling edit.',
    annotations: { destructiveHint: false, idempotentHint: false },
  }, async () => result(await session.undo()));

  server.registerTool('redo', {
    description: 'Redo the latest undone MCP modelling edit.',
    annotations: { destructiveHint: false, idempotentHint: false },
  }, async () => result(await session.redo()));

  server.registerTool('save_project', {
    description: 'Save the in-memory document as a .mycad project. Omit path only after open_project or a previous save.',
    inputSchema: { path: z.string().min(1).optional() },
    annotations: { destructiveHint: false, idempotentHint: true },
  }, async ({ path }) => result(await session.saveProject(path)));

  server.registerTool('export_stl', {
    description: 'Export explicit or currently selected solids to one ASCII STL file.',
    inputSchema: {
      path: z.string().min(1).describe('Destination .stl path.'),
      solidIds: z.array(z.string().min(1)).min(1).optional(),
    },
    annotations: { destructiveHint: false, idempotentHint: true },
  }, async ({ path, solidIds }) => result(await session.exportStl(path, solidIds)));

  return server;
}
