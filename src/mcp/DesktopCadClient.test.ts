import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import type { Socket } from 'node:net';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { DesktopCadClient } from './DesktopCadClient';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('DesktopCadClient', () => {
  it('discovers, authenticates and calls the open desktop bridge', async () => {
    const token = 'a'.repeat(64);
    let received: Record<string, unknown> | undefined;
    const directory = await mkdtemp(join(tmpdir(), 'mycad-desktop-client-'));
    directories.push(directory);
    const discovery = join(directory, 'bridge.json');
    await writeFile(discovery, JSON.stringify({ version: 1, host: '127.0.0.1', port: 41234, token, pid: process.pid }));

    const connect = () => {
      const socket = new EventEmitter() as EventEmitter & {
        setTimeout(): void;
        destroy(): void;
        write(content: string): void;
      };
      socket.setTimeout = () => undefined;
      socket.destroy = () => undefined;
      socket.write = (content) => {
        received = JSON.parse(content.trim()) as Record<string, unknown>;
        queueMicrotask(() => socket.emit('data', Buffer.from(`${JSON.stringify({
          id: received?.id,
          ok: true,
          result: { projectPath: '/tmp/open.mycad', units: 'mm', entityCount: 2, solidCount: 1 },
        })}\n`)));
      };
      queueMicrotask(() => socket.emit('connect'));
      return socket as unknown as Socket;
    };

    const result = await new DesktopCadClient(discovery, connect).summary();

    expect(result).toMatchObject({ projectPath: '/tmp/open.mycad', entityCount: 2, solidCount: 1 });
    expect(received).toMatchObject({ version: 1, token, method: 'get_document', params: {} });
  });

  it('explains that MyCAD must be running when discovery is missing', async () => {
    await expect(new DesktopCadClient('/missing/mycad-bridge.json').summary())
      .rejects.toThrow('Start the MyCAD application first');
  });
});
