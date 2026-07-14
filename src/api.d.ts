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
    };
  }
}
