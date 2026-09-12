import { useEffect, useRef, useState } from 'react'
import { Building2, CalendarDays, ChevronRight, ClipboardList, HardDrive, Server } from 'lucide-react'

const links = [
  { path: '/equipment', label: '资产设备管理', icon: HardDrive },
  { path: '/servers', label: '服务器资源', icon: Server },
  { path: '/', label: '算力预约', icon: CalendarDays },
  { path: '/requests', label: '办公设备申请', icon: ClipboardList },
] as const

export function TeamWorkspaceMenu({ onOpen }: { onOpen: (path: typeof links[number]['path']) => void }) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const items = useRef<Array<HTMLButtonElement | null>>([])
  useEffect(() => {
    if (!open) return
    const close = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false) }
    document.addEventListener('pointerdown', close)
    return () => document.removeEventListener('pointerdown', close)
  }, [open])
  return <div className="team-workspace-menu" ref={root} onMouseEnter={() => setOpen(true)} onMouseLeave={() => { if (!root.current?.contains(document.activeElement)) setOpen(false) }} onFocusCapture={() => setOpen(true)} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false) }} onKeyDown={event => {
    if (event.key === 'Escape') { event.preventDefault(); trigger.current?.focus(); setOpen(false) }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault(); setOpen(true)
      const direction = event.key === 'ArrowDown' ? 1 : -1
      const current = items.current.findIndex(item => item === document.activeElement)
      const next = current < 0 ? direction > 0 ? 0 : links.length - 1 : (current + direction + links.length) % links.length
      window.requestAnimationFrame(() => items.current[next]?.focus())
    }
  }}>
    <div className="team-workspace-menu__trigger"><button type="button" ref={trigger} aria-expanded={open} aria-controls="team-workspace-links" onClick={() => { setOpen(true); onOpen('/') }}><Building2 size={16}/><span>团队工作台</span></button><button type="button" className="team-workspace-menu__expand" aria-label="展开团队工作台" aria-expanded={open} aria-controls="team-workspace-links" onClick={() => setOpen(true)}><ChevronRight size={14}/></button></div>
    {open && <div className="team-workspace-menu__flyout"><nav id="team-workspace-links" aria-label="团队工作台页面">{links.map(({ path, label, icon: Icon }, index) => <button type="button" key={path} ref={element => { items.current[index] = element }} onClick={() => { onOpen(path); setOpen(false) }}><Icon size={16}/>{label}</button>)}</nav></div>}
  </div>
}
