import { useState, type ReactNode } from 'react'
import { ArrowRight, ShieldCheck } from 'lucide-react'
import { api, ApiError } from './api'
import { Dialog } from './Dialog'
import { errorText } from './errors'
import { reservationIdFromSearch } from './time'
import type { Session, Translate } from './types'

export function AuthDialog({ session, bootstrapToken, onClose, onSignedIn, t, embedded = false }: { session: Session; bootstrapToken?: string; onClose: () => void; onSignedIn: (session: Session) => void; t: Translate; embedded?: boolean }) {
  const [register, setRegister] = useState(Boolean(bootstrapToken))
  const [username, setUsername] = useState('')
  const [rememberMe, setRememberMe] = useState(true)
  const [name, setName] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const deepLinkId = reservationIdFromSearch(window.location.search)
  const signInHref = `/api/auth/feishu/start${deepLinkId ? `?reservation=${encodeURIComponent(deepLinkId)}` : ''}`
  const title = bootstrapToken && register ? t('创建管理员账号', 'Create administrator account') : register ? t('注册账号', 'Create an account') : t('登录', 'Sign in')
  async function submit(event: React.FormEvent) {
    event.preventDefault()
    if (busy) return
    setError(null)
    if (!username.trim()) { setError(new Error(t('请输入用户名', 'Enter a username'))); return }
    if (!password || (register && !password.trim())) { setError(new Error(t('请输入密码', 'Enter a password'))); return }
    setBusy(true)
    try {
      const result = register ? await api.register({ username: username.trim(), name: name.trim(), password, ...(bootstrapToken ? { bootstrapToken } : {}) }) : await api.login({ username: username.trim(), password, rememberMe })
      setPassword(''); onSignedIn(result)
    } catch (reason) { setError(reason) } finally { setBusy(false) }
  }
  const message = error instanceof ApiError && error.status === 401 ? t('用户名或密码不正确，请重新输入。', 'The username or password is incorrect. Please try again.') : errorText(error, t)
  return <AuthFrame embedded={embedded} title={title} subtitle={t('登录后查看团队设备、照片和排期。', 'Sign in to view team equipment, photos and schedules.')} onClose={onClose} busy={busy} t={t}>
    {session.authMode === 'account' ? <form onSubmit={(event) => void submit(event)}>
      <div className="dialog-body">
        {!bootstrapToken && <div className="segmented auth-tabs" aria-label={t('登录或注册', 'Sign in or register')}><button type="button" disabled={busy} className={!register ? 'is-active' : ''} aria-pressed={!register} onClick={() => { setRegister(false); setError(null); setPassword('') }}>{t('登录', 'Sign in')}</button><button type="button" disabled={busy} className={register ? 'is-active' : ''} aria-pressed={register} onClick={() => { setRegister(true); setError(null); setPassword('') }}>{t('注册账号', 'Register')}</button></div>}
        {bootstrapToken && <div className="callout"><ShieldCheck size={18} /><span>{t('使用此设置链接创建管理员账号。', 'Use this setup link to create the administrator account.')}</span></div>}
        <label>{t('用户名', 'Username')}<input name="username" type="text" autoComplete="username" autoCapitalize="none" spellCheck={false} required disabled={busy} value={username} onChange={(event) => setUsername(event.target.value)} /></label>
        {register && <label>{t('姓名', 'Name')}<input name="name" type="text" autoComplete="name" required minLength={1} maxLength={60} disabled={busy} value={name} onChange={(event) => setName(event.target.value)} /><span className="field-help">{t('预约中显示此姓名，注册后固定使用。', 'This is the name shown on your reservations. It stays fixed after registration.')}</span></label>}
        <label>{t('密码', 'Password')}<input name="password" type="password" autoComplete={register ? 'new-password' : 'current-password'} required disabled={busy} value={password} onChange={(event) => setPassword(event.target.value)} /></label>
        {Boolean(error) && <div className="error" role="alert">{message}</div>}
        {!register && <label className="checkbox-label"><input type="checkbox" checked={rememberMe} disabled={busy} onChange={(event) => setRememberMe(event.target.checked)} />{t('记住登录（30 天）', 'Remember me for 30 days')}</label>}<p className="field-help">{t('姓名将显示在设备登记和预约中。忘记密码时请联系管理员。', 'Your name appears on equipment records and reservations. Contact your administrator if you forget your password.')}</p>
      </div>
      <footer>{!embedded && <button type="button" disabled={busy} onClick={onClose}>{t('取消', 'Cancel')}</button>}<button className="primary" type="submit" disabled={busy}>{busy ? t('处理中…', 'Working…') : register ? t('创建账号并登录', 'Create account and sign in') : t('登录并继续', 'Sign in and continue')}<ArrowRight size={16} /></button></footer>
    </form> : <><div className="dialog-body">{session.authMode === 'demo' ? <><div className="callout"><ShieldCheck size={18} /><span>{t('本机演示环境。下列账号与预置资源均为示例数据。', 'Local demo. These accounts and resources are sample data.')}</span></div><div className="demo-users">{session.demoUsers?.map((user) => <button disabled={busy} key={user.id} onClick={async () => { setBusy(true); setError(null); try { onSignedIn(await api.demoLogin(user.id)) } catch (reason) { setError(reason) } finally { setBusy(false) } }}><span><strong>{user.name}</strong><small>{user.role === 'admin' ? t('管理员 · 演示', 'Administrator · Demo') : t('成员 · 演示', 'Member · Demo')}</small></span><ArrowRight size={16} /></button>)}</div></> : <><a className={`button primary${!session.feishuConfigured ? ' disabled' : ''}`} aria-disabled={!session.feishuConfigured} href={session.feishuConfigured ? signInHref : undefined}>{t('使用飞书登录', 'Sign in with Feishu')}<ArrowRight size={17} /></a>{!session.feishuConfigured && <p className="field-help">{t('飞书登录尚未配置，请联系部署管理员。', 'Feishu sign-in is not configured. Contact your administrator.')}</p>}</>}{Boolean(error) && <div className="error" role="alert">{errorText(error, t)}</div>}</div>{!embedded && <footer><button disabled={busy} onClick={onClose}>{t('取消', 'Cancel')}</button></footer>}</>}
  </AuthFrame>
}

function AuthFrame({ embedded, title, subtitle, onClose, busy, t, children }: { embedded: boolean; title: string; subtitle: string; onClose: () => void; busy: boolean; t: Translate; children: ReactNode }) {
  if (!embedded) return <Dialog compact title={title} subtitle={subtitle} onClose={onClose} busy={busy} t={t}>{children}</Dialog>
  return <section className="dialog login-auth" aria-label={title}><header><div><h2>{title}</h2><p>{subtitle}</p></div></header>{children}</section>
}
