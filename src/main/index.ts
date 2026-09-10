import { join } from 'path'
import { app, dialog, shell, BrowserWindow, ipcMain } from 'electron'
import { bootstrapHost, type Host } from './host'
import { registerIpcHandlers } from './ipc/register'
import { createTray, type TrayHandle } from './tray'

const STARTUP_SYNC_DELAY_MS = 1500

let mainWindow: BrowserWindow | null = null
let host: Host | null = null
let tray: TrayHandle | null = null
let willQuit = false

if (!app.requestSingleInstanceLock()) {
  app.quit()
}

function resolveTrayIcon(): string {
  const name =
    process.platform === 'win32' ? 'icon.ico'
    : process.platform === 'darwin' ? 'iconTemplate.png'
    : 'icon.png'
  return app.isPackaged
    ? join(process.resourcesPath, 'tray', name)
    : join(app.getAppPath(), 'resources', 'tray', name)
}

function showWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow()
    return
  }
  mainWindow.show()
  mainWindow.focus()
}

function quitApp(): void {
  willQuit = true
  tray?.destroy()
  tray = null
  app.quit()
}

function showFatalError(err: unknown): void {
  const message = err instanceof Error ? err.message : String(err)
  dialog.showErrorBox('token-monitor 启动失败', message)
}

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1100,
    height: 720,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#0a0a0a',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  mainWindow = window

  window.on('close', (e) => {
    if (!willQuit && host?.getSettings().closeToTray) {
      e.preventDefault()
      window.hide()
    }
  })

  window.on('ready-to-show', () => {
    window.show()
  })

  window.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  const rendererUrl = process.env['ELECTRON_RENDERER_URL']
  if (!app.isPackaged && rendererUrl) {
    window.loadURL(rendererUrl)
  } else {
    window.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return window
}

async function bootstrapApp(): Promise<void> {
  const boot = await bootstrapHost({ dataDir: app.getPath('userData') })
  host = boot.host

  registerIpcHandlers(ipcMain, host, () => mainWindow)

  createWindow()

  if (host.getSettings().closeToTray) {
    tray = createTray(resolveTrayIcon(), { showWindow, quitApp })
  }

  const windowShown = new Promise<void>((resolve) => {
    mainWindow?.once('show', () => resolve())
  })

  boot.startServices().catch(showFatalError)

  const h = host
  void Promise.all([windowShown, boot.ready])
    .then(() => {
      h.collector.start(h.getSettings().syncIntervalMs, {
        initialSyncDelayMs: STARTUP_SYNC_DELAY_MS
      })
    })
    .catch(() => {})

  app.on('activate', () => {
    showWindow()
  })
}

app.whenReady().then(() => {
  void bootstrapApp().catch(showFatalError)
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin' && !host?.getSettings().closeToTray) {
    app.quit()
  }
})

app.on('second-instance', () => {
  showWindow()
})

app.on('before-quit', () => {
  tray?.destroy()
  tray = null
  host?.dispose()
  host = null
})
