export {};

declare global {
  interface Window {
    mycadAPI?: {
      saveFile(options: {
        content: string;
        defaultPath: string;
        filters: Array<{ name: string; extensions: string[] }>;
      }): Promise<{ canceled: boolean; filePath?: string }>;
      openFile(options: {
        filters: Array<{ name: string; extensions: string[] }>;
      }): Promise<{ canceled: boolean; filePath?: string; content?: string }>;
      writeFile(options: { filePath: string; content: string }): Promise<{ filePath: string }>;
      quickSave(options: { filePath?: string; defaultPath?: string; content: string }): Promise<{ filePath: string }>;
      setTitle(title: string): Promise<void>;
      mcpReady(): Promise<void>;
      mcpReadProject(requestId: string, filePath: string): Promise<{ filePath: string; content: string }>;
      mcpWriteFile(requestId: string, filePath: string, content: string): Promise<{ filePath: string }>;
      mcpRespond(response: { id: string; ok: boolean; result?: unknown; error?: string }): Promise<void>;
    };
    mycadEvents?: {
      /** Fires when a native menu item is chosen. Returns an unsubscribe function. */
      onMenuAction(callback: (action: string) => void): () => void;
      /** Receives authenticated modelling calls forwarded by the local MCP bridge. */
      onMcpRequest(callback: (request: {
        id: string;
        method: string;
        params: Record<string, unknown>;
      }) => void): () => void;
    };
  }
}
