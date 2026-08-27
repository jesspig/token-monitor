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

// 单实例锁：第二个实例直接退出，由首实例聚焦窗口
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

  // 关闭窗口时：未显式退出且开启常驻 → 取消关闭并隐藏到托盘
  window.on('close', (e) => {
    if (!willQuit && host?.getSettings().closeToTray) {
      e.preventDefault()
      window.hide()
    }
  })

  window.on('ready-to-show', () => {
    window.show()
  })

  // 外部链接一律交给系统浏览器打开
  window.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // 开发模式加载 electron-vite 渲染进程 dev server，生产模式加载打包产物
  const rendererUrl = process.env['ELECTRON_RENDERER_URL']
  if (!app.isPackaged && rendererUrl) {
    window.loadURL(rendererUrl)
  } else {
    window.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return window
}

async function bootstrapApp(): Promise<void> {
  // 组装插件宿主阶段一：建库/迁移/seed 定价/设置（快速同步段，毫秒级）
  const boot = await bootstrapHost({ dataDir: app.getPath('userData') })
  host = boot.host

  // 注册全部 IPC handler（含示例 ping，渲染进程经 preload 白名单调用）
  registerIpcHandlers(ipcMain, host, () => mainWindow)

  createWindow()

  // 按设置创建托盘：开启常驻时提供「显示 / 退出」入口
  if (host.getSettings().closeToTray) {
    tray = createTray(resolveTrayIcon(), { showWindow, quitApp })
  }

  const windowShown = new Promise<void>((resolve) => {
    mainWindow?.once('show', () => resolve())
  })

  // 阶段二异步推进：插件并行装载 + 调度注册；失败弹窗兜底，不静默白屏
  boot.startServices().catch(showFatalError)

  // 首轮采集错峰：窗口 show 且宿主就绪后延迟触发，周期兜底扫描不受影响
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
  // 开启常驻（托盘）时不退出；仅非 darwin 且未开启常驻才退出
  if (process.platform !== 'darwin' && !host?.getSettings().closeToTray) {
    app.quit()
  }
})

// 第二实例：聚焦已存在的窗口（单实例锁兜底）
app.on('second-instance', () => {
  showWindow()
})

// 退出前清理宿主：停采集 → 卸载全部插件 → 关闭数据库
app.on('before-quit', () => {
  tray?.destroy()
  tray = null
  host?.dispose()
  host = null
})
