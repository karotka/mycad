import { randomBytes } from 'node:crypto';
import { chmod, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface DesktopBridgeRequest {
  method: string;
  params: Record<string, unknown>;
}

export type DesktopBridgeDispatch = (request: DesktopBridgeRequest) => Promise<unknown>;

const HOST = '127.0.0.1' as const;
const MAX_REQUEST_BYTES = 1024 * 1024;
const ALLOWED_METHODS = new Set([
  'new_document', 'open_project', 'get_document', 'list_objects', 'get_object',
  'select_objects', 'create_primitive', 'create_lines', 'boolean_solids', 'delete_feature',
  'delete_objects', 'undo', 'redo', 'save_project', 'export_stl',
]);

export function desktopBridgeDiscoveryPath(): string {
  const user = typeof process.getuid === 'function' ? String(process.getuid()) : 'user';
  return join(tmpdir(), `mycad-mcp-${user}.json`);
}

/**
 * Authenticated newline-delimited JSON bridge bound only to loopback. The MCP
 * stdio process discovers its ephemeral port and secret through a mode-0600
 * file. One connection carries one request, keeping framing deliberately small.
 */
export class McpBridgeServer {
  private server: Server | null = null;
  private readonly token = randomBytes(32).toString('hex');

  constructor(
    private readonly dispatch: DesktopBridgeDispatch,
    readonly discoveryPath = desktopBridgeDiscoveryPath(),
  ) {}

  async start(): Promise<void> {
    if (this.server) return;
    const server = createServer((socket) => this.handleSocket(socket));
    await new Promise<void>((resolve, reject) => {
      const failed = (error: Error) => reject(error);
      server.once('error', failed);
      server.listen(0, HOST, () => {
        server.off('error', failed);
        resolve();
      });
    });
    this.server = server;
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Could not determine the MyCAD MCP bridge port.');
    const discovery = JSON.stringify({
      version: 1,
      host: HOST,
      port: address.port,
      token: this.token,
      pid: process.pid,
      startedAt: new Date().toISOString(),
    });
    const temporary = `${this.discoveryPath}.${process.pid}.tmp`;
    await writeFile(temporary, discovery, { encoding: 'utf8', mode: 0o600 });
    await chmod(temporary, 0o600);
    await rename(temporary, this.discoveryPath);
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    try {
      const current = JSON.parse(await readFile(this.discoveryPath, 'utf8')) as { token?: unknown };
      if (current.token === this.token) await unlink(this.discoveryPath);
    } catch {
      // A crash, another app instance, or external cleanup may remove it first.
    }
  }

  private handleSocket(socket: Socket): void {
    socket.setEncoding('utf8');
    let input = '';
    let handled = false;
    socket.on('data', (chunk: string) => {
      if (handled) return;
      input += chunk;
      if (Buffer.byteLength(input, 'utf8') > MAX_REQUEST_BYTES) {
        handled = true;
        this.reply(socket, '', false, undefined, 'MCP bridge request is too large.');
        return;
      }
      const newline = input.indexOf('\n');
      if (newline < 0) return;
      handled = true;
      void this.handleLine(socket, input.slice(0, newline));
    });
  }

  private async handleLine(socket: Socket, line: string): Promise<void> {
    let id = '';
    try {
      const request = JSON.parse(line) as {
        version?: unknown;
        token?: unknown;
        id?: unknown;
        method?: unknown;
        params?: unknown;
      };
      id = typeof request.id === 'string' ? request.id : '';
      if (request.version !== 1 || request.token !== this.token) throw new Error('MCP bridge authentication failed.');
      if (!id) throw new Error('MCP bridge request ID is missing.');
      if (typeof request.method !== 'string' || !ALLOWED_METHODS.has(request.method)) throw new Error('Unknown MCP bridge method.');
      if (!request.params || typeof request.params !== 'object' || Array.isArray(request.params)) throw new Error('Invalid MCP bridge parameters.');
      const result = await this.dispatch({ method: request.method, params: request.params as Record<string, unknown> });
      this.reply(socket, id, true, result);
    } catch (error) {
      this.reply(socket, id, false, undefined, error instanceof Error ? error.message : String(error));
    }
  }

  private reply(socket: Socket, id: string, ok: boolean, result?: unknown, error?: string): void {
    socket.end(`${JSON.stringify({ id, ok, ...(ok ? { result } : { error }) })}\n`);
  }
}
