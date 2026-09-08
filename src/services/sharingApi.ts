import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import type { Snapshot } from '../types/models'
import type { OwnedShare, ReceivedShare, ShareDraft, ShareInvite, SharedFileList, SharingStatus, ShareTransfer, SharingTerminalOutput, SharingTerminalExit } from '../types/sharing'

export const DEFAULT_RELAY_URL = 'https://136.0.110.161'
export const isSharingDesktop = () => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
const desktop = <T,>(command: string, args?: Record<string, unknown>): Promise<T> => {
  if (!isSharingDesktop()) return Promise.reject(new Error('请在 RackTop 桌面 App 中使用资源共享。网页仅用于界面预览。'))
  return invoke<T>(command, args)
}
export const emptySharingStatus = (): SharingStatus => ({ relayUrl: DEFAULT_RELAY_URL, configured: false, ownerOnline: false, shares: [], received: [] })
export const sharingApi = {
  status: (): Promise<SharingStatus> => isSharingDesktop() ? desktop('sharing_status') : Promise.resolve(emptySharingStatus()),
  configure: (relayUrl: string, ownerToken: string) => desktop<void>('sharing_configure', { relayUrl, ownerToken }),
  create: (draft: ShareDraft) => desktop<OwnedShare>('sharing_create', { ...draft }),
  invite: (shareId: string, expiresInMinutes = 10) => desktop<ShareInvite>('sharing_invite', { shareId, expiresInMinutes }),
  pause: (shareId: string, paused: boolean) => desktop<void>('sharing_pause', { shareId, paused }),
  revokeMember: (shareId: string, memberId: string) => desktop<void>('sharing_revoke_member', { shareId, memberId }),
  delete: (shareId: string) => desktop<void>('sharing_delete', { shareId }),
  accept: (code: string, deviceName: string) => desktop<ReceivedShare>('sharing_accept', { code, deviceName }),
  connect: (id: string) => desktop<void>('sharing_connect', { id }),
  disconnect: (id: string) => desktop<void>('sharing_disconnect', { id }),
  forget: (id: string) => desktop<void>('sharing_forget', { id }),
  snapshot: (id: string) => desktop<Snapshot>('sharing_snapshot', { id }),
  terminalOpen: (id: string, columns: number, rows: number) => desktop<string>('sharing_terminal_open', { id, columns, rows }),
  terminalInput: (id: string, sessionId: string, data: string) => desktop<void>('sharing_terminal_input', { id, sessionId, data }),
  terminalResize: (id: string, sessionId: string, columns: number, rows: number) => desktop<void>('sharing_terminal_resize', { id, sessionId, columns, rows }),
  terminalClose: (id: string, sessionId: string) => desktop<void>('sharing_terminal_close', { id, sessionId }),
  listFiles: (id: string, path: string) => desktop<SharedFileList>('sharing_list_files', { id, path }),
  upload: (id: string, directory: string) => desktop<{ transferId: string } | null>('sharing_upload', { id, directory }),
  download: (id: string, path: string) => desktop<{ transferId: string } | null>('sharing_download', { id, path }),
  cancelTransfer: (transferId: string) => desktop<void>('sharing_cancel_transfer', { transferId }),
  onTransfer: (fn: (event: ShareTransfer) => void) => subscribe('sharing-transfer-progress', fn),
  onTerminalOutput: (fn: (event: SharingTerminalOutput) => void) => subscribe('sharing-terminal-output', fn),
  onTerminalExit: (fn: (event: SharingTerminalExit) => void) => subscribe('sharing-terminal-exit', fn),
}
async function subscribe<T>(name: string, fn: (payload: T) => void): Promise<() => void> {
  if (!isSharingDesktop()) return () => {}
  return listen<T>(name, ({ payload }) => fn(payload))
}
/** Limit accidental secret exposure if a native error contains an invite or URL. */
export function sharingError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  return raw.replace(/(?:Bearer\s+)[A-Za-z0-9_-]+/gi, 'Bearer [已隐藏]').replace(/racktop-share:[^\s]+/gi, '[邀请码已隐藏]').slice(0, 500)
}
