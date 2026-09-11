import { useEffect, useRef, useState } from 'react'
import { Plus, RefreshCw, Trash2 } from 'lucide-react'
import { api, ApiError } from './api'
import { Dialog } from './Dialog'
import { workspaceErrorText as errorText } from './workspace-errors'
import { formatTime } from './time'
import { WorkModuleFrame } from './WorkModuleFrame'
import { WeeklyStatisticsView } from './WeeklyStatisticsView'
import { addCalendarDays, currentReportWeek, normalizeReportWeek, reportWeekRange } from './weekly-dates'
import { workspaceApi } from './workspace-api'
import { memberCompanies, type Company, type Member } from './types'
import type { WeeklyReport, WorkAudit, WorkModuleProps, WorkTodo } from './workspace-types'

const emptyTodo = (): WorkTodo => ({ text: '', completion: 0, unfinishedReason: '', effect: '' })

export function WeeklyWorkspace(props: WorkModuleProps) {
  const { session, state, onSessionExpired } = props
  const { t, preferences } = state
  const user = session.user
  const [reports, setReports] = useState<WeeklyReport[]>([])
  const [members, setMembers] = useState<Member[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const [formError, setFormError] = useState<unknown>(null)
  const [notice, setNotice] = useState('')
  const [filter, setFilter] = useState('')
  const [view, setView] = useState<'reports' | 'statistics'>('reports')
  const [statisticsRefresh, setStatisticsRefresh] = useState(0)
  const [open, setOpen] = useState(false)
  const [report, setReport] = useState<WeeklyReport | null>(null)
  const [history, setHistory] = useState<WorkAudit[]>([])
  const [weekStart, setWeekStart] = useState(currentReportWeek)
  const [authorId, setAuthorId] = useState(user?.id || '')
  const [reportCompany, setReportCompany] = useState<Company | ''>(user?.company || '')
  const [todos, setTodos] = useState<WorkTodo[]>([emptyTodo()])
  const [nextPlan, setNextPlan] = useState('')
  const [reviewerId, setReviewerId] = useState('')
  const [score, setScore] = useState('')
  const [reviewComment, setReviewComment] = useState('')
  const generation = useRef(0)
  const eligibleAuthors = members.filter(member => !member.isSuperAdmin && memberCompanies(member).length)
  const authorCompanies = memberCompanies(eligibleAuthors.find(member => member.id === authorId) || {})
  const authorUnavailable = Boolean(!report && user?.isSuperAdmin && (!reportCompany || !authorCompanies.includes(reportCompany)))
  const editable = !report || (report.status === 'draft' && Boolean(user?.isSuperAdmin || report.authorId === user?.id))
  const canReview = report?.status === 'submitted' && Boolean(user?.isSuperAdmin || (report.reviewerId === user?.id && report.company === user?.company))
  const conflict = formError instanceof ApiError && formError.code === 'VERSION_CONFLICT'

  function denied(reason: unknown) {
    if (!(reason instanceof ApiError) || ![401, 403].includes(reason.status)) return false
    generation.current++; setView('reports'); setReports([]); setMembers([]); setReport(null); setOpen(false); setTodos([]); setNextPlan(''); setHistory([]); setReviewComment(''); setScore(''); setLoading(false); setError(reason)
    if (reason.status === 401) onSessionExpired()
    return true
  }
  async function load() {
    if (!user) return
    const request = ++generation.current
    setLoading(true); setError(null)
    try {
      const [result, directory] = await Promise.all([workspaceApi.reports(), user.isSuperAdmin ? api.members() : Promise.resolve({ members: [] })])
      if (request !== generation.current) return
      setReports(result.reports); setMembers(directory.members)
    } catch (reason) { if (request === generation.current && !denied(reason)) { setReports([]); setError(reason) } }
    finally { if (request === generation.current) setLoading(false) }
  }
  useEffect(() => { setView('reports'); setReports([]); setMembers([]); setOpen(false); setReport(null); setTodos([]); setNextPlan(''); setHistory([]); setReviewComment(''); setScore(''); if (user) void load(); return () => { generation.current++ } }, [user?.id, user?.company, user?.isSuperAdmin])
  useEffect(() => {
    const refresh = () => { if (!open && !busy && document.visibilityState !== 'hidden') void load() }
    const timer = window.setInterval(refresh, 30_000); window.addEventListener('focus', refresh)
    return () => { window.clearInterval(timer); window.removeEventListener('focus', refresh) }
  }, [open, busy, user?.id, user?.company, user?.isSuperAdmin])
  function setRecord(value: WeeklyReport, entries: WorkAudit[] = []) {
    setReport(value); setWeekStart(value.weekStart); setAuthorId(value.authorId); setReportCompany(value.company); setTodos(value.todos.map(todo => ({ ...todo }))); setNextPlan(value.nextPlan)
    setReviewerId(value.reviewerId || ''); setScore(value.score == null ? '' : String(value.score)); setReviewComment(value.reviewComment); setHistory(entries)
  }
  function create() {
    if (!user || (user.isSuperAdmin && !eligibleAuthors.length)) return
    setReport(null); setHistory([]); setWeekStart(currentReportWeek()); setAuthorId(user.isSuperAdmin ? eligibleAuthors[0].id : user.id); setReportCompany(user.isSuperAdmin ? memberCompanies(eligibleAuthors[0])[0] : user.company || '')
    setTodos([emptyTodo()]); setNextPlan(''); setReviewerId(''); setScore(''); setReviewComment(''); setFormError(null); setNotice(''); setOpen(true)
  }
  async function openReport(id: string) {
    const request = generation.current
    setBusy(true); setError(null)
    try { const value = await workspaceApi.report(id); if (request === generation.current) { setRecord(value.report, value.history); setFormError(null); setOpen(true) } }
    catch (reason) { if (request === generation.current && !denied(reason)) { setError(reason); if (reason instanceof ApiError && reason.status === 404) { setOpen(false); setReport(null); setReports(old => old.filter(item => item.id !== id)) } } }
    finally { setBusy(false) }
  }
  async function save(status: 'draft' | 'submitted') {
    if (busy || !editable || !user || authorUnavailable) return
    const request = generation.current
    setBusy(true); setFormError(null)
    try {
      const value = report ? await workspaceApi.updateReport(report.id, { version: report.version, todos, nextPlan, status }) : await workspaceApi.createReport({ authorId: user.isSuperAdmin ? authorId : user.id, ...(user.isSuperAdmin && reportCompany ? { company: reportCompany } : {}), weekStart, todos, nextPlan, status })
      if (request !== generation.current) return
      setOpen(false); setReport(null); setNotice(status === 'draft' ? t('草稿已保存。', 'Draft saved.') : t('周报已提交，正文已锁定，等待人工评审。', 'Report submitted. Its contents are locked for manual review.')); setStatisticsRefresh(value => value + 1); await load()
      void value
    } catch (reason) { if (request === generation.current && !denied(reason)) setFormError(reason) }
    finally { setBusy(false) }
  }
  async function review(action: 'assign' | 'score') {
    if (!report || busy) return
    const request = generation.current
    setBusy(true); setFormError(null)
    try {
      const value = action === 'assign' ? await workspaceApi.assignReviewer(report.id, report.version, reviewerId || null) : await workspaceApi.reviewReport(report.id, report.version, Number(score), reviewComment)
      if (request !== generation.current) return
      setStatisticsRefresh(value => value + 1); setReport(value.report); setReports(old => old.map(item => item.id === value.report.id ? value.report : item))
      setReviewerId(value.report.reviewerId || ''); setScore(value.report.score == null ? '' : String(value.report.score)); setReviewComment(value.report.reviewComment)
      setNotice(action === 'assign' ? t('评审人已更新。变更评审人会清除当前评分，原评分保留在记录中。', 'Reviewer updated. Changing the reviewer clears the current score and retains the previous review in history.') : t('人工评分已保存，作者可以查看结果。', 'Manual review saved. The author can see the result.'))
      const detail = await workspaceApi.report(value.report.id); if (request === generation.current) setHistory(detail.history)
    } catch (reason) { if (request === generation.current && !denied(reason)) setFormError(reason) }
    finally { setBusy(false) }
  }
  if (!user) return null
  const createLabel = user.isSuperAdmin ? t('代写成员周报', 'Write for a member') : t('写周报', 'Write report')
  const noEligibleAuthors = user.isSuperAdmin && !eligibleAuthors.length
  const currentRange = reportWeekRange(weekStart) || t('请选择报告周', 'Choose a report week')
  const nextRange = reportWeekRange(addCalendarDays(weekStart, 7)) || t('请选择报告周', 'Choose a report week')
  const shown = reports.filter(item => !filter || [item.authorName, item.company, item.weekStart].some(value => value.toLocaleLowerCase().includes(filter.trim().toLocaleLowerCase())))
  const eligibleReviewers = report ? members.filter(member => member.id !== report.authorId && (member.isSuperAdmin || memberCompanies(member).includes(report.company))) : []
  const historyAction = (action: string) => ({ 'report-created': t('建立草稿', 'Draft created'), 'report-edited': t('修改草稿', 'Draft edited'), 'report-submitted': t('提交周报', 'Report submitted'), 'reviewer-assigned': t('调整评审人', 'Reviewer changed'), 'report-reviewed': t('人工评分', 'Manual review') } as Record<string, string>)[action] || action
  return <>
    <WorkModuleFrame {...props} section="reports" title={t('周报与绩效', 'Reports and reviews')} subtitle={t('回顾工作、安排计划，并查看人工评审结果。', 'Review your work, plan ahead and read manual feedback.')} modal={open} actions={<><button disabled={loading || busy} onClick={() => { setStatisticsRefresh(value => value + 1); void load() }}><RefreshCw size={16}/>{t('刷新', 'Refresh')}</button><button className="primary" disabled={busy || loading || noEligibleAuthors} aria-describedby={noEligibleAuthors && !loading && !error ? 'weekly-author-unavailable' : undefined} onClick={create}><Plus size={17}/>{createLabel}</button></>}>
      {Boolean(error) && <div className="error" role="alert">{errorText(error, t)}</div>}{notice && <p className="notice" role="status">{notice}</p>}
      {noEligibleAuthors && !loading && !error && <p id="weekly-author-unavailable" className="field-help">{t('暂无已分配公司的普通成员，请先在成员管理中分配公司。', 'No regular members have an assigned company. Assign one in Members first.')}</p>}
      {user.isSuperAdmin && <div className="segmented weekly-view-switch" role="group" aria-label={t('周报视图', 'Report view')}><button className={view === 'reports' ? 'is-active' : ''} aria-pressed={view === 'reports'} onClick={() => setView('reports')}>{t('周报列表', 'Reports')}</button><button className={view === 'statistics' ? 'is-active' : ''} aria-pressed={view === 'statistics'} onClick={() => setView('statistics')}>{t('周报统计', 'Weekly statistics')}</button></div>}
      {view === 'statistics' && user.isSuperAdmin ? <WeeklyStatisticsView key={`${user.id}-${user.company}`} members={members} state={state} busy={busy} paused={open || busy} refreshKey={statisticsRefresh} onOpen={id => void openReport(id)} onDenied={denied}/> : <>
      <div className="work-filters"><label>{t('查找周报', 'Find a report')}<input type="search" value={filter} onChange={event => setFilter(event.target.value)} placeholder={t('姓名、公司或周一日期', 'Name, company or week date')}/></label><p className="field-help">{t('仅作者、超级管理员和指定评审人可查看。', 'Visible only to the author, super administrator and assigned reviewer.')}</p></div>
      {loading ? <p role="status">{t('正在读取周报…', 'Loading reports…')}</p> : !error && (shown.length ? <div className="work-module-grid">{shown.map(item => <article className="work-record" key={item.id}><header><h2>{item.authorName}</h2><span className={`work-module-status work-module-status--${item.score != null ? 'reviewed' : item.status}`}>{item.status === 'draft' ? t('草稿', 'Draft') : item.score != null ? t('已评分', 'Reviewed') : t('已提交', 'Submitted')}</span></header><p>{item.company} · {reportWeekRange(item.weekStart)}</p><dl><div><dt>{t('评审人', 'Reviewer')}</dt><dd>{item.reviewerName || t('待指定', 'Unassigned')}</dd></div><div><dt>{t('人工评分', 'Manual score')}</dt><dd>{item.score == null ? '—' : `${item.score} / 100`}</dd></div></dl><footer><small className="muted">{formatTime(item.updatedAt, preferences.locale)}</small><button disabled={busy} onClick={() => void openReport(item.id)}>{t('打开周报', 'Open report')}</button></footer></article>)}</div> : <div className="empty-state"><h2>{t('暂无可查看的周报', 'No reports available')}</h2><p>{user.isSuperAdmin ? t('可以代写成员周报，并管理已有周报和评审。', 'Write reports for members and manage existing reports and reviews.') : t('可以创建自己的周报；评审人仅看到被指定的记录。', 'Create your report. Reviewers see only records assigned to them.')}</p></div>)}
      </>}
    </WorkModuleFrame>
    {open && <Dialog title={report ? `${report.authorName} · ${reportWeekRange(report.weekStart)}` : createLabel} subtitle={report?.status === 'submitted' ? t('正文已提交，仅可由授权评审人填写评分。', 'Submitted contents are locked. Authorized reviewers can enter feedback.') : editable ? t('先保存草稿，核对后提交。提交后正文不可修改。', 'Save a draft, then submit when ready. Submitted contents cannot be edited.') : t('作者尚未提交，可查看当前草稿；提交后再填写评分。', 'The author has not submitted yet. You can read the draft and review it after submission.')} t={t} busy={busy} onClose={() => { setOpen(false); setFormError(null) }}>
      <div className="dialog-body">
        <form className="work-report-form" onSubmit={event => { event.preventDefault(); void save('draft') }}>
          {!report && <div className="field-pair"><label>{t('报告周（任选一天）', 'Report week (choose any day)')}<input name="weekStart" type="date" required value={weekStart} disabled={busy} onChange={event => setWeekStart(normalizeReportWeek(event.target.value))}/></label>{user.isSuperAdmin ? <label>{t('周报作者', 'Report author')}<select name="authorId" required value={authorId} disabled={busy} onChange={event => { const id = event.target.value; setAuthorId(id); setReportCompany(memberCompanies(eligibleAuthors.find(member => member.id === id) || {})[0] || '') }}><option value="">{t('选择成员', 'Choose a member')}</option>{eligibleAuthors.map(member => <option key={member.id} value={member.id}>{member.name} · {memberCompanies(member).join('、')}</option>)}</select></label> : <p>{user.name} · {user.company}</p>}</div>}
          {!report && user.isSuperAdmin && <label>{t('周报所属组织', 'Report organization')}<select name="reportCompany" value={reportCompany} disabled={busy || !authorCompanies.length} required onChange={event => setReportCompany(event.target.value as Company)}>{!authorCompanies.length && <option value="">{t('先选择成员', 'Choose a member first')}</option>}{authorCompanies.map(company => <option key={company}>{company}</option>)}</select></label>}
          {!report && <p className="field-help">{t('选择任意日期，自动归属该周周一至周日。', 'Choose any day to use its Monday–Sunday report week.')}</p>}
          <h3 className="weekly-period-title">{t('本周工作', 'This week’s work')}<span>（{currentRange}）</span></h3>
          {todos.map((todo, index) => <fieldset className="work-todo" key={index} disabled={busy}><legend>{t('工作', 'Task')} {index + 1}</legend><label>{t('Todo 工作项', 'Todo item')}<textarea name={`todo-${index}`} readOnly={!editable} value={todo.text} maxLength={400} onChange={event => setTodos(old => old.map((item, position) => position === index ? { ...item, text: event.target.value } : item))}/></label><label>{t('完成度（%）', 'Completion (%)')}<input name={`completion-${index}`} readOnly={!editable} type="number" min={0} max={100} step="any" value={todo.completion} onChange={event => setTodos(old => old.map((item, position) => position === index ? { ...item, completion: Number(event.target.value) } : item))}/></label>{todo.completion < 100 && <label>{t('未完成原因', 'Reason for unfinished work')}<textarea name={`reason-${index}`} readOnly={!editable} maxLength={1000} value={todo.unfinishedReason} onChange={event => setTodos(old => old.map((item, position) => position === index ? { ...item, unfinishedReason: event.target.value } : item))}/></label>}<label>{t('工作效果', 'Outcome and impact')}<textarea name={`effect-${index}`} readOnly={!editable} maxLength={1000} value={todo.effect} onChange={event => setTodos(old => old.map((item, position) => position === index ? { ...item, effect: event.target.value } : item))}/></label>{editable && <div className="work-todo-actions"><button type="button" aria-label={`${t('移除工作', 'Remove task')} ${index + 1}`} onClick={() => setTodos(old => old.filter((_item, position) => position !== index))}><Trash2 size={15}/>{t('移除此项', 'Remove item')}</button></div>}</fieldset>)}
          {editable && <button type="button" disabled={busy || todos.length >= 20} onClick={() => setTodos(old => [...old, emptyTodo()])}><Plus size={16}/>{t('增加工作项', 'Add task')}</button>}
          <label>{t('下周计划', 'Next week’s plan')}（{nextRange}）<textarea name="nextPlan" readOnly={!editable} maxLength={4000} value={nextPlan} disabled={busy} onChange={event => setNextPlan(event.target.value)}/></label>
        </form>
        {report && user.isSuperAdmin && <form className="work-assignment" onSubmit={event => { event.preventDefault(); void review('assign') }}><h3>{t('指定评审人', 'Assign reviewer')}</h3><label>{t('评审人', 'Reviewer')}<select name="reviewerId" value={reviewerId} disabled={busy} onChange={event => setReviewerId(event.target.value)}><option value="">{t('暂不指定', 'No assigned reviewer')}</option>{report.reviewerId && !eligibleReviewers.some(member => member.id === report.reviewerId) && <option value={report.reviewerId} disabled>{report.reviewerName} · {t('需重新指定', 'Reassignment needed')}</option>}{eligibleReviewers.map(member => <option key={member.id} value={member.id}>{member.name}{member.isSuperAdmin ? ` · ${t('超级管理员', 'Super administrator')}` : ''}</option>)}</select></label><p className="field-help">{t('普通评审人须同公司。更换评审人会清除当前评分，保留原评审记录。', 'Regular reviewers must be in the same company. Reassignment clears the current score and retains past reviews.')}</p><button type="submit" disabled={busy || reviewerId === (report.reviewerId || '')}>{t('保存评审人', 'Save reviewer')}</button></form>}
        {canReview ? <form className="work-review" onSubmit={event => { event.preventDefault(); if (score !== '') void review('score') }}><h3>{t('人工评审', 'Manual review')}</h3><label>{t('评分（0–100）', 'Score (0–100)')}<input name="score" type="number" min={0} max={100} step="any" required value={score} disabled={busy} onChange={event => setScore(event.target.value)}/></label><label>{t('评语', 'Feedback')}<textarea name="reviewComment" maxLength={4000} value={reviewComment} disabled={busy} onChange={event => setReviewComment(event.target.value)}/></label><button type="submit" disabled={busy}>{t('保存人工评分', 'Save manual review')}</button></form> : report?.score != null && <section className="work-review"><h3>{t('评审结果', 'Review result')}</h3><strong>{report.score} / 100</strong><p>{report.reviewComment || '—'}</p><small className="muted">{report.reviewedName} · {formatTime(report.reviewedAt!, preferences.locale)}</small></section>}
        {notice && <p className="notice" role="status">{notice}</p>}
        {Boolean(formError) && <div className="error" role="alert">{conflict ? t('记录已有更新。你的输入已保留；核对后可载入最新内容，再重新编辑。', 'The record changed. Your input is retained. Load the latest contents to review and edit again.') : errorText(formError, t)}{conflict && report && <button type="button" disabled={busy} onClick={() => void openReport(report.id)}>{t('载入最新内容（替换草稿）', 'Load latest contents (replace draft)')}</button>}</div>}
        {history.length > 0 && <details><summary>{t('操作记录', 'Activity history')}</summary><ol className="work-report-history">{history.map((entry, index) => <li key={`${entry.at}-${index}`}><strong>{entry.actorName}</strong><span>{historyAction(entry.action)}</span><time dateTime={entry.at}>{formatTime(entry.at, preferences.locale)}</time>{entry.action === 'report-reviewed' && <p>{t('评分：', 'Score: ')}{String(entry.details.score)} / 100 · {String(entry.details.comment || '—')}</p>}</li>)}</ol></details>}
      </div><footer><button disabled={busy} onClick={() => { setOpen(false); setFormError(null) }}>{t('关闭', 'Close')}</button>{editable && <><button disabled={busy || conflict || authorUnavailable || (!report && !weekStart)} onClick={() => void save('draft')}>{t('保存草稿', 'Save draft')}</button><button className="primary" disabled={busy || conflict || authorUnavailable || (!report && !weekStart)} onClick={() => void save('submitted')}>{t('确认提交周报', 'Submit report')}</button></>}</footer>
    </Dialog>}
  </>
}
