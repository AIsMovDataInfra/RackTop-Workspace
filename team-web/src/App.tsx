import { useEffect, useState } from 'react'
import { Activity, LoaderCircle, RefreshCw, Settings } from 'lucide-react'
import { api } from './api'
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
  async function load() {
    setError(null)
    try { setSession(await api.session()) } catch (reason) { setError(reason) }
  }
  useEffect(() => {
    if (new URLSearchParams(window.location.hash.slice(1)).has('setup')) window.history.replaceState(window.history.state, '', `${window.location.pathname}${window.location.search}`)
    void load()
  }, [])
  if (session && /^\/equipment(?:\/|$)/.test(pathname)) {
    let id = pathname.replace(/^\/equipment\/?/, '').replace(/\/$/, '') || undefined
    try { if (id) id = decodeURIComponent(id) } catch { /* The API reports malformed device links as not found. */ }
    return <EquipmentWorkspace id={id} session={session} state={state} navigate={navigate} bootstrapToken={bootstrapToken} onSessionChanged={(value) => { setSession(value); if (value.user) setBootstrapToken(undefined) }} onSessionExpired={() => void load()} onLogout={async () => { await api.logout(); await load() }} />
  }
  if (session) return <Workspace onNavigateEquipment={() => navigate('/equipment')} session={session} state={state} bootstrapToken={bootstrapToken} onSessionChanged={(value) => { setSession(value); if (value.user) setBootstrapToken(undefined) }} onSessionExpired={() => void load()} onLogout={async () => { await api.logout(); await load() }} />
  return <><main className="login-shell" inert={showSettings}><button className="login-settings icon-button" aria-label={t('设置', 'Settings')} onClick={() => setShowSettings(true)}><Settings size={19} /></button><div className="login-card"><div className="brand"><span><Activity size={24} /></span><div><strong>RackTop</strong><small>{t('团队资源预约', 'Team reservations')}</small></div></div><h1>{t('团队资源预约', 'Team reservations')}</h1><p>{t('查看团队排期，预约整机或指定 GPU。', 'View the team schedule and book a server or individual GPUs.')}</p>{error ? <div className="error" role="alert">{errorText(error, t)}<button onClick={() => void load()}><RefreshCw size={15} />{t('重试', 'Retry')}</button></div> : <p role="status" className="loading-inline"><LoaderCircle size={18} />{t('正在连接服务…', 'Connecting to the service…')}</p>}</div></main>{showSettings && <SettingsDialog state={state} session={session} onClose={() => setShowSettings(false)} />}</>
}
