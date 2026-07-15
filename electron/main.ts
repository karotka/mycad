import { app, BrowserWindow, dialog, ipcMain, session, type IpcMainInvokeEvent } from 'electron';
import path from 'path';
import fs from 'fs/promises';

const writableFiles = new Set<string>();
const MAX_TEXT_FILE_BYTES = 256 * 1024 * 1024;

function assertTrustedSender(event: IpcMainInvokeEvent): void {
  const url = event.senderFrame?.url ?? '';
  const trustedDevelopmentUrl = process.env.VITE_DEV_SERVER_URL;
  if (url.startsWith('file://') || (trustedDevelopmentUrl && url.startsWith(trustedDevelopmentUrl))) return;
  throw new Error('Rejected IPC request from an untrusted renderer.');
}

function validateContent(content: unknown): asserts content is string {
  if (typeof content !== 'string') throw new Error('File content must be text.');
  if (Buffer.byteLength(content, 'utf8') > MAX_TEXT_FILE_BYTES) throw new Error('The file is too large.');
}

function validateFilePath(filePath: unknown): asserts filePath is string {
  if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) throw new Error('A valid absolute file path is required.');
}

function validateFilters(filters: unknown): asserts filters is Array<{ name: string; extensions: string[] }> {
  if (!Array.isArray(filters) || filters.some((filter) => {
    const candidate = filter as { name?: unknown; extensions?: unknown };
    return typeof candidate?.name !== 'string'
      || !Array.isArray(candidate.extensions)
      || candidate.extensions.some((extension) => typeof extension !== 'string' || !/^[a-z0-9]+$/i.test(extension));
  })) throw new Error('Invalid file dialog filters.');
}

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
      sandbox: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  if (process.env.VITE_DEV_SERVER_URL) {
    win.loadURL(process.env.VITE_DEV_SERVER_URL);
    win.webContents.openDevTools({ mode: 'detach' });
  } else {
    win.loadFile(path.join(__dirname, '../dist/index.html'));
  }
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event, url) => {
    if (url !== win.webContents.getURL()) event.preventDefault();
  });
}

ipcMain.handle('save-file', async (event, options: {
  content: string;
  defaultPath: string;
  filters: Array<{ name: string; extensions: string[] }>;
}) => {
  assertTrustedSender(event);
  validateContent(options?.content);
  validateFilters(options?.filters);
  const result = await dialog.showSaveDialog({
    defaultPath: options.defaultPath,
    filters: options.filters,
  });
  if (result.canceled || !result.filePath) return { canceled: true };
  await fs.writeFile(result.filePath, options.content, 'utf8');
  writableFiles.add(result.filePath);
  return { canceled: false, filePath: result.filePath };
});

ipcMain.handle('open-file', async (event, options: {
  filters: Array<{ name: string; extensions: string[] }>;
}) => {
  assertTrustedSender(event);
  validateFilters(options?.filters);
  const result = await dialog.showOpenDialog({
    properties: ['openFile'],
    filters: options.filters,
  });
  if (result.canceled || result.filePaths.length === 0) return { canceled: true };
  const filePath = result.filePaths[0];
  const stat = await fs.stat(filePath);
  if (stat.size > MAX_TEXT_FILE_BYTES) throw new Error('The selected file is too large.');
  writableFiles.add(filePath);
  return { canceled: false, filePath, content: await fs.readFile(filePath, 'utf8') };
});

ipcMain.handle('write-file', async (event, options: { filePath: string; content: string }) => {
  assertTrustedSender(event);
  validateContent(options?.content);
  validateFilePath(options?.filePath);
  if (!writableFiles.has(options.filePath)) throw new Error('The renderer cannot write to this path.');
  await fs.writeFile(options.filePath, options.content, 'utf8');
  return { filePath: options.filePath };
});

ipcMain.handle('quick-save', async (event, options: { filePath?: string; content: string }) => {
  assertTrustedSender(event);
  validateContent(options?.content);
  if (options?.filePath !== undefined) validateFilePath(options.filePath);
  const filePath = options.filePath ?? path.join(app.getPath('documents'), 'model.mycad');
  if (options.filePath && !writableFiles.has(options.filePath)) throw new Error('The renderer cannot write to this path.');
  await fs.writeFile(filePath, options.content, 'utf8');
  writableFiles.add(filePath);
  return { filePath };
});

app.whenReady().then(() => {
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
