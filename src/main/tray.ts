import { Tray, Menu, nativeImage } from 'electron'

/** 托盘句柄：仅暴露销毁方法，供主进程退出前清理 */
export interface TrayHandle {
  destroy(): void
}

export interface TrayActions {
  /** 显示主窗口 */
  showWindow: () => void
  /** 真正退出应用 */
  quitApp: () => void
}

/**
 * 创建系统托盘（后台常驻入口）：右键菜单含「显示」「退出」，左键点击恢复窗口。
 * iconPath 为调用方按平台解析好的图标绝对路径（win32=.ico / darwin=模板 png / 其它=.png）。
 * 平台回退：无法创建托盘（如缺失 StatusNotifier 的 Linux 桌面）时返回空操作句柄，不抛错。
 */
export function createTray(iconPath: string, actions: TrayActions): TrayHandle {
  try {
    const image = nativeImage.createFromPath(iconPath)
    const tray = new Tray(image)
    tray.setToolTip('Token Monitor')
    const template = [
      { label: '显示', click: () => actions.showWindow() },
      { label: '退出', click: () => actions.quitApp() }
    ]
    tray.setContextMenu(Menu.buildFromTemplate(template))
    tray.on('click', () => actions.showWindow())
    return {
      destroy: () => {
        tray.destroy()
      }
    }
  } catch (err) {
    console.error('[tray] 创建托盘失败，回退为无托盘模式:', err)
    return { destroy: () => {} }
  }
}
