import { useEffect, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { COMPANY_OPTIONS, type Member } from './types'
import type { PreferencesState } from './preferences'
import { workspaceApi } from './workspace-api'
import type { WeeklyStatistics, WeeklyStatisticsFilter } from './workspace-types'
import { workspaceErrorText } from './workspace-errors'
import { addCalendarDays, currentReportWeek, normalizeReportWeek, reportWeekRange } from './weekly-dates'

interface Props {
  members: Member[]; state: PreferencesState; busy: boolean; paused: boolean; refreshKey: number
  onOpen: (id: string) => void; onDenied: (error: unknown) => boolean
}

function withoutSuperAdministrators(data: WeeklyStatistics, ids: Set<string>) {
  const rows = data.rows.filter(row => !ids.has(row.authorId))
  if (rows.length === data.rows.length) return data
  const submitted = rows.filter(row => row.status === 'submitted' || row.status === 'reviewed')
  const reviewed = rows.filter(row => row.status === 'reviewed')
  const mean = (values: number[]) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null
  return { ...data, rows, summary: {
    expectedCount: rows.length,
    submittedCount: submitted.length,
    unsubmittedCount: rows.length - submitted.length,
    reviewedCount: reviewed.length,
    averageCompletion: mean(submitted.map(row => row.averageCompletion).filter((value): value is number => value != null)),
    averageScore: mean(reviewed.map(row => row.score).filter((value): value is number => value != null)),
  } }
}

export function WeeklyStatisticsView({ members, state, busy, paused, refreshKey, onOpen, onDenied }: Props) {
  const { t, preferences } = state
  const [weekStart, setWeekStart] = useState(currentReportWeek)
  const [company, setCompany] = useState<WeeklyStatisticsFilter['company'] | ''>('')
  const [memberId, setMemberId] = useState('')
  const [result, setResult] = useState<{ key: string; data: WeeklyStatistics } | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<unknown>(null)
  const generation = useRef(0)
  const denied = useRef(onDenied)
  denied.current = onDenied
  const selectionKey = JSON.stringify([weekStart, company, memberId])
  const rawData = result?.key === selectionKey ? result.data : null

  useEffect(() => {
    if (paused || !weekStart) return
    async function load() {
      const request = ++generation.current
      setLoading(true); setError(null)
      try {
        const value = await workspaceApi.reportStatistics({ weekStart, ...(company ? { company } : {}), ...(memberId ? { memberId } : {}) })
        if (request === generation.current) setResult({ key: selectionKey, data: value })
      } catch (reason) {
        if (request === generation.current) { setResult(null); if (!denied.current(reason)) setError(reason) }
      } finally { if (request === generation.current) setLoading(false) }
    }
    void load()
    const refresh = () => { if (document.visibilityState !== 'hidden') void load() }
    const timer = window.setInterval(refresh, 30_000)
    window.addEventListener('focus', refresh)
    return () => { generation.current++; window.clearInterval(timer); window.removeEventListener('focus', refresh) }
  }, [weekStart, company, memberId, selectionKey, paused, refreshKey])

  const superAdminIds = new Set(members.filter(member => member.isSuperAdmin).map(member => member.id))
  const data = rawData ? withoutSuperAdministrators(rawData, superAdminIds) : null
  const memberChoices = new Map(members.filter(member => !member.isSuperAdmin).map(member => [member.id, { id: member.id, name: member.name, company: member.company }]))
  // Include report snapshots for former members, while keeping the selected name visible during refresh.
  for (const row of result?.data.rows || []) if (!superAdminIds.has(row.authorId)) memberChoices.set(row.authorId, { id: row.authorId, name: row.name, company: row.company })
  const eligibleMembers = [...memberChoices.values()].filter(member => !company || (company === 'unassigned' ? !member.company : member.company === company))
  const number = (value: number) => new Intl.NumberFormat(preferences.locale, { maximumFractionDigits: 1 }).format(value)
  const completion = (value: number | null) => value == null ? '—' : `${number(value)}%`
  const score = (value: number | null) => value == null ? '—' : `${number(value)} / 100`
  const status = { missing: t('缺报', 'Missing'), draft: t('草稿', 'Draft'), submitted: t('已提交', 'Submitted'), reviewed: t('已评分', 'Reviewed') }

  return <section className="weekly-statistics" aria-label={t('周报统计', 'Weekly statistics')}>
    <div className="weekly-statistics-filters">
      <div className="weekly-week-picker"><label>{t('统计周（任选一天）', 'Report week (choose any day)')}<input name="statisticsWeek" type="date" value={weekStart} onChange={event => setWeekStart(normalizeReportWeek(event.target.value))}/></label><div className="work-inline-actions"><button disabled={!weekStart} onClick={() => setWeekStart(addCalendarDays(weekStart, -7))}><ChevronLeft size={16}/>{t('上周', 'Previous week')}</button><button disabled={!weekStart} onClick={() => setWeekStart(addCalendarDays(weekStart, 7))}>{t('下周', 'Next week')}<ChevronRight size={16}/></button></div></div>
      <label>{t('公司', 'Company')}<select name="statisticsCompany" value={company} onChange={event => { setCompany(event.target.value as typeof company); setMemberId('') }}><option value="">{t('全部公司', 'All companies')}</option>{COMPANY_OPTIONS.map(value => <option key={value} value={value}>{value}</option>)}<option value="unassigned">{t('未分配公司', 'Unassigned company')}</option></select></label>
      <label>{t('成员', 'Member')}<select name="statisticsMember" value={memberId} onChange={event => setMemberId(event.target.value)}><option value="">{t('全部成员', 'All members')}</option>{eligibleMembers.map(member => <option key={member.id} value={member.id}>{member.name}</option>)}</select></label>
    </div>
    <h2 className="weekly-period-title">{weekStart ? reportWeekRange(weekStart) : t('请选择统计周', 'Choose a report week')}</h2>
    <p className="field-help">{t('超级管理员不参与统计。按所选周及筛选范围统计，应报包含该周结束前注册的在册成员，以及该周已有报告的历史作者。已有周报沿用报告中的公司，缺报按成员当前公司统计。', 'Super administrators are excluded. Counts follow the selected week and filters; expected members include active members registered by week-end and all authors with a report that week. Existing reports use their recorded company; missing reports use the member’s current company.')}</p>
    {Boolean(error) && <div className="error" role="alert">{workspaceErrorText(error, t)}</div>}
    {weekStart && loading && <p role="status">{data ? t('正在刷新统计…', 'Refreshing statistics…') : t('正在读取统计…', 'Loading statistics…')}</p>}
    {data && !error && <div aria-busy={loading}>
      <dl className="weekly-statistics-summary"><div><dt>{t('应报成员', 'Expected members')}</dt><dd>{data.summary.expectedCount}</dd></div><div><dt>{t('已提交（含已评分）', 'Submitted, including reviewed')}</dt><dd>{data.summary.submittedCount}</dd></div><div><dt>{t('未提交（缺报与草稿）', 'Not submitted: missing or draft')}</dt><dd>{data.summary.unsubmittedCount}</dd></div><div><dt>{t('已评分', 'Reviewed')}</dt><dd>{data.summary.reviewedCount}</dd></div></dl>
      <p className="weekly-statistics-averages">{t('平均完成度', 'Average completion')} <strong>{completion(data.summary.averageCompletion)}</strong><span>·</span>{t('平均评分', 'Average score')} <strong>{score(data.summary.averageScore)}</strong></p>
      <p className="field-help">{t('完成项 = 完成度 100%，其余为未完成；汇总完成度只对已提交周报先按人平均、再整体平均。均分仅计算已评分记录，缺报、草稿和未评分不记 0 分。', 'A completed task is at 100%; all others are unfinished. Overall completion averages each submitted author’s average. Scores include reviewed reports only; missing, draft and unscored reports are not counted as zero.')}</p>
      {data.rows.length ? <div className="weekly-statistics-scroll" role="region" aria-label={t('成员周报统计表，可横向滚动', 'Member report statistics; scroll horizontally')} tabIndex={0}><table className="weekly-statistics-table"><caption>{t('成员周报统计', 'Member report statistics')} · {reportWeekRange(data.weekStart)}</caption><thead><tr>{[t('成员', 'Member'), t('公司', 'Company'), t('状态', 'Status'), t('任务数', 'Tasks'), t('完成', 'Completed'), t('未完成', 'Unfinished'), t('平均完成度', 'Average completion'), t('评分', 'Score'), t('操作', 'Action')].map(label => <th scope="col" key={label}>{label}</th>)}</tr></thead><tbody>{data.rows.map(row => <tr key={row.authorId}><th scope="row">{row.name}</th><td>{row.company || <>{t('未分配公司', 'Unassigned company')}<small className="weekly-company-help">{t('待管理员分配', 'Awaiting administrator')}</small></>}</td><td><span className={`work-module-status work-module-status--${row.status}`}>{status[row.status]}</span></td><td>{row.reportId ? row.todoCount : '—'}</td><td>{row.reportId ? row.completedCount : '—'}</td><td>{row.reportId ? row.unfinishedCount : '—'}</td><td>{completion(row.averageCompletion)}</td><td>{score(row.score)}</td><td>{row.reportId ? <button disabled={busy} onClick={() => onOpen(row.reportId!)} aria-label={`${t('打开周报', 'Open report')} · ${row.name}`}>{t('打开周报', 'Open report')}</button> : '—'}</td></tr>)}</tbody></table></div> : <div className="empty-state"><h3>{t('此范围没有应报成员', 'No expected members in this selection')}</h3><p>{t('可以调整周次、公司或成员筛选。', 'Try a different week, company or member.')}</p></div>}
    </div>}
  </section>
}
