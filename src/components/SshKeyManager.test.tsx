// @vitest-environment jsdom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { sshKeyManagerApi, type SshKeyInfo } from '../services/sshKeyManager'
import { SshKeyManager } from './SshKeyManager'

vi.mock('../services/sshKeyManager', () => ({
  sshKeyManagerApi: { isDesktop: true, list: vi.fn(), generate: vi.fn(), import: vi.fn(), rename: vi.fn(), forget: vi.fn() },
}))

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const key: SshKeyInfo = {
  id: 'key-lab', name: '实验室服务器', algorithm: 'Ed25519',
  publicKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFixturePublicKey fixture-only',
  publicKeyPath: '/home/test/.ssh/lab.pub', privateKeyPath: '/home/test/.ssh/lab',
  fingerprint: 'SHA256:public-fixture-fingerprint', source: 'discovered', warning: null, usedBy: ['训练服务器'],
}
let container: HTMLDivElement
let root: ReturnType<typeof createRoot>
const clipboard = vi.fn(async (_value: string) => {})

beforeEach(() => {
  vi.clearAllMocks()
  sshKeyManagerApi.isDesktop = true
  vi.mocked(sshKeyManagerApi.list).mockResolvedValue([key])
  vi.mocked(sshKeyManagerApi.generate).mockResolvedValue({ ...key, id: 'new-key', name: '新的训练密钥', source: 'generated' })
  vi.mocked(sshKeyManagerApi.import).mockResolvedValue({ ...key, id: 'public-only', name: '共享公钥', privateKeyPath: null, source: 'imported', usedBy: [] })
  vi.mocked(sshKeyManagerApi.rename).mockResolvedValue(undefined)
  vi.mocked(sshKeyManagerApi.forget).mockResolvedValue(undefined)
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: clipboard } })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

async function render(onClose = vi.fn(), onChanged = vi.fn()) {
  await act(async () => { root.render(<SshKeyManager onClose={onClose} onChanged={onChanged} />) })
  return { onClose, onChanged }
}

function button(label: string) {
  const result = [...container.querySelectorAll<HTMLButtonElement>('button')].find((item) => item.getAttribute('aria-label') === label || item.textContent === label)
  expect(result, `button: ${label}`).toBeTruthy()
  return result!
}

function input(label: string) {
  const result = container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)
  expect(result, `input: ${label}`).toBeTruthy()
  return result!
}

function enter(label: string, value: string) {
  act(() => {
    const field = input(label)
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(field, value)
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

async function click(label: string) { await act(async () => { button(label).click() }) }
async function submit() { await act(async () => { container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) }) }

describe('SSH key manager', () => {
  it('loads real metadata, searches fingerprints, and copies only public content or a private path', async () => {
    await render()
    expect(sshKeyManagerApi.list).toHaveBeenCalledOnce()
    expect(container.textContent).toContain('训练服务器')
    expect(container.textContent).toContain('公钥 + 私钥')
    enter('搜索密钥', 'unknown-key')
    expect(container.textContent).toContain('没有匹配的密钥')
    enter('搜索密钥', 'public-fixture-fingerprint')
    expect(container.querySelectorAll('.ssh-key-manager__key')).toHaveLength(1)
    await click('复制公钥')
    expect(clipboard).toHaveBeenLastCalledWith(key.publicKey)
    await click('复制私钥路径')
    expect(clipboard).toHaveBeenLastCalledWith(key.privateKeyPath)
    expect(container.querySelector('textarea')?.value).toBe(key.publicKey)
  })

  it('requires a matching protection passphrase or explicit opt-in before generating', async () => {
    const { onChanged } = await render()
    await click('生成密钥')
    expect(document.activeElement).toBe(input('密钥名称'))
    enter('密钥名称', ' 新的训练密钥 ')
    await submit()
    expect(sshKeyManagerApi.generate).not.toHaveBeenCalled()
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('明确选择不设置口令')
    enter('保护口令', 'test-protection-value')
    enter('确认保护口令', 'does-not-match')
    await submit()
    expect(sshKeyManagerApi.generate).not.toHaveBeenCalled()
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('不一致')
    enter('确认保护口令', 'test-protection-value')
    await submit()
    expect(sshKeyManagerApi.generate).toHaveBeenCalledWith({ name: '新的训练密钥', algorithm: 'ed25519', passphrase: 'test-protection-value' })
    expect(onChanged).toHaveBeenCalledOnce()
    expect(container.querySelector('[role="status"]')?.textContent).toContain('已生成')
    await click('生成密钥')
    expect(input('保护口令').value).toBe('')
    enter('密钥名称', 'without-passphrase')
    act(() => container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click())
    await submit()
    expect(sshKeyManagerApi.generate).toHaveBeenLastCalledWith({ name: 'without-passphrase', algorithm: 'ed25519', passphrase: '' })
  })

  it('imports a public-only file and leaves private-path copy unavailable', async () => {
    const { onChanged } = await render()
    await click('导入已有密钥')
    enter('密钥文件路径', ' ~/.ssh/shared.pub ')
    await submit()
    expect(sshKeyManagerApi.import).toHaveBeenCalledWith({ path: '~/.ssh/shared.pub', name: null })
    expect(onChanged).toHaveBeenCalledOnce()
    expect(container.querySelector('.ssh-key-manager__details')?.textContent).toContain('未找到对应私钥')
    expect(container.querySelector('[aria-label="复制私钥路径"]')).toBeNull()
    expect(button('复制公钥').disabled).toBe(false)
  })

  it('renames metadata and confirms removal while preserving file and server configuration', async () => {
    const { onChanged } = await render()
    await click('重命名')
    enter('新的密钥名称', ' 训练集群 ')
    await submit()
    expect(sshKeyManagerApi.rename).toHaveBeenCalledWith({ id: key.id, name: '训练集群' })
    expect(container.querySelector('.ssh-key-manager__detail-heading h3')?.textContent).toBe('训练集群')
    await click('移出列表')
    expect(sshKeyManagerApi.forget).not.toHaveBeenCalled()
    expect(container.textContent).toContain('密钥文件、服务器配置及远端授权都会保留')
    expect(document.activeElement).toBe(button('取消'))
    await click('取消')
    expect(sshKeyManagerApi.forget).not.toHaveBeenCalled()
    await click('移出列表')
    await click('确认移出列表')
    expect(sshKeyManagerApi.forget).toHaveBeenCalledWith({ id: key.id })
    expect(container.querySelectorAll('.ssh-key-manager__key')).toHaveLength(0)
    expect(container.querySelector('[role="status"]')?.textContent).toContain('密钥文件和服务器配置均已保留')
    expect(onChanged).toHaveBeenCalledTimes(2)
  })

  it('keeps failures visible and allows retry without inventing a success', async () => {
    vi.mocked(sshKeyManagerApi.list).mockRejectedValueOnce(new Error('读取权限不足'))
    await render()
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('读取权限不足')
    await click('刷新密钥')
    expect(container.querySelectorAll('.ssh-key-manager__key')).toHaveLength(1)
    vi.mocked(sshKeyManagerApi.import).mockRejectedValueOnce(new Error('文件不是有效密钥'))
    await click('导入已有密钥')
    enter('密钥文件路径', '/tmp/not-a-key')
    await submit()
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('文件不是有效密钥')
    expect(container.querySelector('[role="status"]')).toBeNull()
    expect(input('密钥文件路径').value).toBe('/tmp/not-a-key')
    clipboard.mockRejectedValueOnce(new Error('denied'))
    await click('返回密钥')
    await click('复制公钥')
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('手动复制')
  })

  it('makes desktop-only operations explicit and unavailable in browser preview', async () => {
    sshKeyManagerApi.isDesktop = false
    await render()
    expect(sshKeyManagerApi.list).not.toHaveBeenCalled()
    expect(container.textContent).toContain('浏览器预览无法读取本机密钥')
    expect(container.querySelectorAll('.ssh-key-manager__key')).toHaveLength(0)
    await click('生成密钥')
    expect(button('创建密钥对').disabled).toBe(true)
    await submit()
    await click('导入已有密钥')
    expect(button('加入管理列表').disabled).toBe(true)
    await submit()
    expect(sshKeyManagerApi.generate).not.toHaveBeenCalled()
    expect(sshKeyManagerApi.import).not.toHaveBeenCalled()
  })

  it('traps keyboard focus, cancels inner forms with Escape, and restores the opener', async () => {
    const opener = document.createElement('button')
    document.body.appendChild(opener)
    opener.focus()
    const { onClose } = await render()
    const close = button('关闭密钥管理')
    expect(document.activeElement).toBe(close)
    const last = button('移出列表')
    act(() => { last.focus(); last.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })) })
    expect(document.activeElement).toBe(close)
    act(() => close.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true })))
    expect(document.activeElement).toBe(last)
    await click('生成密钥')
    act(() => input('密钥名称').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })))
    expect(onClose).not.toHaveBeenCalled()
    expect(container.querySelector('form')).toBeNull()
    act(() => close.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })))
    expect(onClose).toHaveBeenCalledOnce()
    act(() => root.render(null))
    expect(document.activeElement).toBe(opener)
    opener.remove()
  })

  it('keeps generation pending and prevents dismissing it before the result', async () => {
    let finish!: (value: SshKeyInfo) => void
    vi.mocked(sshKeyManagerApi.generate).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
    const { onClose } = await render()
    await click('生成密钥')
    enter('密钥名称', 'pending-key')
    act(() => container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click())
    await submit()
    expect(button('正在生成…').disabled).toBe(true)
    expect(button('关闭密钥管理').disabled).toBe(true)
    act(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })))
    expect(onClose).not.toHaveBeenCalled()
    await act(async () => { finish({ ...key, id: 'pending-key' }) })
    expect(button('关闭密钥管理').disabled).toBe(false)
  })
})
