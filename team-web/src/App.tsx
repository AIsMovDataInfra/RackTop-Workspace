import { useEffect, useState } from 'react'
import { Activity, ArrowRight, LoaderCircle, RefreshCw, Settings, ShieldCheck } from 'lucide-react'
import { api } from './api'
import { errorText } from './errors'
import { usePreferences } from './preferences'
import { SettingsDialog } from './SettingsDialog'
import { Workspace } from './Workspace'
import { reservationIdFromSearch } from './time'
import type { Session } from './types'

export default function App() {
  const state = usePreferences()
  const { t } = state
  const [session, setSession] = useState<Session | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const deepLinkId = reservationIdFromSearch(window.location.search)
  const signInHref = `/api/auth/feishu/start${deepLinkId ? `?reservation=${encodeURIComponent(deepLinkId)}` : ''}`
  async function load() {
    setLoading(true); setError(null)
    try { setSession(await api.session()) } catch (reason) { setError(reason) } finally { setLoading(false) }
  }
  useEffect(() => { void load() }, [])
  if (session?.user) return <Workspace key={session.user.id} session={session} state={state} onSessionExpired={() => { setSession(null); void load() }} onLogout={async () => { await api.logout(); setSession(null); await load() }} />
  return <><main className="login-shell" inert={showSettings}><button className="login-settings icon-button" aria-label={t('设置', 'Settings')} onClick={() => setShowSettings(true)}><Settings size={19} /></button><div className="login-card"><div className="brand"><span><Activity size={24} /></span><div><strong>RackTop</strong><small>{t('团队资源预约', 'Team reservations')}</small></div></div><h1>{t('团队资源预约', 'Reserve team resources')}</h1><p>{t('查看团队排期，预约整机或指定 GPU。', 'View the team schedule and book a server or individual GPUs.')}</p>{loading ? <p role="status" className="loading-inline"><LoaderCircle size={18} />{t('正在连接服务…', 'Connecting to the service…')}</p> : error ? <div className="error" role="alert">{errorText(error, t)}<button onClick={() => void load()}><RefreshCw size={15} />{t('重试', 'Retry')}</button></div> : session?.authMode === 'demo' ? <><div className="callout"><ShieldCheck size={18} /><span>{t('本机演示环境。下列账号与预置资源均为示例数据。', 'Local demo. The accounts below and preloaded resources are sample data.')}</span></div><div className="demo-users">{session.demoUsers?.map((user) => <button disabled={busy} key={user.id} onClick={async () => { setBusy(true); setError(null); try { setSession(await api.demoLogin(user.id)) } catch (reason) { setError(reason) } finally { setBusy(false) } }}><span><strong>{user.name}</strong><small>{user.role === 'admin' ? t('管理员权限 · 演示', 'Administrator · Demo') : t('成员权限 · 演示', 'Member · Demo')}</small></span><ArrowRight size={16} /></button>)}</div>{!session.demoUsers?.length && <p className="field-help">{t('没有可用的演示账号，请检查服务配置。', 'No demo accounts are available. Check the service configuration.')}</p>}</> : <><a className={`button primary login-action${!session?.feishuConfigured ? ' disabled' : ''}`} aria-disabled={!session?.feishuConfigured} href={session?.feishuConfigured ? signInHref : undefined}>{t('使用飞书登录', 'Sign in with Feishu')}<ArrowRight size={17} /></a><p className="field-help">{session?.feishuConfigured ? t('使用团队的飞书账号进入预约工作台。', 'Use your team Feishu account to open the workspace.') : t('飞书登录尚未配置，请联系部署管理员。', 'Feishu sign-in is not configured. Contact your deployment administrator.')}</p></>}<div className="login-footer">{t('预约排期不代表实时 GPU 使用状态。', 'Reservations do not indicate live GPU usage.')}</div></div></main>{showSettings && <SettingsDialog state={state} session={session} onClose={() => setShowSettings(false)} />}</>
}
