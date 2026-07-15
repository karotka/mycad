import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import path from 'path';
import fs from 'fs/promises';

function createWindow() {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: 'MyCAD',
    backgroundColor: '#1e1e1e',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  if (process.env.VITE_DEV_SERVER_URL) {
    win.loadURL(process.env.VITE_DEV_SERVER_URL);
    win.webContents.openDevTools({ mode: 'detach' });
  } else {
    win.loadFile(path.join(__dirname, '../dist/index.html'));
  }
}

ipcMain.handle('save-file', async (_event, options: {
  content: string;
  defaultPath: string;
  filters: Array<{ name: string; extensions: string[] }>;
}) => {
  const result = await dialog.showSaveDialog({
    defaultPath: options.defaultPath,
    filters: options.filters,
  });
  if (result.canceled || !result.filePath) return { canceled: true };
  await fs.writeFile(result.filePath, options.content, 'utf8');
  return { canceled: false, filePath: result.filePath };
});

ipcMain.handle('open-file', async (_event, options: {
  filters: Array<{ name: string; extensions: string[] }>;
}) => {
  const result = await dialog.showOpenDialog({
    properties: ['openFile'],
    filters: options.filters,
  });
  if (result.canceled || result.filePaths.length === 0) return { canceled: true };
  const filePath = result.filePaths[0];
  return { canceled: false, filePath, content: await fs.readFile(filePath, 'utf8') };
});

ipcMain.handle('write-file', async (_event, options: { filePath: string; content: string }) => {
  await fs.writeFile(options.filePath, options.content, 'utf8');
  return { filePath: options.filePath };
});

ipcMain.handle('quick-save', async (_event, options: { filePath?: string; content: string }) => {
  const filePath = options.filePath ?? path.join(app.getPath('documents'), 'model.mycad');
  await fs.writeFile(filePath, options.content, 'utf8');
  return { filePath };
});

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
