import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it } from 'vitest';
import { CadMcpSession } from './CadMcpSession';
import { createMyCadMcpServer } from './MyCadMcpServer';

describe('MyCAD MCP server', () => {
  const close: Array<() => Promise<void>> = [];

  afterEach(async () => {
    await Promise.all(close.splice(0).map((callback) => callback()));
  });

  it('publishes its modelling tools and document resource over MCP', async () => {
    const session = new CadMcpSession();
    const server = createMyCadMcpServer(session);
    const client = new Client({ name: 'mycad-test', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    close.push(() => client.close(), () => server.close());
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name)).toEqual(expect.arrayContaining([
      'get_document', 'create_primitive', 'create_lines', 'boolean_solids', 'delete_feature', 'save_project', 'export_stl',
    ]));

    const created = await client.callTool({
      name: 'create_primitive',
      arguments: { primitive: 'box', center: { x: 5, y: 7 }, width: 20, depth: 10, height: 4 },
    });
    expect(created.isError).not.toBe(true);
    expect(created.structuredContent).toMatchObject({
      result: { kind: 'solid', featureKind: 'primitive', selected: true },
    });

    const resource = await client.readResource({ uri: 'mycad://document' });
    const document = resource.contents[0];
    expect('text' in document ? JSON.parse(document.text) : null).toMatchObject({ solidCount: 1 });
  });
});
