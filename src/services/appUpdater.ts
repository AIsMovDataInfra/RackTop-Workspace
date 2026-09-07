import { check, type DownloadEvent, type Update } from '@tauri-apps/plugin-updater'
import { relaunch } from '@tauri-apps/plugin-process'
import { detectAppPlatform } from '../utils/platform'

export type DesktopAppUpdate = Update
export type DesktopDownloadEvent = DownloadEvent

export async function checkDesktopAppUpdate() {
  if (detectAppPlatform(true, navigator.userAgent) === 'linux') {
    throw new Error('此 Linux 构建使用手动更新；请从 github.com/AIsMovDataInfra/RackTop/releases 下载新版 Linux 安装包。')
  }
  return check({ timeout: 30_000 })
}

export function relaunchUpdatedApp() {
  return relaunch()
}
