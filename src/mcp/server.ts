import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CadMcpSession } from './CadMcpSession';
import { DesktopCadClient } from './DesktopCadClient';
import { createMyCadMcpServer } from './MyCadMcpServer';

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main(): Promise<void> {
  const headless = process.argv.includes('--headless');
  const project = argument('--project');
  if (project && !headless) throw new Error('--project is available only with --headless; use the open_project tool for the live desktop window.');
  const backend = headless
    ? new CadMcpSession()
    : new DesktopCadClient(argument('--bridge'));
  if (project && backend instanceof CadMcpSession) await backend.openProject(project);
  const server = createMyCadMcpServer(backend);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stdout belongs exclusively to MCP JSON-RPC.
  console.error(headless
    ? `MyCAD MCP ready${project && backend instanceof CadMcpSession ? `: ${backend.projectFilePath}` : ' in headless mode with an empty document'}.`
    : 'MyCAD MCP ready for the open desktop window.');
}

main().catch((error) => {
  console.error('MyCAD MCP failed:', error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
