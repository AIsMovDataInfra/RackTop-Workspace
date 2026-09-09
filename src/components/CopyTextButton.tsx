import { useLayoutEffect, useRef, useState } from 'react'
import { Check, Copy } from 'lucide-react'

type CopyState = 'idle' | 'copied' | 'error'

export function CopyTextButton({ text, label, ariaLabel = label, disabled = false, className = '' }: { text: string; label: string; ariaLabel?: string; disabled?: boolean; className?: string }) {
  const [feedback, setFeedback] = useState<{ text: string; state: CopyState }>({ text, state: 'idle' })
  const latestText = useRef(text)
  const latestAttempt = useRef(0)
  useLayoutEffect(() => {
    latestText.current = text
    latestAttempt.current += 1
  }, [text])
  const state = feedback.text === text ? feedback.state : 'idle'

  const copy = async () => {
    const attempt = ++latestAttempt.current
    const copiedText = text
    try {
      if (!navigator.clipboard?.writeText) throw new Error('clipboard unavailable')
      await navigator.clipboard.writeText(copiedText)
      if (latestAttempt.current === attempt && latestText.current === copiedText) setFeedback({ text: copiedText, state: 'copied' })
    } catch {
      if (latestAttempt.current === attempt && latestText.current === copiedText) setFeedback({ text: copiedText, state: 'error' })
    }
  }

  const buttonLabel = state === 'copied' ? '已复制' : state === 'error' ? '复制失败' : label
  return <span className={`copy-text-action ${className}`.trim()}>
    <button
      type="button"
      className="button button--secondary button--small copy-text-action__button"
      disabled={disabled || !text}
      aria-label={state === 'copied' ? `再次${ariaLabel}` : ariaLabel}
      onClick={() => void copy()}
    >
      {state === 'copied' ? <Check size={13} aria-hidden="true" /> : <Copy size={13} aria-hidden="true" />}
      {buttonLabel}
    </button>
    {state !== 'idle' && <span className="copy-text-action__status" role={state === 'error' ? 'alert' : 'status'} aria-live={state === 'error' ? 'assertive' : 'polite'}>
      {state === 'copied' ? `${ariaLabel}成功` : '无法访问剪贴板，请选择文字后按 Ctrl 或 Command 加 C 复制。'}
    </span>}
  </span>
}
