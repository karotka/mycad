import { randomUUID } from 'node:crypto';
import { app, BrowserWindow, dialog, ipcMain, Menu, session, type IpcMainInvokeEvent, type MenuItemConstructorOptions } from 'electron';
import path from 'path';
import fs from 'fs/promises';
import { McpBridgeServer, type DesktopBridgeRequest } from './mcpBridge';
import { safeFileName } from './paths';

const APP_NAME = 'MyCAD';

// Names the application menu and the About box. Without it the menu reads
// "Electron" in development, since the bundle name only exists once packaged.
process.title = APP_NAME;
app.setName(APP_NAME);

const writableFiles = new Set<string>();
const MAX_TEXT_FILE_BYTES = 256 * 1024 * 1024;
const MCP_RENDERER_TIMEOUT_MS = 120_000;

interface PendingMcpRequest extends DesktopBridgeRequest {
  senderId: number;
  resolve(value: unknown): void;
  reject(error: Error): void;
  timeout: ReturnType<typeof setTimeout>;
}

const pendingMcpRequests = new Map<string, PendingMcpRequest>();
const mcpReadyWindows = new Set<number>();
const mcpReadyWaiters = new Map<number, Set<() => void>>();
let mcpBridge: McpBridgeServer | null = null;

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

function validateMcpFilePath(filePath: unknown, extension: '.mycad' | '.stl'): asserts filePath is string {
  validateFilePath(filePath);
  if (path.extname(filePath).toLowerCase() !== extension) throw new Error(`Expected a ${extension} file path.`);
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
type MenuAction = 'new' | 'open' | 'import-dxf' | 'import-excellon' | 'save' | 'save-as' | 'export-stl' | 'export-dxf' | 'export-gcode' | 'settings' | 'undo' | 'redo';

function buildMenu(win: BrowserWindow): void {
  const send = (action: MenuAction) => () => win.webContents.send('mycad-menu', action);
  const isMac = process.platform === 'darwin';

  const template: MenuItemConstructorOptions[] = [
    ...(isMac ? [{
      label: app.name,
      submenu: [
        { role: 'about' as const },
        { type: 'separator' as const },
        { label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: send('settings') },
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
        { type: 'separator' },
        { label: 'Save', accelerator: 'CmdOrCtrl+S', click: send('save') },
        { label: 'Save As…', accelerator: 'Shift+CmdOrCtrl+S', click: send('save-as') },
        { type: 'separator' },
        {
          label: 'Import',
          submenu: [
            { label: 'DXF…', click: send('import-dxf') },
            { label: 'Excellon Drill…', click: send('import-excellon') },
          ],
        },
        {
          label: 'Export',
          submenu: [
            { label: 'DXF…', accelerator: 'Shift+CmdOrCtrl+E', click: send('export-dxf') },
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
        // On macOS Settings lives in the app menu; elsewhere it belongs here.
        ...(isMac ? [] : [{ type: 'separator' as const }, { label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: send('settings') }]),
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: APP_NAME,
    backgroundColor: '#1e1e1e',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  buildMenu(win);
  const webContentsId = win.webContents.id;

  // The window keeps its own title; don't let the loaded page rename it.
  win.on('page-title-updated', (event) => event.preventDefault());

  if (process.env.VITE_DEV_SERVER_URL) {
    win.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    win.loadFile(path.join(__dirname, '../dist/index.html'));
  }
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event, url) => {
    if (url !== win.webContents.getURL()) event.preventDefault();
  });
  win.webContents.on('did-start-loading', () => {
    mcpReadyWindows.delete(webContentsId);
    rejectMcpRequestsForWindow(webContentsId, 'The MyCAD window reloaded during an MCP operation.');
  });
  win.on('closed', () => {
    mcpReadyWindows.delete(webContentsId);
    rejectMcpRequestsForWindow(webContentsId, 'The MyCAD window was closed during an MCP operation.');
  });
  return win;
}

function rejectMcpRequestsForWindow(senderId: number, message: string): void {
  for (const [id, request] of pendingMcpRequests) {
    if (request.senderId !== senderId) continue;
    clearTimeout(request.timeout);
    pendingMcpRequests.delete(id);
    request.reject(new Error(message));
  }
}

async function waitForMcpRenderer(win: BrowserWindow): Promise<void> {
  const senderId = win.webContents.id;
  if (mcpReadyWindows.has(senderId)) return;
  await new Promise<void>((resolve, reject) => {
    const waiters = mcpReadyWaiters.get(senderId) ?? new Set<() => void>();
    const ready = () => {
      clearTimeout(timeout);
      resolve();
    };
    waiters.add(ready);
    mcpReadyWaiters.set(senderId, waiters);
    const timeout = setTimeout(() => {
      waiters.delete(ready);
      reject(new Error('The MyCAD window is not ready for MCP requests.'));
    }, 15_000);
  });
}

async function dispatchMcpToRenderer(request: DesktopBridgeRequest): Promise<unknown> {
  const win = BrowserWindow.getAllWindows().find((candidate) => !candidate.isDestroyed());
  if (!win) throw new Error('No open MyCAD window is available.');
  await waitForMcpRenderer(win);
  const id = randomUUID();
  return new Promise<unknown>((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingMcpRequests.delete(id);
      reject(new Error(`The MyCAD window did not finish ${request.method} in time.`));
    }, MCP_RENDERER_TIMEOUT_MS);
    pendingMcpRequests.set(id, {
      ...request,
      senderId: win.webContents.id,
      resolve,
      reject,
      timeout,
    });
    win.webContents.send('mycad-mcp-request', { id, method: request.method, params: request.params });
  });
}

function authorisedMcpRequest(event: IpcMainInvokeEvent, requestId: unknown, method: string): PendingMcpRequest {
  assertTrustedSender(event);
  if (typeof requestId !== 'string') throw new Error('MCP request ID is missing.');
  const request = pendingMcpRequests.get(requestId);
  if (!request || request.senderId !== event.sender.id || request.method !== method) throw new Error('This MCP file operation is not authorised.');
  return request;
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

ipcMain.handle('set-title', (event, title: unknown) => {
  assertTrustedSender(event);
  const window = BrowserWindow.fromWebContents(event.sender);
  window?.setTitle(typeof title === 'string' && title.trim() ? title : APP_NAME);
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

ipcMain.handle('mycad-mcp-ready', (event) => {
  assertTrustedSender(event);
  const senderId = event.sender.id;
  mcpReadyWindows.add(senderId);
  for (const resolve of mcpReadyWaiters.get(senderId) ?? []) resolve();
  mcpReadyWaiters.delete(senderId);
});

ipcMain.handle('mycad-mcp-response', (event, response: { id?: unknown; ok?: unknown; result?: unknown; error?: unknown }) => {
  assertTrustedSender(event);
  const id = typeof response?.id === 'string' ? response.id : '';
  const pending = pendingMcpRequests.get(id);
  if (!pending || pending.senderId !== event.sender.id) throw new Error('Unknown MCP response.');
  pendingMcpRequests.delete(id);
  clearTimeout(pending.timeout);
  if (response.ok === true) pending.resolve(response.result);
  else pending.reject(new Error(typeof response.error === 'string' ? response.error : 'The MyCAD window rejected the MCP operation.'));
});

ipcMain.handle('mycad-mcp-read-project', async (event, options: { requestId?: unknown; filePath?: unknown }) => {
  const request = authorisedMcpRequest(event, options?.requestId, 'open_project');
  validateMcpFilePath(options?.filePath, '.mycad');
  if (request.params.path !== options.filePath) throw new Error('The MCP project path does not match the authorised request.');
  const stat = await fs.stat(options.filePath);
  if (stat.size > MAX_TEXT_FILE_BYTES) throw new Error('The selected file is too large.');
  writableFiles.add(options.filePath);
  return { filePath: options.filePath, content: await fs.readFile(options.filePath, 'utf8') };
});

ipcMain.handle('mycad-mcp-write-file', async (event, options: { requestId?: unknown; filePath?: unknown; content?: unknown }) => {
  assertTrustedSender(event);
  const requestId = typeof options?.requestId === 'string' ? options.requestId : '';
  const request = pendingMcpRequests.get(requestId);
  if (!request || request.senderId !== event.sender.id || (request.method !== 'save_project' && request.method !== 'export_stl')) {
    throw new Error('This MCP file operation is not authorised.');
  }
  const extension = request.method === 'save_project' ? '.mycad' : '.stl';
  validateMcpFilePath(options?.filePath, extension);
  if (request.params.path !== options.filePath) throw new Error('The MCP output path does not match the authorised request.');
  validateContent(options?.content);
  await fs.writeFile(options.filePath, options.content, 'utf8');
  writableFiles.add(options.filePath);
  return { filePath: options.filePath };
});

app.whenReady().then(async () => {
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  app.setAboutPanelOptions({
    applicationName: APP_NAME,
    applicationVersion: app.getVersion(),
  });
  // Packaged builds get the Dock/Finder icon from electron-builder. During
  // development there is no app bundle, so set the same artwork explicitly.
  if (process.platform === 'darwin' && !app.isPackaged) {
    app.dock?.setIcon(path.join(__dirname, '../build/icon.png'));
  }
  const win = createWindow();
  mcpBridge = new McpBridgeServer(dispatchMcpToRenderer);
  try {
    await mcpBridge.start();
  } catch (error) {
    console.error('Could not start MyCAD MCP bridge:', error);
  }
});

app.on('before-quit', () => {
  void mcpBridge?.stop();
  mcpBridge = null;
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
