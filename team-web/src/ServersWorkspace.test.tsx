import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { api, ApiError } from './api'
import { ServersWorkspace } from './ServersWorkspace'
import type { ManagedServer, Session } from './types'
import type { PreferencesState } from './preferences'
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const server: ManagedServer = { id:'server-fixture',company:'西浦',name:'测试服务器',host:'server.example.test',port:22,username:'researcher',jump:null,enabled:true,version:3,updatedAt:'2026-09-11T10:00:00Z',memberIds:['member-1'] }
const session: Session = { user:{id:'admin',name:'管理员',username:'admin',role:'admin',company:null,isSuperAdmin:true,companies:[]},csrfToken:'fixture',authMode:'account',feishuConfigured:false,notifications:{configured:false},timezone:'Asia/Shanghai' }
const state: PreferencesState = {t:zh=>zh,preferences:{locale:'zh-CN',theme:'light',largeText:false},setPreferences:vi.fn()}
let container: HTMLDivElement, root: ReturnType<typeof createRoot>
const expired = vi.fn()
async function mount(user = session.user!) { await act(async()=>root.render(<ServersWorkspace session={{...session,user}} state={state} navigate={vi.fn()} onLogout={vi.fn()} onSessionChanged={vi.fn()} onSessionExpired={expired}/>)) }
async function click(label: string) { const button = [...container.querySelectorAll('button')].find(item=>item.textContent === label)!; expect(button,label).toBeDefined(); await act(async()=>button.click()) }
async function submit() { await act(async()=>container.querySelector('form')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}))) }
beforeEach(()=>{
  container=document.createElement('div');document.body.append(container);root=createRoot(container);expired.mockClear()
  vi.spyOn(api,'servers').mockResolvedValue({schemaVersion:1,revision:'fixture',servers:[server]})
  vi.spyOn(api,'serverMembers').mockResolvedValue({members:[{id:'member-1',name:'已授权成员',username:'member-1'},{id:'member-2',name:'另一成员',username:'member-2'}]})
})
afterEach(()=>{act(()=>root.unmount());container.remove();vi.restoreAllMocks()})
it('shows only member actions and clears metadata when the session expires',async()=>{
  await mount({id:'member-1',name:'成员',role:'member',company:'西浦',companies:['西浦'],isSuperAdmin:false})
  expect(container.textContent).toContain('researcher@server.example.test:22')
  expect(container.textContent).not.toContain('添加服务器')
  expect(container.textContent).not.toContain('导入 SSH 配置')
  expect(container.textContent).not.toContain('编辑')
  expect(container.querySelector('input[type=password]')).toBeNull()
  vi.mocked(api.servers).mockRejectedValue(new ApiError('登录已失效',401,'EXPIRED'))
  await click('刷新')
  expect(expired).toHaveBeenCalledOnce()
  expect(container.textContent).not.toContain('server.example.test')
})
it('offers SSH import to super administrators and closes its preview when their role changes', async () => {
  await mount(); await click('添加服务器'); await click('从 SSH 配置文件导入')
  expect(container.querySelector('[role=dialog]')?.textContent).toContain('SSH 配置文件')
  expect(container.querySelector('input[type=file]')).not.toBeNull()
  await mount({ ...session.user!, isSuperAdmin: false, company: 'A公司', companies: ['A公司'] })
  expect(container.querySelector('[role=dialog]')).toBeNull()
  expect(container.textContent).not.toContain('导入 SSH 配置')
  expect(container.textContent).toContain('添加服务器')
})
it('updates explicit grants without changing connection details or resubmitting a version conflict',async()=>{
  const grant=vi.spyOn(api,'grantServer').mockRejectedValue(new ApiError('服务器已被更新',409,'VERSION_CONFLICT'))
  const update=vi.spyOn(api,'updateServer')
  await mount();await click('授权')
  expect(container.querySelector('[role=dialog]')?.textContent).toContain('已授权成员')
  const checkboxes=[...container.querySelectorAll<HTMLInputElement>('[role=dialog] input[type=checkbox]')]
  expect(checkboxes.map(item=>item.checked)).toEqual([true,false])
  await act(async()=>checkboxes[0].click());await act(async()=>checkboxes[1].click())
  await submit()
  expect(grant).toHaveBeenCalledExactlyOnceWith(server.id,3,['member-2'])
  expect(update).not.toHaveBeenCalled()
  expect(container.querySelector('[role=alert]')?.textContent).toContain('已被更新')
  expect(checkboxes.map(item=>item.checked)).toEqual([false,true])
  await click('关闭并读取最新配置')
  expect(container.querySelector('[role=dialog]')).toBeNull()
  expect(grant).toHaveBeenCalledTimes(1)
})
it('does not let a failed member-directory load silently clear existing grants',async()=>{
  const grant=vi.spyOn(api,'grantServer')
  vi.mocked(api.serverMembers).mockRejectedValue(new Error('成员读取失败'))
  await mount();await click('授权')
  expect(container.querySelector('[role=dialog]')?.textContent).toContain('成员读取失败')
  expect(container.querySelector<HTMLButtonElement>('button[type=submit]')!.disabled).toBe(true)
  await submit()
  expect(grant).not.toHaveBeenCalled()
})
it('drops the administrator editor and old directory when role or organization changes',async()=>{
  await mount();await click('编辑')
  expect(container.querySelector('[role=dialog]')).not.toBeNull()
  vi.mocked(api.servers).mockResolvedValue({schemaVersion:1,revision:'empty',servers:[]})
  await mount({...session.user!,role:'member',isSuperAdmin:false,company:'A公司',companies:['A公司']})
  expect(container.querySelector('[role=dialog]')).toBeNull()
  expect(container.textContent).not.toContain('server.example.test')
  expect(container.textContent).toContain('暂无可访问的服务器')
})
