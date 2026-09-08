// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { TeamWorkspace } from './TeamWorkspace'
import { teamApi, type TeamStatus } from '../services/team'
import { openExternalUrl } from '../services/external'
import type { Server } from '../types/models'
vi.mock('../services/external', () => ({ openExternalUrl: vi.fn() }))
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const server: Server = { id: 'local-a', name: 'A100', host: 'secret-host.invalid', port: 2222, username: 'secret-ssh-user', identityFile: '/secret/key', authMethod: 'sshAgent', status: 'online', tags: [], samplingIntervalSeconds: 2, historyRetentionDays: 90, remoteHistoryEnabled: false }
const anonymous: TeamStatus = { url:'https://136.0.110.161',authenticated:false,user:null,bindings:{} }
const admin: TeamStatus = { ...anonymous,authenticated:true,user:{id:'admin',name:'管理员',username:'owner',role:'admin'} }
let root: ReturnType<typeof createRoot>, container: HTMLDivElement
const click = async (text:string) => { const button=[...container.querySelectorAll('button')].find(b=>b.textContent?.includes(text));expect(button).toBeTruthy();await act(async()=>button!.click()) }
const mount = async () => { await act(async()=>root.render(<TeamWorkspace servers={[server]} snapshots={{}}/>)) }
beforeEach(()=>{
  container=document.createElement('div');document.body.append(container);root=createRoot(container)
  vi.spyOn(teamApi,'status').mockResolvedValue(anonymous)
  vi.spyOn(teamApi,'data').mockResolvedValue({resources:[],reservations:[]})
})
afterEach(()=>{act(()=>root.unmount());container.remove();vi.restoreAllMocks()})
describe('team workspace',()=>{
  it('allows public schedule access without exposing local SSH details or publishing controls',async()=>{
    await mount()
    expect(container.textContent).toContain('查看排期无需登录')
    expect([...container.querySelectorAll('h2')].some(h=>h.textContent==='同步本机资源')).toBe(false)
    expect(container.textContent).not.toContain(server.host)
    expect(container.textContent).not.toContain(server.username)
    expect(container.textContent).not.toContain(server.identityFile)
    await click('打开预约网页')
    expect(openExternalUrl).toHaveBeenCalledWith('https://136.0.110.161/')
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
    vi.mocked(teamApi.data).mockResolvedValue({resources:[{id:'resource-123',name:'A100',cluster:'团队',gpuModel:'A100',gpuCount:8,status:'unknown',lastSeenAt:null,inventoryState:'synced',enabled:true}],reservations:[]})
    await mount();await click('查看与预约')
    expect(openExternalUrl).toHaveBeenCalledWith('https://136.0.110.161/?resource=resource-123')
    expect(container.textContent).toContain('状态未知')
  })
  it('logs in with Chinese or long ordinary usernames and a short password without browser constraints',async()=>{
    const login=vi.spyOn(teamApi,'login').mockResolvedValue(anonymous)
    await mount()
    for (const username of ['中',' A.+ @ 中文 ! '.repeat(40)]) {
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
    }
  })
  it('allows logout while synchronization is waiting and updates local state even if revocation fails',async()=>{
    vi.mocked(teamApi.status).mockResolvedValue(admin)
    let finishSync!: (value:TeamStatus)=>void
    vi.spyOn(teamApi,'select').mockImplementation(()=>new Promise(resolve=>{finishSync=resolve}))
    const logout=vi.spyOn(teamApi,'logout').mockImplementation(async()=>{vi.mocked(teamApi.status).mockResolvedValue(anonymous);throw new Error('已退出本机，远端撤销暂时无法确认')})
    await mount();await click('立即同步')
    const button=[...container.querySelectorAll('button')].find(b=>b.textContent?.includes('退出账号'))!
    expect(button.disabled).toBe(false)
    await click('退出账号');expect(logout).toHaveBeenCalledOnce()
    expect(container.textContent).toContain('尚未连接团队账号')
    expect(container.textContent).toContain('远端撤销暂时无法确认')
    await act(async()=>finishSync(anonymous))
  })
})
