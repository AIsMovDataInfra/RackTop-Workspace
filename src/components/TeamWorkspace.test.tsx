// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { TeamWorkspace } from './TeamWorkspace'
import { teamApi, type TeamData, type TeamStatus } from '../services/team'
import { openExternalUrl } from '../services/external'
import type { Server } from '../types/models'
vi.mock('../services/external', () => ({ openExternalUrl: vi.fn() }))
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const server: Server = { id: 'local-a', name: 'A100', host: 'secret-host.invalid', port: 2222, username: 'secret-ssh-user', identityFile: '/secret/key', authMethod: 'sshAgent', status: 'online', tags: [], samplingIntervalSeconds: 2, historyRetentionDays: 90, remoteHistoryEnabled: false }
const anonymous: TeamStatus = { url:'https://136.0.110.161',authenticated:false,user:null,bindings:{} }
const admin: TeamStatus = { ...anonymous,authenticated:true,user:{id:'admin',name:'管理员',username:'owner',role:'admin'} }
const member: TeamStatus = { ...anonymous,authenticated:true,user:{id:'member',name:'团队成员',username:'中',role:'member'} }
const waiting: TeamStatus = { ...member, user: { ...member.user!, company: null, isSuperAdmin: false, version: 1 } }
const privateData: TeamData = {
  resources:[{id:'resource-123',name:'成员专用资源',cluster:'团队',gpuModel:'A100',gpuCount:8,status:'unknown',lastSeenAt:null,inventoryState:'synced',enabled:true}],
  reservations:[{id:'booking-123',resourceId:'resource-123',resourceName:'成员预约记录',ownerName:'预约成员',scope:'machine',gpuIndices:[],startAt:new Date().toISOString(),endAt:new Date(Date.now()+3_600_000).toISOString(),status:'confirmed'}],
}
let root: ReturnType<typeof createRoot>, container: HTMLDivElement
const click = async (text:string) => { const button=[...container.querySelectorAll('button')].find(b=>b.textContent?.includes(text));expect(button).toBeTruthy();await act(async()=>button!.click()) }
const mount = async () => { await act(async()=>root.render(<TeamWorkspace servers={[server]} snapshots={{}}/>)) }
beforeEach(()=>{
  container=document.createElement('div');document.body.append(container);root=createRoot(container)
  vi.spyOn(teamApi,'status').mockResolvedValue(anonymous)
  vi.spyOn(teamApi,'data').mockResolvedValue({resources:[],reservations:[]})
})
afterEach(()=>{act(()=>root.unmount());container.remove();vi.restoreAllMocks();vi.useRealTimers()})
describe('team workspace',()=>{
  it('requires login before requesting or displaying any team data and keeps the registration link reachable',async()=>{
    vi.mocked(teamApi.data).mockResolvedValue(privateData)
    await mount()
    expect(container.textContent).toContain('登录团队账号后查看资源与排期')
    expect(container.textContent).toContain('注册后即成为成员')
    expect(teamApi.data).not.toHaveBeenCalled()
    expect(container.textContent).not.toContain('团队资源')
    expect(container.textContent).not.toContain('当前与即将开始的预约')
    expect(container.textContent).not.toContain('成员专用资源')
    expect(container.textContent).not.toContain('成员预约记录')
    expect([...container.querySelectorAll('h2')].some(h=>h.textContent==='同步本机资源')).toBe(false)
    expect(container.textContent).not.toContain(server.host)
    expect(container.textContent).not.toContain(server.username)
    expect(container.textContent).not.toContain(server.identityFile)
    await click('打开预约网页')
    expect(openExternalUrl).toHaveBeenCalledWith('https://136.0.110.161/')
  })
  it('opens password recovery at the trusted team service without passing credentials',async()=>{
    await mount();await click('账号登录')
    const password=container.querySelector<HTMLInputElement>('input[type=password]')!
    await act(async()=>{
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(password,'仅本机输入')
      password.dispatchEvent(new Event('input',{bubbles:true}))
    })
    await click('忘记密码')
    expect(openExternalUrl).toHaveBeenLastCalledWith('https://136.0.110.161/?auth=recover')
    expect(container.querySelector('[role=dialog]')).not.toBeNull()
  })
  it('keeps an unassigned member signed in without polling business data and loads data after company assignment',async()=>{
    vi.useFakeTimers()
    vi.mocked(teamApi.status).mockResolvedValue(waiting)
    vi.mocked(teamApi.data).mockResolvedValue(privateData)
    await mount()
    expect(container.textContent).toContain('等待分配公司')
    expect(container.textContent).not.toContain('尚未连接团队账号')
    expect(container.textContent).not.toContain('团队资源 0')
    expect(container.textContent).not.toContain('当前与即将开始的预约')
    expect(teamApi.data).not.toHaveBeenCalled()
    await act(async()=>{await vi.advanceTimersByTimeAsync(60_000)})
    expect(teamApi.data).not.toHaveBeenCalled()
    await click('打开预约网页')
    expect(openExternalUrl).toHaveBeenLastCalledWith('https://136.0.110.161/')
    vi.mocked(teamApi.status).mockResolvedValue({ ...waiting, user: { ...waiting.user!, company: '西浦', version: 2 } })
    await click('刷新')
    expect(container.textContent).not.toContain('等待分配公司')
    expect(container.querySelector('.team-account-company')?.textContent).toContain('所属公司西浦')
    expect(container.querySelector('.team-account-company input,.team-account-company select')).toBeNull()
    expect(container.textContent).toContain('成员预约记录')
    expect(container.textContent).toContain('成员专用资源')
  })
  it('prevents an unassigned resource admin from publishing and still allows logout',async()=>{
    vi.mocked(teamApi.status).mockResolvedValue({ ...admin, user: { ...admin.user!, company: null, isSuperAdmin: false } })
    const logout=vi.spyOn(teamApi,'logout').mockImplementation(async()=>{vi.mocked(teamApi.status).mockResolvedValue(anonymous)})
    await mount()
    expect(container.textContent).toContain('等待分配公司')
    expect(container.textContent).not.toContain('同步本机资源')
    expect(teamApi.data).not.toHaveBeenCalled()
    await click('退出账号')
    expect(logout).toHaveBeenCalledOnce()
    expect(container.textContent).toContain('尚未连接团队账号')
  })
  it('clears the previous company data before a changed-company refresh finishes',async()=>{
    vi.mocked(teamApi.status).mockResolvedValue({ ...member, user: { ...member.user!, company: 'A公司' } })
    vi.mocked(teamApi.data).mockResolvedValue(privateData)
    await mount()
    expect(container.textContent).toContain('成员专用资源')
    let resolveData!: (value: TeamData) => void
    const pending = new Promise<TeamData>(resolve => { resolveData = resolve })
    vi.mocked(teamApi.status).mockResolvedValue({ ...member, user: { ...member.user!, company: 'B公司' } })
    vi.mocked(teamApi.data).mockReturnValue(pending)
    await click('刷新')
    expect(container.textContent).toContain('B公司')
    expect(container.textContent).not.toContain('成员专用资源')
    expect(container.textContent).not.toContain('成员预约记录')
    await act(async()=>resolveData({ resources: [], reservations: [] }))
  })
  it('lets the super administrator access data globally and ignores a historical company value',async()=>{
    vi.mocked(teamApi.status).mockResolvedValue({ ...admin, user: { ...admin.user!, company: 'A公司', isSuperAdmin: true, version: 1 } })
    vi.mocked(teamApi.data).mockResolvedValue(privateData)
    await mount()
    expect(container.textContent).toContain('超级管理员')
    expect(container.querySelector('.team-account-company')?.textContent).toContain('所属公司跨公司管理')
    expect(container.querySelector('.team-account-company')?.textContent).not.toContain('A公司')
    expect(container.textContent).toContain('同步本机资源')
    expect(container.textContent).toContain('成员预约记录')
    expect(container.textContent).not.toContain('等待分配公司')
  })
  it('clears visible data but preserves the login when the server requires company assignment',async()=>{
    vi.mocked(teamApi.status).mockResolvedValue({ ...member, user: { ...member.user!, company: 'A公司', isSuperAdmin: false, version: 1 } })
    vi.mocked(teamApi.data).mockResolvedValue(privateData)
    await mount()
    expect(container.textContent).toContain('成员预约记录')
    vi.mocked(teamApi.data).mockImplementationOnce(async()=>{
      vi.mocked(teamApi.status).mockResolvedValue(waiting)
      throw new Error('COMPANY_REQUIRED: 请联系超级管理员分配公司')
    })
    await click('刷新')
    expect(container.textContent).toContain('等待分配公司')
    expect(container.textContent).not.toContain('尚未连接团队账号')
    expect(container.textContent).not.toContain('成员预约记录')
    expect(container.textContent).not.toContain('成员专用资源')
    expect(container.querySelector('[role=alert]')).toBeNull()
    const count=vi.mocked(teamApi.data).mock.calls.length
    await click('刷新')
    expect(teamApi.data).toHaveBeenCalledTimes(count)
  })
  it('publishes only selected IDs and shows per-resource synchronization errors',async()=>{
    vi.mocked(teamApi.status).mockResolvedValue(admin)
    const saved={...admin,bindings:{'local-a':{resourceId:null,lastSyncedAt:null,error:'硬件清单需要核验'}}}
    const select=vi.spyOn(teamApi,'select').mockImplementation(async()=>{vi.mocked(teamApi.status).mockResolvedValue(saved);return saved})
    await mount()
    await act(async()=>container.querySelector<HTMLInputElement>('input[type=checkbox]')!.click())
    await click('保存并同步')
    expect(select).toHaveBeenCalledWith(['local-a'])
    expect(container.textContent).toContain('硬件清单需要核验')
    expect(container.textContent).not.toContain(server.host)
  })
  it('blocks resource publication for ordinary members',async()=>{
    vi.mocked(teamApi.status).mockResolvedValue({...admin,user:{...admin.user!,role:'member'}})
    await mount();expect([...container.querySelectorAll('h2')].some(h=>h.textContent==='同步本机资源')).toBe(false)
    expect(container.querySelector('input[type=checkbox]')).toBeNull()
  })
  it('focuses the login field, clears its password on Escape and restores focus',async()=>{
    await mount()
    const trigger=[...container.querySelectorAll('button')].find(b=>b.textContent?.includes('账号登录'))!
    trigger.focus();await click('账号登录')
    expect(document.activeElement).toBe(container.querySelector('input[autocomplete=username]'))
    const pw=container.querySelector<HTMLInputElement>('input[type=password]')!
    await act(async()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(pw,'test-password-123');pw.dispatchEvent(new Event('input',{bubbles:true}))})
    await act(async()=>container.querySelector('[role=dialog]')!.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})))
    expect(container.querySelector('[role=dialog]')).toBeNull();expect(document.activeElement).toBe(trigger)
    await click('账号登录');expect(container.querySelector<HTMLInputElement>('input[type=password]')!.value).toBe('')
  })
  it('preserves the exact server selection when opening a resource in the browser',async()=>{
    vi.mocked(teamApi.status).mockResolvedValue(member)
    vi.mocked(teamApi.data).mockResolvedValue(privateData)
    await mount();await click('查看与预约')
    expect(openExternalUrl).toHaveBeenCalledWith('https://136.0.110.161/?resource=resource-123')
    expect(container.textContent).toContain('状态未知')
  })
  it.each([['a single Chinese character','中'],['long ordinary characters',' A.+ @ 中文 ! '.repeat(40)]])('logs in with %s and a short password without browser constraints',async(_label,username)=>{
    const login=vi.spyOn(teamApi,'login').mockImplementation(async()=>{vi.mocked(teamApi.status).mockResolvedValue(member);return member})
    vi.mocked(teamApi.data).mockResolvedValue(privateData)
    await mount()
    expect(teamApi.data).not.toHaveBeenCalled()
    await click('账号登录')
    const user=container.querySelector<HTMLInputElement>('input[autocomplete=username]')!
    const password=container.querySelector<HTMLInputElement>('input[type=password]')!
    await act(async()=>{
      for(const [field,value] of [[user,username],[password,' 密 ']] as const){
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(field,value)
        field.dispatchEvent(new Event('input',{bubbles:true}))
      }
    })
    expect(container.querySelector<HTMLFormElement>('form')!.checkValidity()).toBe(true)
    expect(container.querySelector('input[minlength],input[maxlength],input[pattern]')).toBeNull()
    await act(async()=>container.querySelector('form')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})))
    expect(login).toHaveBeenLastCalledWith(username.trim(),' 密 ')
    expect(container.querySelector('[role=dialog]')).toBeNull()
    expect(container.textContent).toContain('成员专用资源')
    expect(container.textContent).toContain('成员预约记录')
  })
  it('allows logout while synchronization is waiting and updates local state even if revocation fails',async()=>{
    vi.mocked(teamApi.status).mockResolvedValue(admin)
    vi.mocked(teamApi.data).mockResolvedValue(privateData)
    let finishSync!: (value:TeamStatus)=>void
    vi.spyOn(teamApi,'select').mockImplementation(()=>new Promise(resolve=>{finishSync=resolve}))
    const logout=vi.spyOn(teamApi,'logout').mockImplementation(async()=>{vi.mocked(teamApi.status).mockResolvedValue(anonymous);throw new Error('已退出本机，远端撤销暂时无法确认')})
    await mount();await click('立即同步')
    const button=[...container.querySelectorAll('button')].find(b=>b.textContent?.includes('退出账号'))!
    expect(button.disabled).toBe(false)
    await click('退出账号');expect(logout).toHaveBeenCalledOnce()
    expect(container.textContent).toContain('尚未连接团队账号')
    expect(container.textContent).toContain('远端撤销暂时无法确认')
    expect(container.textContent).not.toContain('成员专用资源')
    expect(container.textContent).not.toContain('成员预约记录')
    await act(async()=>finishSync(admin))
    expect(container.textContent).toContain('尚未连接团队账号')
    expect(container.textContent).not.toContain('团队资源')
    expect(container.textContent).not.toContain('成员专用资源')
  })
  it('clears cached data on an expired session and stops anonymous business requests',async()=>{
    vi.mocked(teamApi.status).mockResolvedValue(member)
    vi.mocked(teamApi.data).mockResolvedValue(privateData)
    await mount()
    expect(container.textContent).toContain('成员预约记录')
    vi.mocked(teamApi.data).mockImplementationOnce(async()=>{
      vi.mocked(teamApi.status).mockResolvedValue(anonymous)
      throw new Error('团队登录已失效，请重新登录')
    })
    await click('刷新')
    expect(container.textContent).toContain('团队登录已失效')
    expect(container.textContent).toContain('尚未连接团队账号')
    expect(container.textContent).not.toContain('成员预约记录')
    expect(container.textContent).not.toContain('成员专用资源')
    expect(container.textContent).not.toContain('团队资源')
    const count=vi.mocked(teamApi.data).mock.calls.length
    await click('刷新')
    expect(teamApi.data).toHaveBeenCalledTimes(count)
  })
  it('does not restore a late resource response after logout',async()=>{
    vi.mocked(teamApi.status).mockResolvedValue(member)
    vi.mocked(teamApi.data).mockResolvedValue(privateData)
    await mount()
    let finishData!: (value:TeamData)=>void
    vi.mocked(teamApi.data).mockImplementationOnce(()=>new Promise(resolve=>{finishData=resolve}))
    vi.spyOn(teamApi,'logout').mockImplementation(async()=>{vi.mocked(teamApi.status).mockResolvedValue(anonymous)})
    await click('刷新')
    await click('退出账号')
    expect(container.textContent).not.toContain('成员预约记录')
    await act(async()=>finishData(privateData))
    expect(container.textContent).toContain('尚未连接团队账号')
    expect(container.textContent).not.toContain('成员专用资源')
    expect(container.textContent).not.toContain('成员预约记录')
    expect(container.textContent).not.toContain('团队资源')
  })
})
