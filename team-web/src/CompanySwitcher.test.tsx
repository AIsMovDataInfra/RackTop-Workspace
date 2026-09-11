import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { CompanySwitcher } from './CompanySwitcher'
import { api, ApiError } from './api'
import type { Session } from './types'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const session: Session = { user: { id: 'multi', name: '成员', role: 'member', company: 'A公司', companies: ['A公司', '西浦'] }, csrfToken: 'fixture', authMode: 'account', feishuConfigured: false, notifications: { configured: false }, timezone: 'Asia/Shanghai' }
let container: HTMLDivElement, root: ReturnType<typeof createRoot>
const changed = vi.fn()
beforeEach(() => { container = document.createElement('div'); document.body.append(container); root = createRoot(container); changed.mockReset() })
afterEach(() => { act(() => root.unmount()); container.remove(); vi.restoreAllMocks() })
async function mount(value = session) { await act(async () => root.render(<CompanySwitcher session={value} t={zh => zh} onSessionChanged={changed}/>)) }
async function select(value: string) { await act(async () => { const input = container.querySelector('select')!; input.value = value; input.dispatchEvent(new Event('change', { bubbles: true })) }) }

it('lists only assigned organizations and waits for the server before replacing the session', async () => {
  let finish!: (value: Session) => void
  const change = vi.spyOn(api, 'switchCompany').mockImplementation(() => new Promise(resolve => { finish = resolve }))
  await mount()
  expect([...container.querySelectorAll('option')].map(option => option.value)).toEqual(['A公司', '西浦'])
  await select('西浦')
  expect(change).toHaveBeenCalledWith({ company: '西浦' }); expect(changed).not.toHaveBeenCalled()
  expect(container.querySelector('select')!.disabled).toBe(true)
  expect(container.querySelector('select')!.value).toBe('A公司')
  const switched = { ...session, user: { ...session.user!, company: '西浦' as const } }
  await act(async () => finish(switched))
  expect(changed).toHaveBeenCalledExactlyOnceWith(switched)
})

it('keeps the original organization on failure and allows another attempt', async () => {
  const change = vi.spyOn(api, 'switchCompany').mockRejectedValueOnce(new ApiError('denied', 403, 'COMPANY_FORBIDDEN')).mockResolvedValue(session)
  await mount(); await select('西浦')
  expect(container.querySelector('select')!.value).toBe('A公司'); expect(container.querySelector('select')!.disabled).toBe(false)
  expect(container.querySelector('[role="alert"]')).not.toBeNull(); expect(changed).not.toHaveBeenCalled()
  await select('西浦'); expect(change).toHaveBeenCalledTimes(2)
})

it('keeps super administrators global and supports a legacy single-company session', async () => {
  await mount({ ...session, user: { ...session.user!, isSuperAdmin: true, company: null, companies: [] } })
  expect(container.textContent).toBe('全部组织'); expect(container.querySelector('select')).toBeNull()
  await mount({ ...session, user: { ...session.user!, companies: undefined } })
  expect(container.querySelector('select')!.disabled).toBe(true)
  expect([...container.querySelectorAll('option')].map(option => option.value)).toEqual(['A公司'])
})

it('ignores a switch response after the member or active organization has been replaced', async () => {
  let finish!: (value: Session) => void
  vi.spyOn(api, 'switchCompany').mockImplementation(() => new Promise(resolve => { finish = resolve }))
  await mount(); await select('西浦')
  await mount({ ...session, user: { ...session.user!, id: 'other', company: '西浦' } })
  await act(async () => finish(session))
  expect(changed).not.toHaveBeenCalled()
})
