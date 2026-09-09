import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AvatarPicker, MemberAvatar, MEMBER_AVATARS } from './MemberAvatar'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let container: HTMLDivElement, root: ReturnType<typeof createRoot>
beforeEach(() => { container = document.createElement('div'); document.body.append(container); root = createRoot(container) })
afterEach(() => { act(() => root.unmount()); container.remove() })

it('renders 24 distinct built-in choices, retaining every legacy avatar with visible color fills', async () => {
  const ids = MEMBER_AVATARS.map(item => item.id)
  expect(new Set(ids).size).toBe(24)
  for (const id of ['user', 'cat', 'dog', 'rocket', 'robot', 'flower', 'star']) expect(ids).toContain(id)
  await act(async () => root.render(<AvatarPicker value="robot" t={(zh) => zh} onChange={vi.fn()} />))
  const options = [...container.querySelectorAll<HTMLButtonElement>('button')]
  expect(options).toHaveLength(24)
  const colors = new Set<string>()
  for (const option of options) {
    expect(option.getAttribute('aria-label')).toBeTruthy()
    const avatar = option.querySelector<HTMLElement>('.member-avatar')!
    expect(avatar.getAttribute('aria-hidden')).toBe('true')
    expect(avatar.querySelector('svg')?.getAttribute('fill')).not.toBe('none')
    colors.add(avatar.style.getPropertyValue('--avatar-background'))
  }
  expect(colors.size).toBeGreaterThanOrEqual(8)
  expect(container.querySelectorAll('[aria-pressed="true"]')).toHaveLength(1)
  expect(container.querySelector('[aria-pressed="true"]')?.getAttribute('aria-label')).toBe('机器人')
})

it('shows a safe fallback for missing or unknown identities without loading remote images', async () => {
  for (const avatar of [undefined, 'unknown-future-avatar', 'https://example.test/tracker.svg']) {
    await act(async () => root.render(<><MemberAvatar avatar={avatar}/><AvatarPicker value={avatar || ''} t={(_zh, en) => en} onChange={vi.fn()}/></>))
    expect(container.firstElementChild?.getAttribute('data-avatar')).toBe('user')
    expect(container.querySelector('[aria-pressed="true"]')?.getAttribute('aria-label')).toBe('Person')
    expect(container.querySelector('img, image, iframe')).toBeNull()
  }
})

it('selects a new labeled choice with a native button and prevents changes while saving', async () => {
  const change = vi.fn()
  await act(async () => root.render(<AvatarPicker value="cat" onChange={change} t={(_zh, en) => en}/>))
  const satellite = container.querySelector<HTMLButtonElement>('button[aria-label="Satellite"]')!
  satellite.focus(); expect(document.activeElement).toBe(satellite)
  await act(async () => satellite.click()); expect(change).toHaveBeenCalledWith('satellite')
  await act(async () => root.render(<AvatarPicker value="satellite" onChange={change} disabled t={(_zh, en) => en}/>))
  expect(container.querySelector('button[aria-label="Satellite"]')?.getAttribute('aria-pressed')).toBe('true')
  expect([...container.querySelectorAll('button')].every(button => button.matches(':disabled'))).toBe(true)
  change.mockClear(); await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="Cat"]')!.click())
  expect(change).not.toHaveBeenCalled()
})
