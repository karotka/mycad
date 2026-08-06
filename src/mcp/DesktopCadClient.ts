import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { createConnection, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { CadMcpBackend } from './CadMcpBackend';
import type { DocumentSummary, ExtrudeInput, LineSegmentInput, PrimitiveInput, SelectionMode } from './CadModelApi';

interface Discovery {
  version: 1;
  host: '127.0.0.1';
  port: number;
  token: string;
  pid: number;
}

interface BridgeResponse<T> {
  id: string;
  ok: boolean;
  result?: T;
  error?: string;
}

const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 120_000;

export function desktopBridgeDiscoveryPath(): string {
  const user = typeof process.getuid === 'function' ? String(process.getuid()) : 'user';
  return join(tmpdir(), `mycad-mcp-${user}.json`);
}

function validDiscovery(value: unknown): value is Discovery {
  const discovery = value as Partial<Discovery> | null;
  return Boolean(discovery
    && discovery.version === 1
    && discovery.host === '127.0.0.1'
    && Number.isInteger(discovery.port)
    && Number(discovery.port) > 0
    && Number(discovery.port) <= 65535
    && typeof discovery.token === 'string'
    && discovery.token.length >= 32
    && Number.isInteger(discovery.pid));
}

/** RPC client for the Document owned by the currently open MyCAD window. */
export class DesktopCadClient implements CadMcpBackend {
  constructor(
    private readonly discoveryPath = desktopBridgeDiscoveryPath(),
    private readonly connect: (options: { host: string; port: number }) => Socket = createConnection,
  ) {}

  private async call<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    let discovery: Discovery;
    try {
      const parsed: unknown = JSON.parse(await readFile(this.discoveryPath, 'utf8'));
      if (!validDiscovery(parsed)) throw new Error('invalid discovery data');
      discovery = parsed;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`MyCAD desktop bridge is unavailable. Start the MyCAD application first. (${detail})`);
    }

    const id = randomUUID();
    return new Promise<T>((resolve, reject) => {
      const socket = this.connect({ host: discovery.host, port: discovery.port });
      let data = '';
      let settled = false;
      const finish = (error?: Error, value?: T) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        if (error) reject(error);
        else resolve(value as T);
      };
      socket.setTimeout(REQUEST_TIMEOUT_MS, () => finish(new Error(`MyCAD desktop did not answer ${method} in time.`)));
      socket.on('error', (error) => finish(new Error(`Cannot connect to the open MyCAD window: ${error.message}`)));
      socket.on('connect', () => {
        socket.write(`${JSON.stringify({ version: 1, token: discovery.token, id, method, params })}\n`);
      });
      socket.on('data', (chunk) => {
        data += chunk.toString('utf8');
        if (Buffer.byteLength(data, 'utf8') > MAX_RESPONSE_BYTES) {
          finish(new Error('MyCAD desktop returned an oversized response.'));
          return;
        }
        const newline = data.indexOf('\n');
        if (newline < 0) return;
        try {
          const response = JSON.parse(data.slice(0, newline)) as BridgeResponse<T>;
          if (response.id !== id) throw new Error('MyCAD desktop returned a mismatched response.');
          if (!response.ok) throw new Error(response.error || `MyCAD desktop rejected ${method}.`);
          finish(undefined, response.result as T);
        } catch (error) {
          finish(error instanceof Error ? error : new Error(String(error)));
        }
      });
      socket.on('end', () => {
        if (!settled) finish(new Error('MyCAD desktop closed the bridge without a response.'));
      });
    });
  }

  newDocument(): Promise<DocumentSummary> { return this.call('new_document'); }
  openProject(path: string): Promise<DocumentSummary> { return this.call('open_project', { path: resolve(path) }); }
  saveProject(path?: string): Promise<{ path: string; summary: DocumentSummary }> {
    return this.call('save_project', { path: path === undefined ? undefined : resolve(path) });
  }
  summary(): Promise<DocumentSummary> { return this.call('get_document'); }
  listObjects(selectedOnly = false): Promise<Array<Record<string, unknown>>> { return this.call('list_objects', { selectedOnly }); }
  getObject(id: string): Promise<Record<string, unknown>> { return this.call('get_object', { id }); }
  selectObjects(ids: readonly string[], mode: SelectionMode = 'replace'): Promise<DocumentSummary> {
    return this.call('select_objects', { ids, mode });
  }
  createPrimitive(input: PrimitiveInput): Promise<Record<string, unknown>> { return this.call('create_primitive', { ...input }); }
  createLines(segments: readonly LineSegmentInput[]): Promise<Array<Record<string, unknown>>> {
    return this.call('create_lines', { segments });
  }
  extrude(input: ExtrudeInput): Promise<Record<string, unknown>> { return this.call('extrude', { ...input }); }
  booleanOperation(operation: 'union' | 'subtract' | 'intersect', solidIds: readonly string[], name?: string): Promise<Record<string, unknown>> {
    return this.call('boolean_solids', { operation, solidIds, name });
  }
  deleteFeature(
    solidId: string,
    point: { x: number; y: number; z: number },
    normal: { x: number; y: number; z: number },
  ): Promise<Record<string, unknown>> {
    return this.call('delete_feature', { solidId, point, normal });
  }
  deleteObjects(ids: readonly string[]): Promise<DocumentSummary> { return this.call('delete_objects', { ids }); }
  undo(): Promise<DocumentSummary> { return this.call('undo'); }
  redo(): Promise<DocumentSummary> { return this.call('redo'); }
  exportStl(path: string, solidIds?: readonly string[]): Promise<{ path: string; solidIds: string[] }> {
    return this.call('export_stl', { path: resolve(path), solidIds });
  }
}
