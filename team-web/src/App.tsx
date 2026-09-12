import { Brand } from './Brand'
import { useEffect, useRef, useState } from 'react'
import { Download, LoaderCircle, RefreshCw, Settings } from 'lucide-react'
import { api, acceptSession, ACCOUNT_CHANGED_EVENT, SESSION_EXPIRED_EVENT } from './api'
import { AuthDialog } from './AuthDialog'
import { errorText } from './errors'
import { usePreferences } from './preferences'
import { SettingsDialog } from './SettingsDialog'
import { Workspace } from './Workspace'
import { EquipmentWorkspace } from './EquipmentWorkspace'
import { MembersWorkspace } from './MembersWorkspace'
import { WorkModuleFrame } from './WorkModuleFrame'
import { ServersWorkspace } from './ServersWorkspace'
import { RequestWorkspace } from './RequestWorkspace'
import { PendingMembership } from './PendingMembership'
import type { Session } from './types'

export default function App() {
  const state = usePreferences()
  const { t } = state
  const [session, setSession] = useState<Session | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [showSettings, setShowSettings] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [pathname, setPathname] = useState(window.location.pathname)
  function navigate(path: string) { window.history.pushState({}, '', path); setPathname(window.location.pathname) }
  useEffect(() => { const onPopState = () => setPathname(window.location.pathname); window.addEventListener('popstate', onPopState); return () => window.removeEventListener('popstate', onPopState) }, [])
  // Read without mutation in the initializer (React StrictMode runs it twice).
  const [bootstrapToken, setBootstrapToken] = useState(() => new URLSearchParams(window.location.hash.slice(1)).get('setup') || undefined)
  const generation = useRef(0)
  async function load(gate = false) {
    const request = ++generation.current
    setError(null); setRefreshing(true)
    try { const value = await api.session(); if (request === generation.current) { const accepted = gate ? { ...value, user: null } : value; acceptSession(accepted); setSession(accepted) } } catch (reason) { if (request === generation.current) setError(reason) }
    finally { if (request === generation.current) setRefreshing(false) }
  }
  function sessionExpired() { setShowSettings(false); setSession(null); void load(true) }
  function accountChanged() { setShowSettings(false); setSession(null); void load() }
  function signedIn(value: Session) { generation.current++; acceptSession(value); setError(null); setRefreshing(false); setSession(value); if (value.user) setBootstrapToken(undefined) }
  async function logout() {
    const previous = session
    generation.current++; setSession(null); setError(null)
    try { await api.logout(); await load(true) } catch (reason) {
      try { const value = await api.session(); setSession({ ...value, user: null }) } catch { if (previous) setSession({ ...previous, user: null, csrfToken: null }) }
      setError(reason)
    }
  }
  useEffect(() => {
    window.addEventListener(SESSION_EXPIRED_EVENT, sessionExpired); window.addEventListener(ACCOUNT_CHANGED_EVENT, accountChanged)
    return () => { window.removeEventListener(SESSION_EXPIRED_EVENT, sessionExpired); window.removeEventListener(ACCOUNT_CHANGED_EVENT, accountChanged) }
  }, [])
  useEffect(() => {
    if (new URLSearchParams(window.location.hash.slice(1)).has('setup')) window.history.replaceState(window.history.state, '', `${window.location.pathname}${window.location.search}`)
    void load()
  }, [])
  const pendingCompany = Boolean(session?.authMode === 'account' && session.user && !session.user.isSuperAdmin && !session.user.company)
  useEffect(() => {
    if (!session?.user) return
    const refresh = () => { if (document.visibilityState !== 'hidden') void load() }
    const interval = window.setInterval(refresh, 30_000)
    window.addEventListener('focus', refresh)
    return () => { window.clearInterval(interval); window.removeEventListener('focus', refresh) }
  }, [Boolean(session?.user)])
  const scopeKey = `${session?.user?.id || ''}:${session?.user?.company || ''}:${Boolean(session?.user?.isSuperAdmin)}`
  if (pendingCompany && session) return <PendingMembership session={session} state={state} error={error} refreshing={refreshing} onRefresh={() => void load()} onLogout={logout} onSessionChanged={signedIn}/>
  if (session?.user && /^\/servers\/?$/.test(pathname)) return <ServersWorkspace key={scopeKey} session={session} state={state} navigate={navigate} onLogout={logout} onSessionChanged={signedIn} onSessionExpired={sessionExpired}/>
  if (session?.user && /^\/reports(?:\/|$)/.test(pathname)) return <WorkModuleFrame key={scopeKey} session={session} state={state} navigate={navigate} onLogout={logout} onSessionChanged={signedIn} onSessionExpired={sessionExpired} title={t('周报功能已移除', 'Weekly reports have been removed')} subtitle={t('历史周报资料继续保留。', 'Historical reports remain stored.')}><button className="primary" onClick={() => navigate('/')}>{t('返回资源看板', 'Return to resource board')}</button></WorkModuleFrame>
  if (session?.user && /^\/requests\/?$/.test(pathname)) return <RequestWorkspace key={scopeKey} session={session} state={state} navigate={navigate} onLogout={logout} onSessionChanged={signedIn} onSessionExpired={sessionExpired}/>
  if (session?.user?.isSuperAdmin && /^\/members\/?$/.test(pathname)) return <MembersWorkspace key={scopeKey} session={session} state={state} navigate={navigate} onLogout={logout} onSessionChanged={signedIn} onSessionExpired={sessionExpired}/>
  if (session?.user && /^\/equipment(?:\/|$)/.test(pathname)) {
    let id = pathname.replace(/^\/equipment\/?/, '').replace(/\/$/, '') || undefined
    try { if (id) id = decodeURIComponent(id) } catch { /* The API reports malformed device links as not found. */ }
    return <EquipmentWorkspace key={scopeKey} id={id} session={session} state={state} navigate={navigate} bootstrapToken={bootstrapToken} onSessionChanged={signedIn} onSessionExpired={sessionExpired} onLogout={logout} />
  }
  if (session?.user) return <Workspace key={scopeKey} onNavigateEquipment={() => navigate('/equipment')} onNavigateServers={() => navigate('/servers')} onNavigateMembers={() => navigate('/members')} session={session} state={state} bootstrapToken={bootstrapToken} onSessionChanged={signedIn} onSessionExpired={sessionExpired} onLogout={logout} />
  return <><main className="login-shell member-login-shell" inert={showSettings}><button className="login-settings icon-button" aria-label={t('设置', 'Settings')} onClick={() => setShowSettings(true)}><Settings size={19} /></button><div className="member-login"><Brand t={t} />{Boolean(error) && <div className="error" role="alert">{errorText(error, t)}<button onClick={() => void load(true)}><RefreshCw size={15} />{t('重试', 'Retry')}</button></div>}{session ? <AuthDialog embedded session={session} bootstrapToken={bootstrapToken} t={t} onClose={() => {}} onSignedIn={signedIn} /> : !error && <p role="status" className="loading-inline"><LoaderCircle size={18} />{t('正在连接服务…', 'Connecting to the service…')}</p>}<div className="login-download"><a className="button" href="/downloads/"><Download size={16} aria-hidden="true" />{t('下载 RackTop', 'Download RackTop')}</a><p>{t('Linux 和 macOS 安装包与安装说明。', 'Linux and macOS installers and installation guides.')}</p></div></div></main>{showSettings && <SettingsDialog state={state} session={session} onClose={() => setShowSettings(false)} />}</>
}
