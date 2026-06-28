const { app, BrowserWindow, Menu, dialog } = require('electron');

const PORT = 3000;
const isMac = process.platform === 'darwin';
let mainWindow;

function createWindow() {
  const windowOptions = {
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 600,
    backgroundColor: '#0a0a0f',
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  };

  // macOS-specific: hidden titlebar with inset traffic lights
  if (isMac) {
    windowOptions.titleBarStyle = 'hiddenInset';
    windowOptions.trafficLightPosition = { x: 15, y: 18 };
  }

  mainWindow = new BrowserWindow(windowOptions);

  mainWindow.loadURL(`http://localhost:${PORT}`);

  // Keep the renderer pinned to the local app: block navigation elsewhere
  // and deny popup/new windows.
  mainWindow.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(`http://localhost:${PORT}`)) e.preventDefault();
  });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function buildMenu() {
  const template = [];

  // macOS: app-name menu with About, Hide, Quit
  if (isMac) {
    template.push({
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    });
  }

  // Windows: File menu with Quit (since there's no app-name menu)
  if (!isMac) {
    template.push({
      label: 'File',
      submenu: [{ role: 'quit' }],
    });
  }

  template.push({
    label: 'Edit',
    submenu: [
      { role: 'undo' },
      { role: 'redo' },
      { type: 'separator' },
      { role: 'cut' },
      { role: 'copy' },
      { role: 'paste' },
      { role: 'selectAll' },
    ],
  });

  template.push({
    label: 'View',
    submenu: [
      { role: 'reload' },
      { role: 'forceReload' },
      { type: 'separator' },
      { role: 'resetZoom' },
      { role: 'zoomIn' },
      { role: 'zoomOut' },
      { type: 'separator' },
      { role: 'togglefullscreen' },
    ],
  });

  template.push({
    label: 'Window',
    submenu: isMac
      ? [
          { role: 'minimize' },
          { role: 'zoom' },
          { type: 'separator' },
          { role: 'front' },
        ]
      : [
          { role: 'minimize' },
          { role: 'maximize' },
          { role: 'close' },
        ],
  });

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function waitForServer(retries = 30) {
  return new Promise((resolve, reject) => {
    const http = require('http');
    let attempts = 0;
    function check() {
      attempts++;
      const req = http.get(`http://localhost:${PORT}`, (res) => {
        res.resume();
        resolve();
      });
      req.on('error', () => {
        if (attempts >= retries) return reject(new Error('Server did not start'));
        setTimeout(check, 300);
      });
      req.setTimeout(1000, () => req.destroy());
    }
    check();
  });
}

let serverModule = null;

app.whenReady().then(async () => {
  // Start the Express server in-process
  process.env.PORT = PORT;
  serverModule = require('./server');

  buildMenu();
  await waitForServer();
  createWindow();
}).catch((err) => {
  // Fail loud instead of hanging on a blank window if the server never starts.
  dialog.showErrorBox('XCPlaylist failed to start', String((err && err.stack) || err));
  app.quit();
});

app.on('window-all-closed', () => {
  app.quit();
});

// Clean up Express server + FFmpeg processes before quitting
app.on('before-quit', () => {
  if (serverModule && serverModule.shutdown) {
    serverModule.shutdown();
  }
});

// Force-exit if something is still holding the process open
app.on('will-quit', () => {
  setTimeout(() => {
    console.log('[electron] Force exiting');
    process.exit(0);
  }, 2000);
});

app.on('activate', () => {
  // macOS: re-create window when dock icon is clicked
  if (mainWindow === null) createWindow();
});
