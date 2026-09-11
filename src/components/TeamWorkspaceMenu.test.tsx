// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TeamWorkspaceMenu } from './TeamWorkspaceMenu'
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let root: ReturnType<typeof createRoot>
afterEach(() => {act(()=>root?.unmount()); document.body.innerHTML=''; vi.restoreAllMocks()})
async function mount() {
  const container=document.createElement('div'); document.body.append(container);root=createRoot(container)
  const open=vi.fn()
  await act(async()=>root.render(<TeamWorkspaceMenu onOpen={open}/>))
  return {container,open}
}
describe('team workspace sidebar',()=>{
  it('opens by mouse hover, exposes the five exact destinations, and closes outside',async()=>{
    const {container,open}=await mount()
    const group=container.firstElementChild!
    await act(async()=>group.dispatchEvent(new MouseEvent('mouseover',{bubbles:true})))
    expect(container.querySelector('nav')?.textContent).toBe('设备管理服务器资源周报与绩效算力预约设备申请与领取')
    for (const [label,path] of [['设备管理','/equipment'],['服务器资源','/servers'],['周报与绩效','/reports'],['算力预约','/'],['设备申请与领取','/requests']]) {
      await act(async()=>container.querySelector<HTMLButtonElement>('[aria-label="展开团队工作台"]')!.click())
      const item=[...container.querySelectorAll<HTMLButtonElement>('nav button')].find(button=>button.textContent===label)!
      await act(async()=>item.click())
      expect(open).toHaveBeenLastCalledWith(path)
    }
    await act(async()=>container.querySelector<HTMLButtonElement>('[aria-label="展开团队工作台"]')!.click())
    await act(async()=>document.body.dispatchEvent(new Event('pointerdown',{bubbles:true})))
    expect(container.querySelector('nav')).toBeNull()
  })
  it('opens on focus, supports keyboard selection and Escape, and sends primary activation to the home page',async()=>{
    vi.spyOn(window,'requestAnimationFrame').mockImplementation(callback=>{callback(0);return 0})
    const {container,open}=await mount()
    const trigger=container.querySelector<HTMLButtonElement>('.team-workspace-menu__trigger button')!
    await act(async()=>trigger.focus())
    expect(container.querySelector('nav')).not.toBeNull()
    await act(async()=>trigger.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true})))
    expect(document.activeElement?.textContent).toBe('设备管理')
    await act(async()=>document.activeElement!.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowUp',bubbles:true})))
    expect(document.activeElement?.textContent).toBe('设备申请与领取')
    await act(async()=>document.activeElement!.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})))
    expect(document.activeElement).toBe(trigger)
    expect(container.querySelector('nav')).toBeNull()
    await act(async()=>trigger.click())
    expect(open).toHaveBeenLastCalledWith('/')
  })
})
