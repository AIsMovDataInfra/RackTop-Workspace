import { useEffect, useRef, useState } from 'react'
import { api } from './api'
import { errorText } from './errors'
import { memberCompanies, type Company, type Session, type Translate } from './types'
import './company-switcher.css'

export function CompanySwitcher({ session, t, onSessionChanged }: { session: Session; t: Translate; onSessionChanged?: (session: Session) => void }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const generation = useRef(0)
  useEffect(() => { generation.current++; setBusy(false); setError(null); return () => { generation.current++ } }, [session.user?.id, session.user?.company])
  if (session.authMode !== 'account' || !session.user) return null
  const companies = memberCompanies(session.user)
  if (session.user.isSuperAdmin) return <div className="company-switcher company-switcher--global">{t('全部组织', 'All organizations')}</div>
  if (!companies.length) return null
  async function change(company: Company) {
    if (busy || company === session.user?.company || !onSessionChanged) return
    const request = generation.current
    setBusy(true); setError(null)
    try { const value = await api.switchCompany({ company }); if (request === generation.current) onSessionChanged(value) }
    catch (reason) { if (request === generation.current) setError(reason) }
    finally { if (request === generation.current) setBusy(false) }
  }
  return <div className="company-switcher"><label>{t('当前组织', 'Current organization')}<select name="activeCompany" value={session.user.company ?? ''} disabled={busy || companies.length < 2 || !onSessionChanged} onChange={event => void change(event.target.value as Company)}>{companies.map(company => <option key={company}>{company}</option>)}</select></label>{busy && <span role="status">{t('正在切换…', 'Switching…')}</span>}{Boolean(error) && <p className="error" role="alert">{errorText(error, t)}</p>}</div>
}
