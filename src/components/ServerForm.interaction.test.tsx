// @vitest-environment jsdom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ServerForm } from './ServerForm'

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement | null = null
let root: ReturnType<typeof createRoot> | null = null

function enter(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  act(() => {
    setter?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

afterEach(() => {
  if (root) act(() => root?.unmount())
  container?.remove()
  root = null
  container = null
})

describe('ServerForm tag input', () => {
  it('commits English and Chinese commas and restores the last tag for Delete editing', () => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    act(() => root?.render(<ServerForm initial={{ id: 'server', tags: [] }} showGuide={false} onClose={vi.fn()} onSave={vi.fn()} />))

    const input = document.querySelector<HTMLInputElement>('[aria-label="添加服务器标签"]')
    expect(input).not.toBeNull()
    if (!input) return

    enter(input, 'lab,')
    expect(document.querySelector('.server-tag-input__token')?.textContent).toBe('lab')
    expect(input.value).toBe('')

    enter(input, 'h100，')
    expect([...document.querySelectorAll('.server-tag-input__token')].map((token) => token.textContent)).toEqual(['lab', 'h100'])

    act(() => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true, cancelable: true })))
    expect([...document.querySelectorAll('.server-tag-input__token')].map((token) => token.textContent)).toEqual(['lab'])
    expect(input.value).toBe('h100')
  })
})


describe('independent jump password', () => {
  function input(labelText: string) {
    const label = [...document.querySelectorAll('label')].find((label) => label.textContent === labelText)
    const field = label?.querySelector('input')
    expect(field, labelText).not.toBeNull()
    return field as HTMLInputElement
  }

  it('submits distinct passwords and clears jump secrets when its endpoint changes', async () => {
    const onSave = vi.fn(async () => {})
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    act(() => root?.render(<ServerForm initial={{ id: 'target', name: 'Target', host: '10.0.0.2', port: 22, username: 'worker', authMethod: 'password', proxyJump: 'jump@jump.example:21022', proxyUsePassword: true }} showGuide={false} onClose={vi.fn()} onSave={onSave} />))
    act(() => input('我理解风险并继续使用密码').click())
    enter(input('密码'), 'target-test-only')
    enter(input('跳板机密码'), 'jump-test-only')
    await act(async () => { document.querySelector('form')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) })
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ password: 'target-test-only', proxyPassword: 'jump-test-only', proxyUsePassword: true, saveProxyPassword: false }))
    enter(input('跳板机 ProxyJump'), 'other@other.example:22')
    expect(input('跳板机密码').value).toBe('')
    onSave.mockClear()
    await act(async () => { document.querySelector('form')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) })
    expect(onSave).not.toHaveBeenCalled()
    expect(document.querySelector('.form-error')?.textContent).toContain('输入该跳板机的密码')
    expect(input('密码').value).toBe('target-test-only')
  })

  it('removes an entered jump password when independent authentication is disabled', () => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    act(() => root?.render(<ServerForm initial={{ id: 'target', proxyJump: 'jump@jump.example:22', proxyUsePassword: true }} showGuide={false} onClose={vi.fn()} onSave={vi.fn()} />))
    enter(input('跳板机密码'), 'disposable')
    act(() => input('跳板机使用独立密码').click())
    expect(document.querySelector('.proxy-auth-fields input[type="password"]')).toBeNull()
    act(() => input('跳板机使用独立密码').click())
    expect(input('跳板机密码').value).toBe('')
  })
})
