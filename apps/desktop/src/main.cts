import { app, BrowserWindow, dialog, ipcMain, Menu, session, shell } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// One instance only: a second launch focuses the existing window.
if (!app.requestSingleInstanceLock()) app.quit();

const distDir = __dirname;
let mainWindow: BrowserWindow | null = null;
let origin = '';
let dataDir = '';
let closeServer: (() => Promise<void>) | null = null;

async function startServer(): Promise<string> {
  dataDir = process.env.SENTINELOPS_DATA_DIR ?? path.join(app.getPath('userData'), 'data');
  const { buildApp, loadConfig } = (await import(pathToFileURL(path.join(distDir, 'server.mjs')).href)) as typeof import('../../server/src/embedded.ts');
  const config = loadConfig({
    host: '127.0.0.1',
    port: 0, // random free port; only reachable from this machine
    dataDir,
    webDir: path.join(distDir, 'web'),
    logLevel: 'warn',
  });
  const { app: server } = await buildApp(config);
  const address = await server.listen({ host: '127.0.0.1', port: 0 });
  closeServer = () => server.close();
  return address;
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 380,
    minHeight: 560,
    backgroundColor: '#0a1120',
    title: 'SentinelOps',
    icon: path.join(distDir, 'icon.png'),
    show: false,
    webPreferences: {
      preload: path.join(distDir, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
    },
  });
  mainWindow.once('ready-to-show', () => mainWindow?.show());

  // Verification hook: capture the real rendered window to a PNG, then quit.
  const smokeShot = process.env.SENTINELOPS_SMOKE_SCREENSHOT;
  if (smokeShot) {
    mainWindow.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        const image = await mainWindow!.webContents.capturePage();
        fs.writeFileSync(smokeShot, image.toPNG());
        console.log(`SMOKE OK ${mainWindow!.webContents.getTitle()} ${origin} -> ${smokeShot}`);
        app.quit();
      }, 2500);
    });
  }

  // Keep the window on the local app; open http(s) links in the user's browser.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(origin)) {
      event.preventDefault();
      if (/^https:\/\//.test(url)) void shell.openExternal(url);
    }
  });
  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    void dialog.showMessageBox({ type: 'error', title: 'SentinelOps', message: `The window stopped unexpectedly (${details.reason}). It will reload.` }).then(() => mainWindow?.reload());
  });
  void mainWindow.loadURL(origin);
}

async function showStartupError(err: unknown): Promise<void> {
  const message = err instanceof Error ? err.message : String(err);
  const win = new BrowserWindow({ width: 720, height: 520, backgroundColor: '#0a1120', title: 'SentinelOps — startup error', webPreferences: { sandbox: true, contextIsolation: true } });
  await win.loadFile(path.join(distDir, 'error.html'), { query: { message: message.slice(0, 500), dataDir } });
}

app.whenReady().then(async () => {
  // The app talks only to its own local server: refuse every permission prompt (camera, notifications, ...).
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      { label: 'File', submenu: [{ label: 'Open data folder', click: () => void shell.openPath(dataDir) }, { type: 'separator' }, { role: 'quit' }] },
      { label: 'View', submenu: [{ role: 'reload' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' }] },
      { label: 'Help', submenu: [{ label: `SentinelOps ${app.getVersion()}`, enabled: false }, { label: 'Local server: ' + '127.0.0.1 (random port)', enabled: false }] },
    ]),
  );

  // Exposed only to the app's own window through the preload bridge.
  ipcMain.handle('sentinel:get-setup-token', (event) => {
    if (!event.senderFrame?.url.startsWith(origin)) return null;
    try {
      return fs.readFileSync(path.join(dataDir, 'setup-token.txt'), 'utf8').trim();
    } catch {
      return null;
    }
  });

  try {
    origin = await startServer();
    console.log(`SentinelOps desktop: local server on ${origin}, data in ${dataDir}`);
  } catch (err) {
    await showStartupError(err);
    return;
  }
  createWindow();
  app.on('activate', () => BrowserWindow.getAllWindows().length === 0 && createWindow());
});

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

app.on('window-all-closed', () => app.quit());

let quitting = false;
app.on('before-quit', (event) => {
  if (quitting || !closeServer) return;
  event.preventDefault();
  quitting = true;
  void closeServer().finally(() => app.quit());
});
