import { Tray, Menu, nativeImage } from 'electron'

export interface TrayHandle {
  destroy(): void
}

export interface TrayActions {
  showWindow: () => void
  quitApp: () => void
}

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
