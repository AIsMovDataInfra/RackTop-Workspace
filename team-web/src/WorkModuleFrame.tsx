import { Brand } from './Brand'
import { CompanySwitcher } from './CompanySwitcher'
import { useState, type ReactNode } from 'react'
import { ClipboardList, LayoutGrid, LogOut, Package, Server, Settings, Users } from 'lucide-react'
import { SettingsDialog } from './SettingsDialog'
import { MemberAvatar } from './MemberAvatar'
import { errorText } from './errors'
import type { WorkModuleProps } from './workspace-types'
import './work-modules.css'

export function WorkModuleFrame({ children, title, subtitle, section, actions, modal, ...props }: WorkModuleProps & { children: ReactNode; title: string; subtitle: string; section?: 'requests' | 'servers'; actions?: ReactNode; modal?: boolean }) {
  const { session, state, navigate, onLogout, onSessionChanged } = props
  const { t } = state
  const [settings, setSettings] = useState(false)
  const [loggingOut, setLoggingOut] = useState(false)
  const [logoutError, setLogoutError] = useState<unknown>(null)
  return <><div className={`workspace-shell work-module${section === 'servers' ? ' servers-workspace' : ''}`} inert={Boolean(modal || settings)}>
    <aside className="sidebar"><Brand t={t} /><CompanySwitcher session={session} t={t} onSessionChanged={onSessionChanged}/>
      <nav className="main-nav" aria-label={t('主导航', 'Main navigation')}>
        <button onClick={() => navigate('/')}><LayoutGrid size={18}/>{t('资源看板', 'Resource board')}</button>
        <button className={section === 'servers' ? 'is-active' : ''} aria-current={section === 'servers' ? 'page' : undefined} onClick={() => navigate('/servers')}><Server size={18}/>{t('服务器资源', 'Server resources')}</button>
        <button onClick={() => navigate('/equipment')}><Package size={18}/>{t('资产设备管理', 'Asset management')}</button>
        <button className={section === 'requests' ? 'is-active' : ''} aria-current={section === 'requests' ? 'page' : undefined} onClick={() => navigate('/requests')}><ClipboardList size={18}/>{t('办公设备申请', 'Office equipment requests')}</button>
        {session.user?.isSuperAdmin && <button onClick={() => navigate('/members')}><Users size={18}/>{t('成员管理', 'Members')}</button>}
      </nav>
      <div className="sidebar-bottom"><button className="sidebar-settings" onClick={() => setSettings(true)}><Settings size={17}/>{t('设置', 'Settings')}</button><div className="profile"><MemberAvatar avatar={session.user?.avatar}/><div><strong>{session.user?.name}</strong><small>{session.user?.isSuperAdmin ? t('超级管理员', 'Super administrator') : session.user?.company || t('团队成员', 'Team member')}</small></div><button className="icon-button" aria-label={t('退出登录', 'Sign out')} disabled={loggingOut} onClick={async () => { setLoggingOut(true); setLogoutError(null); try { await onLogout() } catch (reason) { setLogoutError(reason) } finally { setLoggingOut(false) } }}><LogOut size={16}/></button></div></div>
    </aside>
    <main className="main-workspace"><header className="page-header"><div><p>{t('团队协作', 'Team collaboration')}</p><h1>{title}</h1><span>{subtitle}</span></div><div className="header-actions">{actions}</div></header><div className="page-content">{Boolean(logoutError) && <div className="error" role="alert">{errorText(logoutError, t)}</div>}{children}</div></main>
  </div>{settings && <SettingsDialog state={state} session={session} onSessionChanged={onSessionChanged} onClose={() => setSettings(false)}/>}</>
}
