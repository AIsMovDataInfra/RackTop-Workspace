import { invoke } from '@tauri-apps/api/core'

export interface SshKeyInfo {
  id: string
  name: string
  publicKey: string
  publicKeyPath: string | null
  privateKeyPath: string | null
  algorithm: string
  fingerprint: string
  source: 'discovered' | 'generated' | 'imported'
  warning: string | null
  usedBy: string[]
}

export type SshKeyAlgorithm = 'ed25519' | 'rsa4096'

const isDesktop = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

async function desktopInvoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!isDesktop) throw new Error('请在 RackTop 桌面版中管理本机 SSH 密钥。')
  return invoke<T>(command, args)
}

export const sshKeyManagerApi = {
  isDesktop,
  list: () => desktopInvoke<SshKeyInfo[]>('list_ssh_keys'),
  generate: (options: { name: string; algorithm: SshKeyAlgorithm; passphrase: string }) => desktopInvoke<SshKeyInfo>('generate_ssh_key', options),
  import: (options: { path: string; name: string | null }) => desktopInvoke<SshKeyInfo>('import_ssh_key', options),
  rename: (options: { id: string; name: string }) => desktopInvoke<void>('rename_ssh_key', options),
  forget: (options: { id: string }) => desktopInvoke<void>('forget_ssh_key', options),
}
