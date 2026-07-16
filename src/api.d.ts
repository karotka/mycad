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
    };
    mycadEvents?: {
      /** Fires when a native menu item is chosen. Returns an unsubscribe function. */
      onMenuAction(callback: (action: string) => void): () => void;
    };
  }
}
