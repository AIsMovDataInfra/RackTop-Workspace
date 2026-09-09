export interface ShareCapabilities { monitor: boolean; terminal: boolean; files: boolean }
export interface ShareMember { id: string; deviceName: string; pairedAt: number; lastSeenAt?: number | null; connected: boolean; ipAddress?: string | null }
export interface OwnedShare { id: string; serverId: string; name: string; expiresAt: number; defaultPath: string; capabilities: ShareCapabilities; paused: boolean; members: ShareMember[] }
export interface ReceivedShare { id: string; name: string; ownerLabel: string; expiresAt: number; capabilities: ShareCapabilities; state: 'offline' | 'connecting' | 'online' | 'error'; lastError?: string | null; defaultPath: string }
export interface SharingStatus { relayUrl: string; configured: boolean; ownerOnline: boolean; shares: OwnedShare[]; received: ReceivedShare[] }
export interface ShareDraft { serverId: string; name: string; expiresInHours: number; defaultPath: string; capabilities: ShareCapabilities }
export interface ShareInvite { code: string; expiresAt: number; shareId: string }
export interface SharedFile { name: string; path: string; isDir: boolean; isSymlink: boolean; size: number; modified?: number | null }
export interface SharedFileList { path: string; parent?: string | null; entries: SharedFile[]; truncated?: boolean }
export interface ShareTransfer { transferId: string; resourceId: string; direction: 'upload' | 'download'; name: string; transferred: number; total: number | null; status: 'running' | 'completed' | 'cancelled' | 'error'; error?: string | null }
/** Output is base64 encoded bytes. Input is a plain terminal string. */
export interface SharingTerminalOutput { resourceId: string; sessionId: string; data: string }
export interface SharingTerminalExit { resourceId: string; sessionId: string; exitCode?: number | null; message?: string }
