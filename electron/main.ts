import { app, BrowserWindow, dialog, ipcMain, Menu, session, type IpcMainInvokeEvent, type MenuItemConstructorOptions } from 'electron';
import path from 'path';
import fs from 'fs/promises';
import { safeFileName } from './paths';

// Names the application menu and the About box. Without it the menu reads
// "Electron" in development, since the bundle name only exists once packaged.
app.setName('MyCAD');

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

/** Menu actions are names the renderer already has callbacks for. */
type MenuAction = 'new' | 'open' | 'import-dxf' | 'save' | 'save-as' | 'export-stl' | 'export-gcode' | 'undo' | 'redo';

function buildMenu(win: BrowserWindow): void {
  const send = (action: MenuAction) => () => win.webContents.send('mycad-menu', action);
  const isMac = process.platform === 'darwin';

  const template: MenuItemConstructorOptions[] = [
    ...(isMac ? [{
      label: app.name,
      submenu: [
        { role: 'about' as const },
        { type: 'separator' as const },
        { role: 'services' as const },
        { type: 'separator' as const },
        { role: 'hide' as const },
        { role: 'hideOthers' as const },
        { role: 'unhide' as const },
        { type: 'separator' as const },
        { role: 'quit' as const },
      ],
    }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'New Project', accelerator: 'CmdOrCtrl+N', click: send('new') },
        { label: 'Open Project…', accelerator: 'CmdOrCtrl+O', click: send('open') },
        { label: 'Import DXF…', click: send('import-dxf') },
        { type: 'separator' },
        { label: 'Save', accelerator: 'CmdOrCtrl+S', click: send('save') },
        { label: 'Save As…', accelerator: 'Shift+CmdOrCtrl+S', click: send('save-as') },
        { type: 'separator' },
        {
          label: 'Export',
          submenu: [
            { label: 'STL…', accelerator: 'CmdOrCtrl+E', click: send('export-stl') },
            { label: 'G-code…', accelerator: 'Shift+CmdOrCtrl+G', click: send('export-gcode') },
          ],
        },
        ...(isMac ? [] : [{ type: 'separator' as const }, { role: 'quit' as const }]),
      ],
    },
    {
      label: 'Edit',
      submenu: [
        // The drawing's history, not the text field's.
        { label: 'Undo', accelerator: 'CmdOrCtrl+Z', click: send('undo') },
        { label: 'Redo', accelerator: 'Shift+CmdOrCtrl+Z', click: send('redo') },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        ...(process.env.VITE_DEV_SERVER_URL ? [{ type: 'separator' as const }, { role: 'toggleDevTools' as const }] : []),
      ],
    },
    { role: 'windowMenu' },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
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

  buildMenu(win);

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

ipcMain.handle('quick-save', async (event, options: { filePath?: string; defaultPath?: string; content: string }) => {
  assertTrustedSender(event);
  validateContent(options?.content);
  if (options?.filePath !== undefined) validateFilePath(options.filePath);
  // A quick save writes with no dialog, so the renderer may propose a name but
  // never a path: joining one on would step outside the documents folder.
  const filePath = options.filePath ?? path.join(app.getPath('documents'), safeFileName(options?.defaultPath, 'model.mycad'));
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
