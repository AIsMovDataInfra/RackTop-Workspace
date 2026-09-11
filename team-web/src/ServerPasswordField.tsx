import { useId, useState } from 'react'
import { Eye, EyeOff } from 'lucide-react'
import type { Translate } from './types'

type Props = {
  label: string; configured: boolean; value: string | null | undefined
  disabled: boolean; onChange: (value: string | null | undefined) => void; t: Translate
}

export function ServerPasswordField({ label, configured, value, disabled, onChange, t }: Props) {
  const id = useId()
  const [visible, setVisible] = useState(false)
  return <div className="server-password-field">
    <label htmlFor={id}>{label}</label>
    <div className="server-password-input">
      <input id={id} type={visible ? 'text' : 'password'} autoComplete="new-password" spellCheck={false}
        value={value ?? ''} disabled={disabled || value === null} maxLength={4096}
        placeholder={configured ? t('留空保留已保存的密码', 'Leave blank to keep the saved password') : t('可选，由获授权成员使用', 'Optional, shared with authorized members')}
        onChange={event => onChange(event.target.value === '' ? undefined : event.target.value)}/>
      <button type="button" disabled={disabled || value === null} aria-label={(visible ? t('隐藏', 'Hide ') : t('显示', 'Show ')) + label}
        aria-pressed={visible} onClick={() => setVisible(previous => !previous)}>{visible ? <EyeOff size={16}/> : <Eye size={16}/>}</button>
    </div>
    {configured && <label className="server-check"><input type="checkbox" checked={value === null} disabled={disabled}
      onChange={event => { setVisible(false); onChange(event.target.checked ? null : undefined) }}/>{t('清除已保存的共享密码', 'Remove the saved shared password')}</label>}
  </div>
}
