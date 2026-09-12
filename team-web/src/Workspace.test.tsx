import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Workspace } from './Workspace'
import { api } from './api'
import type { Resource, Session } from './types'
import type { PreferencesState } from './preferences'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const state: PreferencesState = { t: zh => zh, preferences: { locale: 'zh-CN', theme: 'light', largeText: false }, setPreferences: vi.fn() }
const session: Session = { user: { id: 'member', name: '合成成员', role: 'member', company: 'A公司' }, csrfToken: 'fixture', authMode: 'account', feishuConfigured: false, notifications: { configured: false }, timezone: 'Asia/Shanghai' }
const gpu: Resource = { id: 'gpu', name: '占用中的GPU', cluster: '上海', gpuModel: 'A100', gpuCount: 1, notes: '', enabled: true,
  usage: { state: 'busy', observedAt: new Date().toISOString(), gpus: [{ id: 'gpu-0', uuid: 'GPU-0', index: 0, state: 'busy', users: ['linux-training'], utilization: 95, memoryUsedMb: 1000 }] } }
const cpu: Resource = { ...gpu, id: 'cpu', name: '阿里云CPU', gpuCount: 0, gpuModel: '', usage: undefined }
let root: ReturnType<typeof createRoot>, container: HTMLDivElement
beforeEach(() => { container = document.createElement('div'); document.body.append(container); root = createRoot(container); window.history.replaceState({}, '', '/'); vi.spyOn(api, 'resources').mockResolvedValue({ resources: [gpu, cpu] }); vi.spyOn(api, 'reservations').mockResolvedValue({ reservations: [] }) })
afterEach(() => { act(() => root.unmount()); container.remove(); vi.restoreAllMocks() })
function cards() { return [...container.querySelectorAll('.resource-card h3')].map(item => item.textContent) }

it('keeps occupied servers visible and filters the same cluster name independently under GPU and CPU groups', async () => {
  await act(async () => root.render(<Workspace session={session} state={state} onLogout={vi.fn()} onSessionExpired={vi.fn()} />))
  expect(cards()).toEqual(['占用中的GPU', '阿里云CPU'])
  expect(container.querySelectorAll('.cluster-member')).toHaveLength(2)
  expect(container.querySelector('.main-nav')?.textContent).not.toContain('周报')
  expect(container.querySelector('.main-nav')?.textContent).toContain('资产设备管理')
  expect(container.querySelector('.main-nav')?.textContent).toContain('办公设备申请')
  const cpuGroup = [...container.querySelectorAll('.sidebar-cluster-group')].find(group => group.querySelector('.cluster-kind')?.textContent?.includes('CPU 集群'))!
  await act(async () => cpuGroup.querySelector<HTMLButtonElement>('.cluster-kind')!.click())
  expect(cards()).toEqual(['阿里云CPU'])
  expect(container.querySelector('.resource-usage-state')?.textContent).toBe('未知')
  await act(async () => cpuGroup.querySelector<HTMLButtonElement>('.cluster-member')!.click())
  expect(cards()).toEqual(['阿里云CPU'])
  const gpuGroup = [...container.querySelectorAll('.sidebar-cluster-group')].find(group => group.querySelector('.cluster-kind')?.textContent?.includes('GPU 集群'))!
  await act(async () => gpuGroup.querySelector<HTMLButtonElement>('.cluster-member')!.click())
  expect(cards()).toEqual(['占用中的GPU'])
  expect(container.querySelector('.resource-usage-state')?.textContent).toBe('被占用')
  const reserve = container.querySelector<HTMLButtonElement>('.resource-card > header > button')!
  expect(reserve.disabled).toBe(false)
  await act(async () => reserve.click())
  expect(container.querySelector('[role="dialog"]')?.textContent).toContain('新建预约')
})
