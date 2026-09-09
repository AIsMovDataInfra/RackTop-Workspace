// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SharingWorkspace } from './SharingWorkspace'
import { sharingApi, emptySharingStatus } from '../services/sharingApi'
import type { Server } from '../types/models'
import type { OwnedShare, ReceivedShare, ShareTransfer } from '../types/sharing'
vi.mock('./SharingTerminal', () => ({ SharingTerminal: () => <div>独立共享终端</div> }))
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const server: Server = { id: 'local-server', name: '本地 A100', host: 'private-host.invalid', port: 2222, username: 'private-user', identityFile: '/secret/private-key', authMethod: 'sshAgent', status: 'online', tags: [], samplingIntervalSeconds: 2, historyRetentionDays: 90, remoteHistoryEnabled: false }
const capabilities = { monitor: true, terminal: true, files: true }
const owned: OwnedShare = { id: 'owned', name: '协作 A100', serverId: server.id, expiresAt: Date.now() + 3600000, defaultPath: '~/work', capabilities, paused: false, members: [{ id: 'member-a', deviceName: '协作者电脑', pairedAt: Date.now(), connected: true }] }
const received: ReceivedShare = { id: 'received-a', name: '共享 A100', ownerLabel: '分享者', expiresAt: Date.now() + 3600000, capabilities: { monitor: false, terminal: false, files: true }, state: 'online', defaultPath: '.' }
let root: ReturnType<typeof createRoot>
let container: HTMLDivElement
const click = async (text: string) => { const button = [...container.querySelectorAll('button')].find(item => item.textContent?.includes(text)); expect(button, text).toBeTruthy(); await act(async () => button!.click()) }
const mount = async () => { await act(async () => root.render(<SharingWorkspace servers={[server]} currentServerId={server.id}/>)) }
beforeEach(() => {
  Object.defineProperty(window, '__TAURI_INTERNALS__', { value: {}, configurable: true })
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value: function (this: HTMLDialogElement) { this.setAttribute('open', '') } })
  Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value: function (this: HTMLDialogElement) { this.removeAttribute('open') } })
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  vi.spyOn(sharingApi, 'status').mockResolvedValue(emptySharingStatus())
  vi.spyOn(sharingApi, 'onTransfer').mockResolvedValue(() => {})
})
afterEach(() => { act(() => root.unmount()); container.remove(); vi.restoreAllMocks(); delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ })
describe('sharing workspace authorization and workflows', () => {
  it('requires owner setup before creating a share, and never displays saved credentials', async () => {
    await mount()
    const create = [...container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === '共享资源')
    expect(create?.disabled).toBe(true)
    await click('中继设置')
    expect(container.querySelector<HTMLInputElement>('input[type=password]')?.value).toBe('')
    expect(document.activeElement).toBe(container.querySelector('input[type=password]'))
    expect(container.querySelector<HTMLInputElement>('input[type=url]')?.readOnly).toBe(true)
    expect(container.textContent).not.toContain(server.host)
    expect(container.textContent).not.toContain(server.identityFile)
  })
  it('keeps both sharing selects intact with a long resource label', async () => {
    const longServer = { ...server, name: '上海具身智能训练集群 A100 服务器 · embodied-training-primary-01' }
    vi.mocked(sharingApi.status).mockResolvedValue({ ...emptySharingStatus(), configured: true, ownerOnline: true })
    await act(async () => root.render(<SharingWorkspace servers={[longServer]} currentServerId={longServer.id}/>))
    await click('共享资源')
    const selects = [...container.querySelectorAll<HTMLSelectElement>('.sharing-form select')]
    expect(selects).toHaveLength(2)
    expect(selects[0].value).toBe(longServer.id)
    expect(selects[0].selectedOptions[0]?.textContent).toBe(longServer.name)
    expect(selects[1].value).toBe('24')
  })
  it('creates the selected resource and presents the reusable invite returned by the backend', async () => {
    vi.mocked(sharingApi.status).mockResolvedValue({ ...emptySharingStatus(), configured: true, ownerOnline: true })
    const create = vi.spyOn(sharingApi, 'create').mockResolvedValue(owned)
    vi.spyOn(sharingApi, 'invite').mockResolvedValue({ shareId: owned.id, code: 'reusable-test-code', expiresAt: Date.now() + 60000 })
    await mount(); await click('共享资源'); await click('创建并生成邀请码')
    expect(create).toHaveBeenCalledWith({ serverId: server.id, name: server.name, expiresInHours: 24, defaultPath: '~', capabilities })
    expect(container.querySelector<HTMLTextAreaElement>('[aria-label="共享邀请码"]')?.value).toBe('reusable-test-code')
    expect(container.querySelector('dialog')?.textContent).toContain('可反复复制')
    expect(container.querySelector('dialog')?.textContent).toContain('多台设备')
  })
  it('copies the same reusable invite repeatedly and retrieves it again after closing', async () => {
    vi.mocked(sharingApi.status).mockResolvedValue({ ...emptySharingStatus(), configured: true, ownerOnline: true, shares: [owned] })
    const invite = vi.spyOn(sharingApi, 'invite').mockResolvedValue({ shareId: owned.id, code: 'stable-reusable-code', expiresAt: Date.now() + 60000 })
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    await mount(); await click('查看邀请码'); await click('复制邀请码'); await click('再次复制')
    expect(writeText).toHaveBeenCalledTimes(2)
    expect(writeText).toHaveBeenNthCalledWith(1, 'stable-reusable-code')
    expect(writeText).toHaveBeenNthCalledWith(2, 'stable-reusable-code')
    await click('完成'); await click('查看邀请码')
    expect(invite).toHaveBeenCalledTimes(2)
    expect(container.querySelector<HTMLTextAreaElement>('[aria-label="共享邀请码"]')?.value).toBe('stable-reusable-code')
  })
  it('does not revoke a device until the confirmation is accepted', async () => {
    vi.mocked(sharingApi.status).mockResolvedValue({ ...emptySharingStatus(), configured: true, ownerOnline: true, shares: [owned] })
    const revoke = vi.spyOn(sharingApi, 'revokeMember').mockResolvedValue(undefined)
    await mount(); await click('撤销访问'); expect(revoke).not.toHaveBeenCalled()
    expect(container.querySelector('dialog')?.textContent).toContain('现有邀请码会自动更新')
    await click('确认'); expect(revoke).toHaveBeenCalledWith('owned', 'member-a')
  })
  it('shows a connected member public egress IP and explains NAT without exposing stale addresses', async () => {
    const withNetworkMembers: OwnedShare = { ...owned, members: [
      { id: 'connected-ip', deviceName: '在线设备', pairedAt: Date.now(), connected: true, ipAddress: '203.0.113.7' },
      { id: 'offline-ip', deviceName: '离线设备', pairedAt: Date.now(), lastSeenAt: Date.now(), connected: false, ipAddress: '198.51.100.8' },
      { id: 'connected-no-ip', deviceName: '未知网络设备', pairedAt: Date.now(), connected: true },
    ] }
    vi.mocked(sharingApi.status).mockResolvedValue({ ...emptySharingStatus(), configured: true, ownerOnline: true, shares: [withNetworkMembers] })
    await mount()
    expect(container.textContent).toContain('公网出口 IP')
    expect(container.textContent).toContain('203.0.113.7')
    expect(container.textContent).not.toContain('198.51.100.8')
    expect(container.textContent).toContain('同一 NAT 网络中的多台设备可能显示相同 IP')
  })
  it('keeps failed invitation input available for correction and shows the error', async () => {
    vi.spyOn(sharingApi, 'accept').mockRejectedValue(new Error('邀请码已过期'))
    await mount(); await click('别人共享的资源'); await click('加入共享')
    const textarea = container.querySelector('textarea')!
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, 'expired-code'); textarea.dispatchEvent(new Event('input', { bubbles: true })) })
    await act(async () => { container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) })
    expect(container.querySelector('dialog')?.textContent).toContain('邀请码已过期')
    expect(textarea.value).toBe('expired-code')
  })
  it('uses guest resource IDs for files and native file selection, and rejects parent traversal', async () => {
    vi.mocked(sharingApi.status).mockResolvedValue({ ...emptySharingStatus(), received: [received] })
    const list = vi.spyOn(sharingApi, 'listFiles').mockResolvedValue({ path: '.', parent: null, entries: [{ name: 'data.bin', path: 'data.bin', isDir: false, isSymlink: false, size: 10 }] })
    const upload = vi.spyOn(sharingApi, 'upload').mockResolvedValue(null)
    const download = vi.spyOn(sharingApi, 'download').mockResolvedValue(null)
    await mount(); await click('别人共享的资源')
    expect(list).toHaveBeenCalledWith('received-a', '.')
    expect(container.textContent).not.toContain(server.host)
    await click('上传'); expect(upload).toHaveBeenCalledWith('received-a', '.')
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="下载 data.bin"]')!.click())
    expect(download).toHaveBeenCalledWith('received-a', 'data.bin')
    const input = container.querySelector<HTMLInputElement>('[aria-label="共享目录"]')!
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '../private'); input.dispatchEvent(new Event('input', { bubbles: true })) })
    await click('前往')
    expect(list).not.toHaveBeenCalledWith(expect.anything(), '../private')
    expect(container.textContent).toContain('不能使用绝对路径或 ..')
  })
  it('filters transfer events to the selected resource and cancels only the matching transfer', async () => {
    vi.mocked(sharingApi.status).mockResolvedValue({ ...emptySharingStatus(), received: [received] })
    vi.spyOn(sharingApi, 'listFiles').mockResolvedValue({ path: '.', parent: null, entries: [] })
    const cancel = vi.spyOn(sharingApi, 'cancelTransfer').mockResolvedValue(undefined)
    let eventHandler: (event: ShareTransfer) => void = () => {}
    vi.mocked(sharingApi.onTransfer).mockImplementation(async fn => { eventHandler = fn; return () => {} })
    await mount(); await click('别人共享的资源')
    const event: ShareTransfer = { transferId: 'tx-a', resourceId: 'received-a', name: 'weights.bin', direction: 'upload', transferred: 16, total: 64, status: 'running' }
    await act(async () => { eventHandler({ ...event, resourceId: 'another-resource', name: 'hidden.bin' }); eventHandler(event) })
    expect(container.textContent).not.toContain('hidden.bin')
    await click('取消'); expect(cancel).toHaveBeenCalledWith('tx-a')
  })
  it('discloses truncated directory listings instead of presenting partial results as complete', async () => {
    vi.mocked(sharingApi.status).mockResolvedValue({ ...emptySharingStatus(), received: [received] })
    vi.spyOn(sharingApi, 'listFiles').mockResolvedValue({ path: '.', parent: null, entries: [], truncated: true })
    await mount(); await click('别人共享的资源')
    expect(container.textContent).toContain('部分条目未列出')
    expect(container.textContent).not.toContain('此目录为空')
  })

})
