import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { Brand } from './Brand'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let container: HTMLDivElement, root: ReturnType<typeof createRoot>
beforeEach(() => { container = document.createElement('div'); document.body.append(container); root = createRoot(container) })
afterEach(() => { act(() => root.unmount()); container.remove() })

it('keeps RackTop primary and the correctly spelled AIsMov identity secondary in both languages', async () => {
  for (const english of [false, true]) {
    await act(async () => root.render(<Brand t={(zh, en) => english ? en : zh}/>))
    expect(container.querySelector('.brand strong')?.textContent).toBe('RackTop')
    expect(container.querySelector('.brand small')?.textContent).toBe(`AIsMov · ${english ? 'Team workspace' : '团队工作台'}`)
    expect(container.querySelector('.brand > span')?.getAttribute('aria-hidden')).toBe('true')
  }
})
