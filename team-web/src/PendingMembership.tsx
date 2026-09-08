import { useState } from 'react'
import { Activity, LogOut, RefreshCw, Settings } from 'lucide-react'
import { SettingsDialog } from './SettingsDialog'
import { errorText } from './errors'
import type { PreferencesState } from './preferences'
import type { Session } from './types'

export function PendingMembership({ session, state, error, refreshing, onRefresh, onLogout, onSessionChanged }: { session: Session; state: PreferencesState; error: unknown; refreshing: boolean; onRefresh: () => void; onLogout: () => Promise<void>; onSessionChanged: (session: Session) => void }) {
  const { t } = state
  const [settings, setSettings] = useState(false)
  return <><main className="login-shell member-login-shell" inert={settings}>
    <button className="login-settings icon-button" aria-label={t('设置', 'Settings')} onClick={() => setSettings(true)}><Settings size={19}/></button>
    <div className="member-login"><div className="brand"><span><Activity size={24}/></span><div><strong>RackTop</strong><small>{t('团队工作台', 'Team workspace')}</small></div></div>
      <section className="dialog login-auth" aria-labelledby="pending-company-title"><header><div><h2 id="pending-company-title">{t('等待分配公司', 'Waiting for a company')}</h2><p>{session.user?.name}{session.user?.username ? ` · ${session.user.username}` : ''}</p></div></header>
        <div className="dialog-body"><p>{t('账号已注册。请联系超级管理员分配公司，之后即可查看设备、照片和预约。', 'Your account is registered. Ask the super administrator to assign your company before viewing equipment, photos and reservations.')}</p><p className="field-help">{t('分配完成后此页面会自动继续，也可以点击刷新。原来的设备或预约链接会保留。', 'This page continues automatically when your company is assigned. You can also refresh. Your original equipment or reservation link is kept.')}</p>{Boolean(error) && <div className="error" role="alert">{errorText(error, t)}</div>}</div>
        <footer><button onClick={() => void onLogout()}><LogOut size={16}/>{t('退出登录', 'Sign out')}</button><button className="primary" disabled={refreshing} onClick={onRefresh}><RefreshCw size={16}/>{refreshing ? t('正在刷新…', 'Refreshing…') : t('刷新状态', 'Refresh status')}</button></footer>
      </section>
    </div>
  </main>{settings && <SettingsDialog state={state} session={session} onClose={() => setSettings(false)} onSessionChanged={onSessionChanged}/>}</>
}
