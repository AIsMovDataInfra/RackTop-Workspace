import { useEffect, useRef, useState } from 'react'
import { Activity, LoaderCircle, RefreshCw, Settings } from 'lucide-react'
import { api, SESSION_EXPIRED_EVENT } from './api'
import { AuthDialog } from './AuthDialog'
import { errorText } from './errors'
import { usePreferences } from './preferences'
import { SettingsDialog } from './SettingsDialog'
import { Workspace } from './Workspace'
import { EquipmentWorkspace } from './EquipmentWorkspace'
import type { Session } from './types'

export default function App() {
  const state = usePreferences()
  const { t } = state
  const [session, setSession] = useState<Session | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [showSettings, setShowSettings] = useState(false)
  const [pathname, setPathname] = useState(window.location.pathname)
  function navigate(path: string) { window.history.pushState({}, '', path); setPathname(window.location.pathname) }
  useEffect(() => { const onPopState = () => setPathname(window.location.pathname); window.addEventListener('popstate', onPopState); return () => window.removeEventListener('popstate', onPopState) }, [])
  // Read without mutation in the initializer (React StrictMode runs it twice).
  const [bootstrapToken, setBootstrapToken] = useState(() => new URLSearchParams(window.location.hash.slice(1)).get('setup') || undefined)
  const generation = useRef(0)
  async function load(gate = false) {
    const request = ++generation.current
    setError(null)
    try { const value = await api.session(); if (request === generation.current) setSession(gate ? { ...value, user: null } : value) } catch (reason) { if (request === generation.current) setError(reason) }
  }
  function sessionExpired() { setSession(null); void load(true) }
  function signedIn(value: Session) { generation.current++; setError(null); setSession(value); if (value.user) setBootstrapToken(undefined) }
  async function logout() {
    const previous = session
    generation.current++; setSession(null); setError(null)
    try { await api.logout(); await load(true) } catch (reason) {
      try { const value = await api.session(); setSession({ ...value, user: null }) } catch { if (previous) setSession({ ...previous, user: null, csrfToken: null }) }
      setError(reason)
    }
  }
  useEffect(() => { window.addEventListener(SESSION_EXPIRED_EVENT, sessionExpired); return () => window.removeEventListener(SESSION_EXPIRED_EVENT, sessionExpired) }, [])
  useEffect(() => {
    if (new URLSearchParams(window.location.hash.slice(1)).has('setup')) window.history.replaceState(window.history.state, '', `${window.location.pathname}${window.location.search}`)
    void load()
  }, [])
  if (session?.user && /^\/equipment(?:\/|$)/.test(pathname)) {
    let id = pathname.replace(/^\/equipment\/?/, '').replace(/\/$/, '') || undefined
    try { if (id) id = decodeURIComponent(id) } catch { /* The API reports malformed device links as not found. */ }
    return <EquipmentWorkspace id={id} session={session} state={state} navigate={navigate} bootstrapToken={bootstrapToken} onSessionChanged={signedIn} onSessionExpired={sessionExpired} onLogout={logout} />
  }
  if (session?.user) return <Workspace onNavigateEquipment={() => navigate('/equipment')} session={session} state={state} bootstrapToken={bootstrapToken} onSessionChanged={signedIn} onSessionExpired={sessionExpired} onLogout={logout} />
  return <><main className="login-shell member-login-shell" inert={showSettings}><button className="login-settings icon-button" aria-label={t('设置', 'Settings')} onClick={() => setShowSettings(true)}><Settings size={19} /></button><div className="member-login"><div className="brand"><span><Activity size={24} /></span><div><strong>RackTop</strong><small>{t('团队工作台', 'Team workspace')}</small></div></div>{Boolean(error) && <div className="error" role="alert">{errorText(error, t)}<button onClick={() => void load(true)}><RefreshCw size={15} />{t('重试', 'Retry')}</button></div>}{session ? <AuthDialog embedded session={session} bootstrapToken={bootstrapToken} t={t} onClose={() => {}} onSignedIn={signedIn} /> : !error && <p role="status" className="loading-inline"><LoaderCircle size={18} />{t('正在连接服务…', 'Connecting to the service…')}</p>}</div></main>{showSettings && <SettingsDialog state={state} session={session} onClose={() => setShowSettings(false)} />}</>
}
