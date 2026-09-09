import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { WeeklyWorkspace } from './WeeklyWorkspace'
import { api, ApiError } from './api'
import { workspaceApi } from './workspace-api'
import type { Member, Session } from './types'
import type { PreferencesState } from './preferences'
import type { WeeklyReport, WeeklyStatistics } from './workspace-types'
import { addCalendarDays } from './weekly-dates'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const stamp = '2030-01-01T00:00:00Z'
const author: Member = { id: 'author', username: '作者', name: '李同学', role: 'member', company: 'A公司', isSuperAdmin: false, version: 1, createdAt: stamp, recoveryRequestedAt: null }
const reviewer: Member = { ...author, id: 'reviewer', name: '评审同事' }
const admin: Member = { ...author, id: 'admin', name: '超级管理员', role: 'admin', isSuperAdmin: true, company: null }
const outsider: Member = { ...author, id: 'outsider', name: '其他公司成员', company: 'B公司' }
const pending: Member = { ...author, id: 'pending', name: '待分配成员', company: null }
const session: Session = { user: author, authMode: 'account', csrfToken: 'fixture', feishuConfigured: false, notifications: { configured: false }, timezone: 'Asia/Shanghai' }
const state: PreferencesState = { t: zh => zh, preferences: { locale: 'zh-CN', theme: 'light', largeText: false }, setPreferences: vi.fn() }
const report: WeeklyReport = { id: 'report', authorId: author.id, authorName: author.name, company: 'A公司', weekStart: '2030-01-07', todos: [{ text: '调试机械臂', completion: 80, unfinishedReason: '等待夹爪', effect: '完成联调' }], nextPlan: '补齐测试', status: 'draft', reviewerId: reviewer.id, reviewerName: reviewer.name, score: null, reviewComment: '', reviewedBy: null, reviewedName: null, reviewedAt: null, submittedAt: null, version: 1, createdAt: stamp, updatedAt: stamp }
function statistics(weekStart = '2030-01-07'): WeeklyStatistics {
  const weekEnd = addCalendarDays(weekStart, 6)
  const row = { weekStart, weekEnd, todoCount: 0, completedCount: 0, unfinishedCount: 0, averageCompletion: null, score: null, reviewerName: null, reportId: null }
  return { weekStart, weekEnd, timezone: 'Asia/Shanghai', rows: [
    { ...row, authorId: author.id, name: author.name, company: 'A公司', status: 'reviewed', reportId: report.id, todoCount: 2, completedCount: 1, unfinishedCount: 1, averageCompletion: 50, score: 0 },
    { ...row, authorId: reviewer.id, name: reviewer.name, company: 'A公司', status: 'draft', reportId: 'draft', todoCount: 1, unfinishedCount: 1, averageCompletion: 80 },
    { ...row, authorId: outsider.id, name: outsider.name, company: 'B公司', status: 'submitted', reportId: 'submitted', todoCount: 1, completedCount: 1, averageCompletion: 100 },
    { ...row, authorId: pending.id, name: pending.name, company: null, status: 'missing' },
    { ...row, authorId: admin.id, name: admin.name, company: null, status: 'missing' },
  ], summary: { expectedCount: 5, submittedCount: 2, unsubmittedCount: 3, reviewedCount: 1, averageCompletion: 75, averageScore: 0 } }
}
let container: HTMLDivElement, root: ReturnType<typeof createRoot>
const expired = vi.fn()
async function mount(user = author) { await act(async () => root.render(<WeeklyWorkspace session={{ ...session, user }} state={state} navigate={vi.fn()} onLogout={vi.fn()} onSessionChanged={vi.fn()} onSessionExpired={expired}/>)) }
async function click(text: string) { const button = [...container.querySelectorAll('button')].find(item => item.textContent === text)!; expect(button, text).toBeDefined(); await act(async () => button.click()) }
function enter(name: string, value: string) { const input = container.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[name="${name}"]`)!; expect(input, name).toBeTruthy(); act(() => { const prototype = input instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype; Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })) }) }
function select(name: string, value: string) { act(() => { const input = container.querySelector<HTMLSelectElement>(`select[name="${name}"]`)!; input.value = value; input.dispatchEvent(new Event('change', { bubbles: true })) }) }
async function submit(selector: string) { await act(async () => container.querySelector(selector)!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))) }
beforeEach(() => { container = document.createElement('div'); document.body.append(container); root = createRoot(container); vi.spyOn(workspaceApi, 'reports').mockResolvedValue({ reports: [report] }); vi.spyOn(workspaceApi, 'report').mockResolvedValue({ report, history: [] }); vi.spyOn(workspaceApi, 'reportStatistics').mockImplementation(async filters => statistics(filters.weekStart)); vi.spyOn(api, 'members').mockResolvedValue({ members: [author, reviewer, admin, outsider, pending] }); expired.mockClear() })
afterEach(() => { act(() => root.unmount()); container.remove(); vi.restoreAllMocks() })

it('saves an author draft and submits explicit todo completion, reason, outcome and next plan without fetching the member directory', async () => {
  const create = vi.spyOn(workspaceApi, 'createReport').mockResolvedValue({ report })
  await mount(); expect(api.members).not.toHaveBeenCalled(); await click('写周报')
  enter('weekStart', '2030-01-07'); enter('todo-0', '抓取测试'); enter('completion-0', '75'); enter('reason-0', '等待物料'); enter('effect-0', '成功率改善'); enter('nextPlan', '完成试验')
  await click('保存草稿')
  expect(create).toHaveBeenCalledWith({ authorId: author.id, weekStart: '2030-01-07', todos: [{ text: '抓取测试', completion: 75, unfinishedReason: '等待物料', effect: '成功率改善' }], nextPlan: '完成试验', status: 'draft' })
  expect(container.querySelector('[role="dialog"]')).toBeNull()
  const update = vi.spyOn(workspaceApi, 'updateReport').mockResolvedValue({ report: { ...report, status: 'submitted', version: 2 } })
  await click('打开周报'); await click('确认提交周报')
  expect(update).toHaveBeenCalledWith(report.id, { version: 1, todos: report.todos, nextPlan: report.nextPlan, status: 'submitted' })
  expect(container.textContent).toContain('正文已锁定')
})

it('shows assigned reviewers read-only contents and permits only manual scoring after submission', async () => {
  await mount(reviewer); await click('打开周报')
  expect(container.querySelector<HTMLTextAreaElement>('[name="todo-0"]')!.readOnly).toBe(true)
  expect(container.textContent).not.toContain('保存草稿'); expect(container.querySelector('[name="score"]')).toBeNull(); expect(api.members).not.toHaveBeenCalled()
  await click('关闭'); const submitted = { ...report, status: 'submitted' as const, version: 2 }
  vi.mocked(workspaceApi.report).mockResolvedValue({ report: submitted, history: [] })
  const review = vi.spyOn(workspaceApi, 'reviewReport').mockResolvedValue({ report: { ...submitted, version: 3, score: 92.5, reviewComment: '结果可靠', reviewedBy: reviewer.id, reviewedName: reviewer.name, reviewedAt: stamp } })
  await click('打开周报'); enter('score', '92.5'); enter('reviewComment', '结果可靠'); await submit('.work-review')
  expect(review).toHaveBeenCalledWith(report.id, 2, 92.5, '结果可靠'); expect(container.textContent).toContain('作者可以查看结果')
})

it('lets the author read review results without displaying scoring controls', async () => {
  vi.mocked(workspaceApi.report).mockResolvedValue({ report: { ...report, status: 'submitted', score: 88, reviewComment: '<img src=x onerror=alert(1)>', reviewedName: reviewer.name, reviewedAt: stamp }, history: [] })
  await mount(); await click('打开周报')
  expect(container.textContent).toContain('评审结果'); expect(container.textContent).toContain('<img src=x onerror=alert(1)>'); expect(container.querySelector('img')).toBeNull()
  expect(container.querySelector('[name="score"]')).toBeNull(); expect(container.textContent).not.toContain('确认提交周报')
})

it('limits reviewer choices to other same-company members and super administrators, and lets a super administrator choose any active author company', async () => {
  const assign = vi.spyOn(workspaceApi, 'assignReviewer').mockResolvedValue({ report: { ...report, reviewerId: admin.id, reviewerName: admin.name, version: 2 } })
  await mount({ ...admin, company: '西浦' }); await click('打开周报')
  expect([...container.querySelectorAll<HTMLOptionElement>('[name="reviewerId"] option')].map(item => item.value)).toEqual(['', reviewer.id, admin.id])
  select('reviewerId', admin.id); await submit('.work-assignment'); expect(assign).toHaveBeenCalledWith(report.id, 1, admin.id)
  await click('关闭'); await click('代写成员周报')
  expect([...container.querySelectorAll<HTMLOptionElement>('[name="authorId"] option')].map(item => item.value)).toEqual(['', author.id, reviewer.id, outsider.id])
})

it('retains unsaved content after a stale version and reloads it only on explicit request', async () => {
  const update = vi.spyOn(workspaceApi, 'updateReport').mockRejectedValueOnce(new ApiError('stale', 409, 'VERSION_CONFLICT'))
  await mount(); await click('打开周报'); enter('nextPlan', '本地尚未保存的计划'); await click('保存草稿')
  expect(update).toHaveBeenCalledTimes(1); expect(container.querySelector<HTMLTextAreaElement>('[name="nextPlan"]')!.value).toBe('本地尚未保存的计划'); expect(container.textContent).toContain('你的输入已保留')
  vi.mocked(workspaceApi.report).mockResolvedValue({ report: { ...report, nextPlan: '服务器的新计划', version: 2 }, history: [] })
  await click('载入最新内容（替换草稿）'); expect(container.querySelector<HTMLTextAreaElement>('[name="nextPlan"]')!.value).toBe('服务器的新计划')
})

it('erases private content after company revocation and ignores delayed responses from an earlier identity', async () => {
  vi.spyOn(workspaceApi, 'updateReport').mockRejectedValue(new ApiError('company missing', 403, 'COMPANY_REQUIRED'))
  await mount(); await click('打开周报'); await click('保存草稿'); expect(container.querySelector('[role="dialog"]')).toBeNull(); expect(container.textContent).not.toContain('调试机械臂')
  let resolve!: (value: { reports: WeeklyReport[] }) => void
  vi.mocked(workspaceApi.reports).mockImplementationOnce(() => new Promise(done => { resolve = done })).mockResolvedValue({ reports: [] })
  await mount({ ...author, company: 'B公司' }); await mount({ ...author, company: 'C公司' }); await act(async () => resolve({ reports: [{ ...report, authorName: 'PRIVATE_PREVIOUS_COMPANY' }] }))
  expect(container.textContent).not.toContain('PRIVATE_PREVIOUS_COMPANY')
})


it('normalizes an arbitrary report date to Monday and shows the same cross-year week in headings, list and immutable detail', async () => {
  const create = vi.spyOn(workspaceApi, 'createReport').mockResolvedValue({ report })
  await mount(); await click('写周报'); enter('weekStart', '2027-01-03')
  expect(container.querySelector<HTMLInputElement>('[name="weekStart"]')!.value).toBe('2026-12-28')
  expect(container.querySelector('.weekly-period-title')!.textContent).toBe('本周工作（2026-12-28 – 2027-01-03）')
  expect(container.querySelector<HTMLTextAreaElement>('[name="nextPlan"]')!.parentElement!.textContent).toContain('下周计划（2027-01-04 – 2027-01-10）')
  expect(container.textContent).not.toContain('上周工作')
  await click('保存草稿'); expect(create.mock.calls[0][0].weekStart).toBe('2026-12-28')
  expect(container.querySelector('.work-record')!.textContent).toContain('2030-01-07 – 2030-01-13')
  await click('打开周报'); expect(container.querySelector('[name="weekStart"]')).toBeNull()
  expect(container.querySelector('[role="dialog"]')!.textContent).toContain(`${author.name} · 2030-01-07 – 2030-01-13`)
  expect(container.querySelector('.weekly-period-title')!.textContent).toBe('本周工作（2030-01-07 – 2030-01-13）')
  const update = vi.spyOn(workspaceApi, 'updateReport').mockResolvedValue({ report })
  await click('保存草稿'); expect(update.mock.calls[0][1]).not.toHaveProperty('weekStart')
})

it('never mounts or requests statistics for ordinary authors or assigned reviewers', async () => {
  await mount(); expect(container.querySelector('.weekly-view-switch')).toBeNull()
  await mount(reviewer); expect(container.querySelector('.weekly-statistics')).toBeNull()
  await click('刷新'); expect(workspaceApi.reportStatistics).not.toHaveBeenCalled()
})

it('renders administrator statistics with four distinct states, safe names, zero scores, missing values and report navigation', async () => {
  const snapshot = statistics()
  snapshot.rows[1].name = '<img src=x onerror=alert(1)>'
  vi.mocked(workspaceApi.reportStatistics).mockResolvedValue(snapshot)
  await mount(admin); expect(workspaceApi.reportStatistics).not.toHaveBeenCalled(); await click('周报统计')
  const table = container.querySelector('table')!
  expect(table.querySelector('caption')!.textContent).toContain('2030-01-07 – 2030-01-13')
  expect(table.querySelectorAll('thead th[scope="col"]')).toHaveLength(9)
  const rows = [...table.querySelectorAll('tbody tr')]
  expect(rows.map(row => row.querySelectorAll('td')[1].textContent)).toEqual(['已评分', '草稿', '已提交', '缺报'])
  expect(table.textContent).not.toContain(admin.name)
  expect([...container.querySelectorAll<HTMLOptionElement>('[name="statisticsMember"] option')].map(item => item.value)).not.toContain(admin.id)
  expect(rows[0].querySelectorAll('td')[6].textContent).toBe('0 / 100')
  expect(rows[3].querySelectorAll('td')[0].textContent).toContain('待管理员分配')
  expect([...rows[3].querySelectorAll('td')].slice(2).map(cell => cell.textContent)).toEqual(['—', '—', '—', '—', '—', '—'])
  expect(table.textContent).toContain('<img src=x onerror=alert(1)>'); expect(table.querySelector('img')).toBeNull()
  expect([...container.querySelectorAll('.weekly-statistics-summary dd')].map(node => node.textContent)).toEqual(['4', '2', '2', '1'])
  expect(container.querySelector('.weekly-statistics-averages')!.textContent).toContain('75%')
  expect(container.textContent).toContain('缺报、草稿和未评分不记 0 分')
  await act(async () => rows[0].querySelector('button')!.click())
  expect(workspaceApi.report).toHaveBeenCalledWith(report.id); expect(container.querySelector('[role="dialog"]')).not.toBeNull()
})

it('filters statistics by company and member and ignores responses from older week selections', async () => {
  await mount(admin); await click('周报统计')
  select('statisticsCompany', 'A公司'); await act(async () => {})
  select('statisticsMember', author.id); await act(async () => {})
  expect(workspaceApi.reportStatistics).toHaveBeenLastCalledWith(expect.objectContaining({ company: 'A公司', memberId: author.id }))
  select('statisticsCompany', 'B公司'); await act(async () => {})
  expect(workspaceApi.reportStatistics).toHaveBeenLastCalledWith(expect.objectContaining({ company: 'B公司' }))
  expect(vi.mocked(workspaceApi.reportStatistics).mock.lastCall![0]).not.toHaveProperty('memberId')
  let finishEarlier!: (value: WeeklyStatistics) => void
  vi.mocked(workspaceApi.reportStatistics).mockImplementationOnce(() => new Promise(resolve => { finishEarlier = resolve }))
  enter('statisticsWeek', '2027-01-03'); await act(async () => {})
  expect(container.querySelector('table')).toBeNull()
  expect(container.querySelector<HTMLInputElement>('[name="statisticsWeek"]')!.value).toBe('2026-12-28')
  await click('下周')
  expect(workspaceApi.reportStatistics).toHaveBeenLastCalledWith({ weekStart: '2027-01-04', company: 'B公司' })
  expect(container.querySelector('caption')!.textContent).toContain('2027-01-04 – 2027-01-10')
  const old = statistics('2026-12-28'); old.rows[0].name = 'STALE_WEEK_PRIVATE_NAME'
  await act(async () => finishEarlier(old))
  expect(container.textContent).not.toContain('STALE_WEEK_PRIVATE_NAME')
  expect(container.querySelector('caption')!.textContent).toContain('2027-01-04 – 2027-01-10')
  await click('上周'); expect(workspaceApi.reportStatistics).toHaveBeenLastCalledWith({ weekStart: '2026-12-28', company: 'B公司' })
})

it('clears statistics after access revocation and prevents a delayed administrator response from reaching a member view', async () => {
  vi.mocked(workspaceApi.reportStatistics).mockRejectedValueOnce(new ApiError('revoked', 403, 'SUPERADMIN_REQUIRED'))
  await mount(admin); await click('周报统计'); expect(container.querySelector('table')).toBeNull(); expect(container.querySelector('[role="alert"]')).not.toBeNull()
  let finish!: (value: WeeklyStatistics) => void
  vi.mocked(workspaceApi.reportStatistics).mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  await click('周报统计'); await mount(author)
  const old = statistics(); old.rows[0].name = 'REVOKED_ADMIN_PRIVATE_DATA'
  await act(async () => finish(old))
  expect(container.textContent).not.toContain('REVOKED_ADMIN_PRIVATE_DATA')
  expect(container.querySelector('.weekly-statistics')).toBeNull()
  const calls = vi.mocked(workspaceApi.reportStatistics).mock.calls.length
  await click('刷新'); expect(workspaceApi.reportStatistics).toHaveBeenCalledTimes(calls)
})
