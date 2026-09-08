import { useEffect, useId, useRef, type ReactNode } from 'react'
import { X } from 'lucide-react'
import type { Translate } from './types'

export function Dialog({ title, subtitle, children, onClose, busy = false, t, compact = false }: { title: string; subtitle?: string; children: ReactNode; onClose: () => void; busy?: boolean; t: Translate; compact?: boolean }) {
  const ref = useRef<HTMLElement>(null)
  const closeRef = useRef(onClose), busyRef = useRef(busy)
  closeRef.current = onClose; busyRef.current = busy
  const id = useId()
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    const dialog = ref.current!
    const firstInput = dialog.querySelector<HTMLElement>('input:not(:disabled), textarea:not(:disabled), select:not(:disabled)')
    ;(firstInput || dialog.querySelector<HTMLButtonElement>('button'))?.focus()
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); if (!busyRef.current) closeRef.current(); return }
      if (event.key !== 'Tab') return
      const elements = [...dialog.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex="0"]')].filter((element) => element.tabIndex >= 0)
      const first = elements[0], last = elements.at(-1)
      if (!first) { event.preventDefault(); dialog.focus(); return }
      if (event.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) { event.preventDefault(); last?.focus() }
      else if (!event.shiftKey && (document.activeElement === last || !dialog.contains(document.activeElement))) { event.preventDefault(); first.focus() }
    }
    document.addEventListener('keydown', onKeyDown, true)
    const beforeOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.removeEventListener('keydown', onKeyDown, true); document.body.style.overflow = beforeOverflow; if (previous?.isConnected) previous.focus() }
  }, [])
  return <div className="dialog-scrim" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose() }}><section className={`dialog${compact ? ' dialog--compact' : ''}`} ref={ref} role="dialog" aria-modal="true" aria-labelledby={id} tabIndex={-1}><header><div><h2 id={id}>{title}</h2>{subtitle && <p>{subtitle}</p>}</div><button type="button" className="icon-button" aria-label={t('关闭弹窗', 'Close dialog')} disabled={busy} onClick={onClose}><X size={19} /></button></header>{children}</section></div>
}
