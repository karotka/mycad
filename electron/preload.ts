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
});

contextBridge.exposeInMainWorld('mycadEvents', {
  onMenuAction: (callback: (action: string) => void) => {
    const listener = (_event: unknown, action: string) => callback(action);
    ipcRenderer.on('mycad-menu', listener);
    return () => ipcRenderer.removeListener('mycad-menu', listener);
  },
});
