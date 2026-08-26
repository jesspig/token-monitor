import { join } from 'path'
import { app, dialog, shell, BrowserWindow, ipcMain } from 'electron'
import { bootstrapHost, type Host } from './host'
import { registerIpcHandlers } from './ipc/register'

const STARTUP_SYNC_DELAY_MS = 1500

let mainWindow: BrowserWindow | null = null
let host: Host | null = null

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
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
}

app.whenReady().then(() => {
  void bootstrapApp().catch(showFatalError)
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

// 退出前清理宿主：停采集 → 卸载全部插件 → 关闭数据库
app.on('before-quit', () => {
  host?.dispose()
  host = null
})
