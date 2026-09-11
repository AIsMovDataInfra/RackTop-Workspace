import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { api, ApiError } from './api'
import { SshImportDialog } from './SshImportDialog'
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let container: HTMLDivElement, root: ReturnType<typeof createRoot>
const saved = vi.fn(), failed = vi.fn(), close = vi.fn()
const config = (host = 'gpu.example.test') => `# RackTop SSH Config\n# RackTop-Name: "训练服务器"\nHost gpu\n  HostName ${host}\n  User researcher\n  Port 2222\n  IdentityFile /private/fixture-only-key\n`
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }
async function mount() { await act(async () => root.render(<SshImportDialog company="A公司" t={zh => zh} onClose={close} onSaved={saved} onFailure={failed}/>)) }
async function upload(text: string | Promise<string>, name = 'RackTop_ssh_fixture.conf', size = 300) {
  const file = new File([], name, { type: 'text/plain' })
  Object.defineProperties(file, { text: { value: () => Promise.resolve(text) }, size: { value: size } })
  const input = container.querySelector<HTMLInputElement>('input[type=file]')!
  Object.defineProperty(input, 'files', { configurable: true, value: [file] })
  await act(async () => input.dispatchEvent(new Event('change', { bubbles: true })))
}
async function submit() { await act(async () => container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))) }
function checks() { return [...container.querySelectorAll<HTMLInputElement>('input[type=checkbox]')] }
beforeEach(() => {
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  saved.mockClear(); failed.mockClear(); close.mockClear()
  vi.spyOn(api, 'serverMembers').mockResolvedValue({ members: [{ id: 'member-a', name: '测试成员', username: 'member' }] })
  vi.spyOn(api, 'importServers').mockResolvedValue({ servers: [], skipped: 1 })
})
afterEach(() => { act(() => root.unmount()); container.remove(); vi.restoreAllMocks() })
it('previews actual RackTop configuration and sends only selected metadata and explicit grants', async () => {
  await mount()
  await upload(config() + '\nHost second\n HostName other.example.test\n User other\n')
  expect(container.textContent).toContain('训练服务器')
  expect(container.textContent).toContain('researcher@gpu.example.test:2222')
  expect(container.textContent).not.toContain('/private/fixture-only-key')
  await act(async () => checks()[2].click()) // Leave only the first server selected.
  await act(async () => checks()[3].click())
  await submit()
  expect(api.importServers).toHaveBeenCalledExactlyOnceWith({ company: 'A公司', memberIds: ['member-a'], servers: [{ name: '训练服务器', host: 'gpu.example.test', port: 2222, username: 'researcher', jump: null, enabled: true }] })
  expect(saved).toHaveBeenCalledExactlyOnceWith('A公司', 0, 1)
})
it('rejects oversized files and stale file reads cannot replace a newer preview', async () => {
  await mount()
  await upload(config(), 'too-large.conf', 1024 * 1024 + 1)
  expect(container.querySelector('[role=alert]')?.textContent).toContain('1 MB')
  await submit(); expect(api.importServers).not.toHaveBeenCalled()
  const older = deferred<string>()
  await upload(older.promise, 'older.conf')
  await upload(config('new.example.test'), 'newer.conf')
  await act(async () => older.resolve(config('old.example.test')))
  expect(container.textContent).toContain('new.example.test')
  expect(container.textContent).not.toContain('old.example.test')
  await submit()
  expect(api.importServers).toHaveBeenCalledOnce()
})
it('changing organizations clears grants and blocks saving while the new member directory is unavailable', async () => {
  await mount(); await upload(config()); await act(async () => checks().at(-1)!.click())
  const nextMembers = deferred<{ members: { id: string; name: string; username: string }[] }>()
  vi.mocked(api.serverMembers).mockReturnValueOnce(nextMembers.promise)
  const select = container.querySelector('select')!
  await act(async () => { select.value = '西浦'; select.dispatchEvent(new Event('change', { bubbles: true })) })
  await submit(); expect(api.importServers).not.toHaveBeenCalled()
  await act(async () => nextMembers.resolve({ members: [{ id: 'member-x', name: '西浦成员', username: 'x' }] }))
  expect(checks().at(-1)!.checked).toBe(false)
  await submit()
  expect(api.importServers).toHaveBeenCalledWith(expect.objectContaining({ company: '西浦', memberIds: [] }))
})
it('preserves a failed import for an explicit retry and routes authentication failures to the workspace', async () => {
  vi.mocked(api.importServers).mockRejectedValueOnce(new ApiError('结果可能已保存，请重试时核对重复数量。', 408, 'WRITE_RESULT_UNKNOWN'))
  await mount(); await upload(config()); await submit()
  expect(container.querySelector('[role=alert]')?.textContent).toContain('结果可能已保存')
  expect(saved).not.toHaveBeenCalled()
  expect(checks()[1].checked).toBe(true)
  vi.mocked(api.importServers).mockRejectedValueOnce(new ApiError('登录已失效', 401, 'EXPIRED'))
  await submit()
  expect(failed).toHaveBeenCalledOnce(); expect(api.importServers).toHaveBeenCalledTimes(2)
})
it('does not submit invalid private-key input or apply late save results after closing', async () => {
  await mount(); await upload('-----BEGIN OPENSSH PRIVATE KEY-----\nfixture-only-do-not-display\n-----END OPENSSH PRIVATE KEY-----')
  expect(container.textContent).not.toContain('fixture-only-do-not-display')
  await submit(); expect(api.importServers).not.toHaveBeenCalled()
  await upload(config())
  const pending = deferred<{ servers: []; skipped: number }>()
  vi.mocked(api.importServers).mockReturnValueOnce(pending.promise)
  await submit()
  expect(container.querySelector<HTMLButtonElement>('button[type=submit]')?.disabled).toBe(true)
  await act(async () => root.render(null))
  await act(async () => pending.resolve({ servers: [], skipped: 1 }))
  expect(saved).not.toHaveBeenCalled()
})
