// @vitest-environment jsdom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CopyTextButton } from './CopyTextButton'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: ReturnType<typeof createRoot>

beforeEach(() => {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.restoreAllMocks()
})

describe('CopyTextButton', () => {
  it('copies the exact multiline diagnostic and remains available for repeated copies', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    const diagnostic = 'SSH 连接失败\nConnection timed out · 中文路径/训练'
    await act(async () => root.render(<CopyTextButton text={diagnostic} label="复制连接错误" />))

    const button = container.querySelector<HTMLButtonElement>('button')!
    await act(async () => button.click())
    await act(async () => button.click())

    expect(writeText).toHaveBeenCalledTimes(2)
    expect(writeText).toHaveBeenNthCalledWith(1, diagnostic)
    expect(writeText).toHaveBeenNthCalledWith(2, diagnostic)
    expect(button.textContent).toContain('已复制')
    expect(button.getAttribute('aria-label')).toBe('再次复制连接错误')
    expect(container.querySelector('[role="status"]')?.textContent).toContain('复制连接错误成功')
  })

  it('keeps the action usable and announces a manual-copy fallback when clipboard access fails', async () => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: vi.fn().mockRejectedValue(new Error('denied')) } })
    await act(async () => root.render(<CopyTextButton text="连接被拒绝" label="复制连接错误" />))

    const button = container.querySelector<HTMLButtonElement>('button')!
    await act(async () => button.click())

    expect(button.disabled).toBe(false)
    expect(button.textContent).toContain('复制失败')
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('请选择文字')
  })

  it('ignores an earlier clipboard result after the copied text changes', async () => {
    let resolveFirst!: () => void
    const firstWrite = new Promise<void>((resolve) => { resolveFirst = resolve })
    const writeText = vi.fn().mockReturnValueOnce(firstWrite)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    await act(async () => root.render(<CopyTextButton text="旧错误" label="复制错误" />))

    container.querySelector<HTMLButtonElement>('button')!.click()
    await act(async () => root.render(<CopyTextButton text="新错误" label="复制错误" />))
    await act(async () => { resolveFirst(); await firstWrite })

    const button = container.querySelector<HTMLButtonElement>('button')!
    expect(button.textContent).toContain('复制错误')
    expect(button.textContent).not.toContain('已复制')
  })

  it('keeps the latest copy result when concurrent attempts finish out of order', async () => {
    let resolveFirst!: () => void
    let resolveSecond!: () => void
    const firstWrite = new Promise<void>((resolve) => { resolveFirst = resolve })
    const secondWrite = new Promise<void>((resolve) => { resolveSecond = resolve })
    const writeText = vi.fn().mockReturnValueOnce(firstWrite).mockReturnValueOnce(secondWrite)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    await act(async () => root.render(<CopyTextButton text="同一条错误" label="复制错误" />))

    const button = container.querySelector<HTMLButtonElement>('button')!
    button.click()
    button.click()
    await act(async () => { resolveSecond(); await secondWrite })
    await act(async () => { resolveFirst(); await firstWrite })

    expect(button.textContent).toContain('已复制')
    expect(writeText).toHaveBeenCalledTimes(2)
  })

  it('offers the manual-copy fallback when the Clipboard API is missing', async () => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined })
    await act(async () => root.render(<CopyTextButton text="连接超时" label="复制错误" />))

    await act(async () => container.querySelector<HTMLButtonElement>('button')!.click())

    expect(container.querySelector('[role="alert"]')?.textContent).toContain('请选择文字')
  })
})
