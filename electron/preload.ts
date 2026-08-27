import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('mycadAPI', {
  saveFile: (options: { content: string; defaultPath: string; filters: Array<{ name: string; extensions: string[] }> }) =>
    ipcRenderer.invoke('save-file', options),
  openFile: (options: { filters: Array<{ name: string; extensions: string[] }> }) =>
    ipcRenderer.invoke('open-file', options),
  writeFile: (options: { filePath: string; content: string }) =>
    ipcRenderer.invoke('write-file', options),
  quickSave: (options: { filePath?: string; defaultPath?: string; content: string }) =>
    ipcRenderer.invoke('quick-save', options),
  exportPdf: (options: { svg: string; widthMm: number; heightMm: number; defaultPath: string }) =>
    ipcRenderer.invoke('export-pdf', options),
  setTitle: (title: string) => ipcRenderer.invoke('set-title', title),
  mcpReady: () => ipcRenderer.invoke('mycad-mcp-ready'),
  mcpReadProject: (requestId: string, filePath: string) =>
    ipcRenderer.invoke('mycad-mcp-read-project', { requestId, filePath }),
  mcpWriteFile: (requestId: string, filePath: string, content: string) =>
    ipcRenderer.invoke('mycad-mcp-write-file', { requestId, filePath, content }),
  mcpRespond: (response: { id: string; ok: boolean; result?: unknown; error?: string }) =>
    ipcRenderer.invoke('mycad-mcp-response', response),
});

contextBridge.exposeInMainWorld('mycadEvents', {
  onMenuAction: (callback: (action: string) => void) => {
    const listener = (_event: unknown, action: string) => callback(action);
    ipcRenderer.on('mycad-menu', listener);
    return () => ipcRenderer.removeListener('mycad-menu', listener);
  },
  onMcpRequest: (callback: (request: { id: string; method: string; params: Record<string, unknown> }) => void) => {
    const listener = (_event: unknown, request: { id: string; method: string; params: Record<string, unknown> }) => callback(request);
    ipcRenderer.on('mycad-mcp-request', listener);
    return () => ipcRenderer.removeListener('mycad-mcp-request', listener);
  },
});
