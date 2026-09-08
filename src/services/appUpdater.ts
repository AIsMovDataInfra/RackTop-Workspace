import { check, type DownloadEvent, type Update } from '@tauri-apps/plugin-updater'
import { relaunch } from '@tauri-apps/plugin-process'
import { detectAppPlatform } from '../utils/platform'
import { Channel, invoke } from '@tauri-apps/api/core'

export type DesktopAppUpdate = Pick<Update, 'version' | 'date' | 'downloadAndInstall' | 'close'>
export type DesktopDownloadEvent = DownloadEvent

function appPlatform() {
  const isDesktop = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
  return detectAppPlatform(isDesktop, typeof navigator === 'undefined' ? '' : navigator.userAgent)
}

export async function checkDesktopAppUpdate(): Promise<DesktopAppUpdate | null> {
  const platform = appPlatform()
  if (platform === 'web') return null
  if (platform === 'linux') {
    const update = await invoke<{ version: string; date?: string } | null>('check_linux_update')
    if (!update) return null
    return {
      ...update,
      async downloadAndInstall(onEvent) {
        const channel = new Channel<DownloadEvent>()
        channel.onmessage = (event) => onEvent?.(event)
        await invoke('install_linux_update', { version: update.version, onEvent: channel })
      },
      async close() {},
    }
  }
  return check({ timeout: 30_000 })
}

export function relaunchUpdatedApp() {
  const platform = appPlatform()
  if (platform === 'web') return Promise.reject(new Error('应用重启仅在 RackTop 桌面端可用'))
  if (platform === 'linux') return invoke<void>('relaunch_linux_app')
  return relaunch()
}
