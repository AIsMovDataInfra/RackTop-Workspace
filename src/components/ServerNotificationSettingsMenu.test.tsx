// @vitest-environment jsdom

import { act, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ServerNotificationSettingsMenu } from '../App'
import { defaultServerNotificationSettings } from '../utils/serverNotifications'

vi.mock('./SshTerminal', () => ({ SshTerminal: () => null }))

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

Object.defineProperty(window, 'matchMedia', {
  configurable: true,
  value: vi.fn(() => ({ matches: true })),
})
window.requestAnimationFrame = (callback) => window.setTimeout(() => callback(performance.now()), 0)
window.cancelAnimationFrame = (handle) => window.clearTimeout(handle)
Element.prototype.scrollIntoView = vi.fn()

let root: ReturnType<typeof createRoot> | null = null

afterEach(() => {
  if (root) act(() => root?.unmount())
  root = null
  document.body.innerHTML = ''
})

describe('ServerNotificationSettingsMenu', () => {
  it('opens directly in partial mode and stays open while selecting categories', async () => {
    const container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    const onOpenRequestHandled = vi.fn()

    await act(async () => {
      root?.render(<ServerNotificationSettingsMenu
        settings={defaultServerNotificationSettings('server')}
        onChange={vi.fn()}
        openRequested
        onOpenRequestHandled={onOpenRequestHandled}
      />)
    })

    expect(container.querySelector('.notification-menu__trigger')?.textContent).toContain('部分')
    expect(container.querySelector('[role="menu"]')).not.toBeNull()
    expect(container.querySelector('[role="menuitemradio"][aria-checked="true"]')?.textContent).toContain('部分')
    expect(onOpenRequestHandled).toHaveBeenCalledOnce()

    const categories = [...container.querySelectorAll<HTMLButtonElement>('[role="menuitemcheckbox"]')]
    await act(async () => categories[0].click())
    await act(async () => categories[1].click())

    expect(container.querySelector('[role="menu"]')).not.toBeNull()
    expect(container.querySelectorAll('[role="menuitemcheckbox"][aria-checked="true"]')).toHaveLength(2)
  })
  it('saves every category immediately and allows the final category to switch all notifications off', async () => {
    const saved = vi.fn()
    function Controlled() {
      const [settings, setSettings] = useState(defaultServerNotificationSettings('server'))
      return <ServerNotificationSettingsMenu settings={settings} onChange={next => { saved(next); setSettings(next) }}/>
    }
    const container = document.createElement('div'); document.body.append(container); root = createRoot(container)
    await act(async () => root?.render(<Controlled/>))
    await act(async () => container.querySelector<HTMLButtonElement>('.notification-menu__trigger')!.click())
    await act(async () => [...container.querySelectorAll<HTMLButtonElement>('[role=menuitemradio]')].find(button => button.textContent === '部分')!.click())
    for (const category of ['我的任务结束','他人的僵尸或卡住进程','我的显存异常释放','设备与连接告警']) {
      const button=[...container.querySelectorAll<HTMLButtonElement>('[role=menuitemcheckbox]')].find(button=>button.textContent===category)!
      expect(button.disabled).toBe(false)
      await act(async () => button.click())
    }
    expect(saved).toHaveBeenCalledTimes(4)
    expect(saved).toHaveBeenLastCalledWith({serverId:'server',mode:'off',task:false,zombie:false,memory:false,system:false})
    expect(container.querySelector('[role=menu]')).toBeNull()
    expect(container.textContent).toContain('此服务器的系统通知已关闭')
    await act(async () => container.querySelector<HTMLButtonElement>('.notification-menu__trigger')!.click())
    await act(async () => document.dispatchEvent(new Event('pointerdown', {bubbles:true})))
    expect(saved).toHaveBeenCalledTimes(4)
    expect(container.querySelector('.notification-menu__trigger')?.textContent).toBe('关闭')
  })

})
