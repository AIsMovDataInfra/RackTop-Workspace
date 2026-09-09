import { useEffect, useRef, useState } from 'react'
import { AvatarPicker, MemberAvatar } from './MemberAvatar'
import { api, ApiError } from './api'
import { errorText } from './errors'
import { Bell, LogIn, ShieldCheck } from 'lucide-react'
import { Dialog } from './Dialog'
import type { PreferencesState } from './preferences'
import type { Session } from './types'

export function SettingsDialog({ state, session, onClose, onSessionChanged }: { state: PreferencesState; session: Session | null; onClose: () => void; onSessionChanged?: (session: Session) => void }) {
  const { preferences, setPreferences, t } = state
  const [oldPassword, setOldPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const [changed, setChanged] = useState(false)
  const [profile, setProfile] = useState(session?.user ?? null)
  const [avatar, setAvatar] = useState(session?.user?.avatar || 'user')
  const [profileError, setProfileError] = useState<unknown>(null)
  const [profileNotice, setProfileNotice] = useState('')
  const generation = useRef(0)
  useEffect(() => {
    generation.current++
    setProfile(session?.user ?? null); setAvatar(session?.user?.avatar || 'user')
    setProfileError(null); setProfileNotice(''); setOldPassword(''); setNewPassword('')
    return () => { generation.current++ }
  }, [session?.user?.id])
  useEffect(() => { setProfile(session?.user ?? null) }, [session?.user?.version, session?.user?.avatar, session?.user?.company, session?.user?.isSuperAdmin])
  async function saveAvatar() {
    if (busy || !profile || !session) return
    setProfileError(null); setProfileNotice(''); setBusy(true)
    const request = generation.current
    try {
      const value = await api.updateProfile({ version: profile.version || 1, avatar })
      if (request !== generation.current) return
      setProfile(value.user); setAvatar(value.user?.avatar || 'user'); onSessionChanged?.(value)
      setProfileNotice(t('头像已保存，其他设备登录后也会显示。', 'Avatar saved to your account and available on your other devices.'))
    } catch (reason) {
      if (request !== generation.current) return
      if (reason instanceof ApiError && reason.status === 409) {
        try {
          const fresh = await api.session()
          if (request !== generation.current) return
          setProfile(fresh.user); onSessionChanged?.(fresh)
          setProfileError(new Error(t('账号资料刚刚有变化，已读取最新资料。你的头像选择已保留，请核对后再次保存。', 'Your profile changed. Latest details are loaded and your avatar choice is retained. Review and save again.')))
        } catch (refreshError) { if (request === generation.current) setProfileError(refreshError) }
      } else setProfileError(reason)
    } finally { if (request === generation.current) setBusy(false) }
  }
  return <Dialog compact title={t('设置', 'Settings')} onClose={onClose} busy={busy} t={t}><div className="dialog-body"><section className="settings-section"><h3>{t('界面偏好', 'Appearance')}</h3><label>{t('界面语言', 'Language')}<select value={preferences.locale} onChange={(event) => setPreferences((old) => ({ ...old, locale: event.target.value === 'en' ? 'en' : 'zh-CN' }))}><option value="zh-CN">简体中文</option><option value="en">English</option></select></label><label>{t('外观', 'Theme')}<select value={preferences.theme} onChange={(event) => setPreferences((old) => ({ ...old, theme: event.target.value as 'light' | 'dark' | 'system' }))}><option value="light">{t('浅色', 'Light')}</option><option value="dark">{t('深色', 'Dark')}</option><option value="system">{t('跟随系统', 'System')}</option></select></label><label className="checkbox-label"><input type="checkbox" checked={preferences.largeText} onChange={(event) => setPreferences((old) => ({ ...old, largeText: event.target.checked }))} />{t('使用较大文字', 'Use larger text')}</label></section>{session?.authMode === 'account' && profile && <section className="settings-section"><h3>{t('我的资料', 'My profile')}</h3><div className="member-account-summary"><MemberAvatar avatar={avatar} size={25}/><div><strong>{profile.name}</strong>{profile.username && profile.username !== profile.name && <small>{t('原用户名：', 'Original username: ')}{profile.username}</small>}</div></div><p className="member-company-readonly">{profile.isSuperAdmin ? t('跨公司管理，无需分配公司', 'Cross-company management; no company assignment needed') : <>{t('公司：', 'Company: ')}{profile.company || t('待分配', 'Unassigned')}{t('（由超级管理员管理）', ' (managed by the super administrator)')}</>}</p><AvatarPicker value={avatar} onChange={(value) => { setAvatar(value); setProfileNotice('') }} disabled={busy} t={t}/>{Boolean(profileError) && <div className="error" role="alert">{errorText(profileError, t)}</div>}{profileNotice && <p className="available-text" role="status">{profileNotice}</p>}<button type="button" disabled={busy || avatar === (profile.avatar || 'user')} onClick={() => void saveAvatar()}>{t('保存头像', 'Save avatar')}</button></section>}{session?.authMode === 'account' && session.user && <form className="settings-section" onSubmit={async (event) => { event.preventDefault(); if (busy) return; setError(null); setChanged(false); if (!oldPassword || !newPassword.trim()) { setError(new Error(t('请输入密码', 'Enter a password'))); return }; setBusy(true); try { const value = await api.changePassword({ oldPassword, newPassword }); setOldPassword(''); setNewPassword(''); setChanged(true); onSessionChanged?.(value) } catch (reason) { setError(reason) } finally { setBusy(false) } }}><h3>{t('账号与密码', 'Account and password')}</h3><label>{t('当前密码', 'Current password')}<input type="password" autoComplete="current-password" required disabled={busy} value={oldPassword} onChange={(event) => setOldPassword(event.target.value)} /></label><label>{t('新密码', 'New password')}<input type="password" autoComplete="new-password" required disabled={busy} value={newPassword} onChange={(event) => setNewPassword(event.target.value)} /></label><p className="field-help">{t('修改后其他网页登录和全部桌面设备登录将失效。忘记密码时可申请由超级管理员协助重置。', 'Changing your password signs out other web sessions and all desktop devices. Request help from the super administrator if you forget it.')}</p>{Boolean(error) && <div className="error" role="alert">{error instanceof ApiError && error.code === 'INVALID_CREDENTIALS' ? t('当前密码不正确。', 'The current password is incorrect.') : errorText(error, t)}</div>}{changed && <p role="status" className="available-text">{t('密码已更新，其他网页和全部桌面登录已退出。', 'Password updated. Other web sessions and all desktop devices are signed out.')}</p>}<button type="submit" disabled={busy}>{busy ? t('保存中…', 'Saving…') : t('修改密码', 'Change password')}</button></form>}<section className="settings-section"><h3>{t('连接状态', 'Service configuration')}</h3><div className="connection-row"><LogIn size={18} /><div><strong>{t('登录方式', 'Sign-in method')}</strong><span>{!session ? t('服务尚未连接', 'Service unavailable') : session.authMode === 'account' ? t('成员名称和密码', 'Member name and password') : session.authMode === 'demo' ? t('本机演示账号', 'Local demo accounts') : session.feishuConfigured ? t('飞书组织登录已配置', 'Feishu sign-in configured') : t('飞书登录尚未配置', 'Feishu sign-in not configured')}</span></div></div><div className="connection-row"><Bell size={18} /><div><strong>{t('飞书群通知', 'Feishu group notifications')}</strong><span>{session?.notifications.configured ? t('已配置 · 由服务端发送', 'Configured · Sent by the service') : t('未配置 · 当前不会发送通知', 'Not configured · Notifications are off')}</span></div></div><p className="field-help">{t('配置状态不代表消息已经送达；通知发送异常不影响已保存的预约。', 'Configuration does not confirm message delivery. Notification failures do not undo saved reservations.')}</p></section><details className="settings-documentation"><summary>{t('登录与通知配置说明', 'Sign-in and notification setup')}</summary><p>{session?.authMode === 'account' ? t('成员使用一个名称和密码注册，超级管理员分配公司后即可查看设备、照片和排期。勾选记住登录可保持360天，桌面设备登录仍为30天。', 'Members register with one name and password. The super administrator assigns a company before business access. Remembered web sessions last 360 days; desktop sessions remain 30 days.') : t('成员权限由服务端会话确定。飞书登录需要管理员配置应用与允许的组织。', 'The service determines member permissions. Feishu sign-in requires a configured application and allowed organizations.')}</p><p>{t('飞书群机器人可发送预约创建、变更、取消及到期提醒。通知只提供预约摘要与页面链接，不会执行服务器任务。实际能力以当前服务端配置为准。', 'A Feishu group bot can send reservation changes and expiry reminders with a summary and page link. It does not run server jobs. Availability depends on the service configuration.')}</p><p>{t('凭据由部署管理员在服务端保管，浏览器不展示或修改应用密钥、机器人地址和签名密钥。', 'Deployment administrators manage credentials on the server. The browser does not display or edit application secrets, webhook addresses or signing keys.')}</p></details><div className="callout"><ShieldCheck size={18} /><span>{t('所有预约时间显示为北京时间（Asia/Shanghai，UTC+8）。预约状态与实时 GPU 监测相互独立。', 'All booking times use Beijing time (Asia/Shanghai, UTC+8). Reservation status is separate from live GPU monitoring.')}</span></div></div><footer><button className="primary" disabled={busy} onClick={onClose}>{t('完成', 'Done')}</button></footer></Dialog>
}
