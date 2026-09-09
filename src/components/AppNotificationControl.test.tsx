// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import App from '../App'
import { api } from '../services/api'
import { defaultServerNotificationSettings, normalizeServerNotificationSettings } from '../utils/serverNotifications'
import { DEFAULT_IDLE_FILTERS } from '../utils/idleFilters'
import type { IdleReservation, ServerNotificationSettings, Snapshot } from '../types/models'
vi.mock('./SshTerminal', () => ({ SshTerminal: () => null }))
vi.mock('echarts-for-react/lib/core', () => ({ default: () => null }))
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }))
vi.mock('../services/appUpdater', () => ({ checkDesktopAppUpdate: vi.fn(async () => null), relaunchUpdatedApp: vi.fn() }))
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} }
Object.defineProperty(window, 'matchMedia', { configurable: true, value: vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })) })
Element.prototype.scrollIntoView = vi.fn()
let root: ReturnType<typeof createRoot> | null = null
let now = 1_800_000_000_000
let nextTimer = 1
const click = async (container: HTMLElement, name: string) => {
  const button=[...container.querySelectorAll<HTMLButtonElement>('button')].find(button=>button.textContent===name)
  expect(button).toBeDefined()
  await act(async()=>button!.click())
}
afterEach(()=>{act(()=>root?.unmount());root=null;document.body.innerHTML='';localStorage.clear();vi.restoreAllMocks()})
async function mount(mode: 'all'|'off' = 'all', reservations: IdleReservation[] = []) {
  const server=(await api.listServers())[0]
  const source=(await api.listLatestSnapshots())[0]
  const snapshot: Snapshot={...source,serverId:server.id,timestamp:now/1000,processes:[],cpuProcesses:[],gpus:[{...source.gpus[0],memoryUsedMb:0,memoryUtilization:0,utilization:0,temperatureCelsius:50}]}
  let persisted=normalizeServerNotificationSettings({...defaultServerNotificationSettings(server.id),mode})
  vi.spyOn(api,'listServers').mockResolvedValue([{...server,remoteHistoryEnabled:false}])
  vi.spyOn(api,'listLatestSnapshots').mockResolvedValue([snapshot])
  vi.spyOn(api,'listProjects').mockResolvedValue([])
  vi.spyOn(api,'listIdleReservations').mockResolvedValue(reservations)
  const saveReservation=vi.spyOn(api,'saveIdleReservation').mockImplementation(async value=>value)
  vi.spyOn(api,'listServerNotificationSettings').mockImplementation(async()=>[persisted])
  const save=vi.spyOn(api,'saveServerNotificationSettings').mockImplementation(async next=>{persisted=next;return next})
  const collect=vi.spyOn(api,'collectServer').mockResolvedValue(snapshot)
  vi.spyOn(api,'getHistory').mockResolvedValue([])
  const notify=vi.spyOn(api,'notify').mockResolvedValue(undefined)
  vi.spyOn(Date,'now').mockImplementation(()=>now)
  const browserTimers: Pick<Window, 'setInterval' | 'clearInterval'> = window
  vi.spyOn(browserTimers,'setInterval').mockImplementation(()=>nextTimer++)
  vi.spyOn(browserTimers,'clearInterval').mockImplementation(()=>{})
  const container=document.createElement('div');document.body.append(container);root=createRoot(container)
  await act(async()=>{root!.render(<App/>);await Promise.resolve()})
  await act(async()=>container.querySelector<HTMLButtonElement>('.server-row')!.click())
  await click(container,'配置')
  async function choose(next: '打开'|'关闭') {
    await act(async()=>container.querySelector<HTMLButtonElement>('.notification-menu__trigger')!.click())
    const item=[...container.querySelectorAll<HTMLButtonElement>('[role=menuitemradio]')].find(button=>button.textContent===next)!
    await act(async()=>item.click())
  }
  return {container,snapshot,server,save,collect,notify,choose,saveReservation}
}
describe('application notification settings',()=>{
  it('mutes a GPU collection already in flight and retains the saved mute after remount',async()=>{
    const {container,snapshot,save,collect,notify,choose}=await mount()
    let resolve!: (value:Snapshot)=>void
    collect.mockImplementationOnce(()=>new Promise(done=>{resolve=done}))
    await act(async()=>container.querySelector<HTMLButtonElement>('[aria-label="刷新当前服务器"]')!.click())
    await choose('关闭')
    expect(save).toHaveBeenLastCalledWith(expect.objectContaining({mode:'off',system:false}))
    const hot={...snapshot,timestamp:snapshot.timestamp+10,gpus:snapshot.gpus.map(gpu=>({...gpu,temperatureCelsius:99}))}
    await act(async()=>resolve(hot))
    expect(notify).not.toHaveBeenCalled()
    expect(container.querySelector('.notification-menu__trigger')?.textContent).toBe('关闭')
    act(()=>root!.unmount())
    collect.mockResolvedValue(hot)
    vi.mocked(api.listLatestSnapshots).mockResolvedValue([hot])
    root=createRoot(container)
    await act(async()=>root!.render(<App/>))
    await act(async()=>container.querySelector<HTMLButtonElement>('.server-row')!.click())
    await click(container,'配置')
    expect(container.querySelector('.notification-menu__trigger')?.textContent).toBe('关闭')
    expect(notify).not.toHaveBeenCalled()
  })
  it('serializes rapid changes and does not let earlier saves replace the final switch value',async()=>{
    const {container,save,choose}=await mount()
    const pending:Array<{value:ServerNotificationSettings;resolve:(value:ServerNotificationSettings)=>void}>=[]
    save.mockImplementation(value=>new Promise(resolve=>pending.push({value,resolve})))
    await choose('关闭');await choose('打开');await choose('关闭')
    expect(save).toHaveBeenCalledTimes(1)
    expect(container.querySelector('.notification-menu__trigger')?.textContent).toBe('关闭')
    await act(async()=>pending[0].resolve(pending[0].value))
    expect(save).toHaveBeenCalledTimes(2)
    expect(container.querySelector('.notification-menu__trigger')?.textContent).toBe('关闭')
    await act(async()=>pending[1].resolve(pending[1].value))
    expect(save).toHaveBeenCalledTimes(3)
    expect(container.querySelector('.notification-menu__trigger')?.textContent).toBe('关闭')
    await act(async()=>pending[2].resolve(pending[2].value))
    expect(save.mock.calls.map(([settings])=>settings.mode)).toEqual(['off','all','off'])
  })
  it('restores the last successfully saved setting when a newer change fails',async()=>{
    const {container,save,choose}=await mount()
    await choose('关闭')
    save.mockRejectedValueOnce(new Error('disk write failed'))
    await choose('打开')
    expect(container.querySelector('.notification-menu__trigger')?.textContent).toBe('关闭')
    expect(container.textContent).toContain('通知设置保存失败')
  })
  it.each(['all','off'] as const)('applies server %s mode to idle-reservation system notifications',async mode=>{
    const reservation:IdleReservation={id:'mute-reservation',name:'空闲验收',createdAt:now/1000,expiresAt:null,notifyMode:'once',status:'active',matchedGpuKeys:[],filters:{...DEFAULT_IDLE_FILTERS,duration:0}}
    const {container,snapshot,collect,notify,saveReservation}=await mount(mode,[reservation])
    now+=31_000
    collect.mockResolvedValue({...snapshot,timestamp:now/1000})
    await act(async()=>container.querySelector<HTMLButtonElement>('[aria-label="刷新当前服务器"]')!.click())
    const notifications=notify.mock.calls.filter(([title])=>title.includes('预约条件已满足'))
    expect(notifications).toHaveLength(mode==='all'?1:0)
    expect(saveReservation).toHaveBeenCalledWith(expect.objectContaining({id:reservation.id,status:'completed'}))
  })
})
