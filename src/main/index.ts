import { join } from 'path'
import { app, shell, BrowserWindow, ipcMain } from 'electron'
import { createHost, type Host } from './host'
import { registerIpcHandlers } from './ipc/register'

let mainWindow: BrowserWindow | null = null
let host: Host | null = null

function createWindow(): void {
  const window = new BrowserWindow({
    width: 1100,
    height: 720,
    show: false,
    autoHideMenuBar: true,
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
}

app.whenReady().then(async () => {
  // 组装插件宿主：存储/定价/事件/调度/监听 + 8 个内置监控插件
  host = await createHost({ dataDir: app.getPath('userData') })

  // 注册全部 IPC handler（含示例 ping，渲染进程经 preload 白名单调用）
  registerIpcHandlers(ipcMain, host, () => mainWindow)

  // 启动采集：首次立即全量同步 + 按设置间隔定时兜底扫描
  host.collector.start(host.getSettings().syncIntervalMs)

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
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
