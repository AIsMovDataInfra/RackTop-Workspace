import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { WeeklyWorkspace } from './WeeklyWorkspace'
import { api, ApiError } from './api'
import { workspaceApi } from './workspace-api'
import type { Member, Session } from './types'
import type { PreferencesState } from './preferences'
import type { WeeklyReport } from './workspace-types'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const stamp = '2030-01-01T00:00:00Z'
const author: Member = { id: 'author', username: '作者', name: '李同学', role: 'member', company: 'A公司', isSuperAdmin: false, version: 1, createdAt: stamp, recoveryRequestedAt: null }
const reviewer: Member = { ...author, id: 'reviewer', name: '评审同事' }
const admin: Member = { ...author, id: 'admin', name: '超级管理员', role: 'admin', isSuperAdmin: true, company: null }
const outsider: Member = { ...author, id: 'outsider', name: '其他公司成员', company: 'B公司' }
const session: Session = { user: author, authMode: 'account', csrfToken: 'fixture', feishuConfigured: false, notifications: { configured: false }, timezone: 'Asia/Shanghai' }
const state: PreferencesState = { t: zh => zh, preferences: { locale: 'zh-CN', theme: 'light', largeText: false }, setPreferences: vi.fn() }
const report: WeeklyReport = { id: 'report', authorId: author.id, authorName: author.name, company: 'A公司', weekStart: '2030-01-07', todos: [{ text: '调试机械臂', completion: 80, unfinishedReason: '等待夹爪', effect: '完成联调' }], nextPlan: '补齐测试', status: 'draft', reviewerId: reviewer.id, reviewerName: reviewer.name, score: null, reviewComment: '', reviewedBy: null, reviewedName: null, reviewedAt: null, submittedAt: null, version: 1, createdAt: stamp, updatedAt: stamp }
let container: HTMLDivElement, root: ReturnType<typeof createRoot>
const expired = vi.fn()
async function mount(user = author) { await act(async () => root.render(<WeeklyWorkspace session={{ ...session, user }} state={state} navigate={vi.fn()} onLogout={vi.fn()} onSessionChanged={vi.fn()} onSessionExpired={expired}/>)) }
async function click(text: string) { const button = [...container.querySelectorAll('button')].find(item => item.textContent === text)!; expect(button, text).toBeDefined(); await act(async () => button.click()) }
function enter(name: string, value: string) { const input = container.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[name="${name}"]`)!; expect(input, name).toBeTruthy(); act(() => { const prototype = input instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype; Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })) }) }
function select(name: string, value: string) { act(() => { const input = container.querySelector<HTMLSelectElement>(`select[name="${name}"]`)!; input.value = value; input.dispatchEvent(new Event('change', { bubbles: true })) }) }
async function submit(selector: string) { await act(async () => container.querySelector(selector)!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))) }
beforeEach(() => { container = document.createElement('div'); document.body.append(container); root = createRoot(container); vi.spyOn(workspaceApi, 'reports').mockResolvedValue({ reports: [report] }); vi.spyOn(workspaceApi, 'report').mockResolvedValue({ report, history: [] }); vi.spyOn(api, 'members').mockResolvedValue({ members: [author, reviewer, admin, outsider] }); expired.mockClear() })
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
  await mount(admin); await click('打开周报')
  expect([...container.querySelectorAll<HTMLOptionElement>('[name="reviewerId"] option')].map(item => item.value)).toEqual(['', reviewer.id, admin.id])
  select('reviewerId', admin.id); await submit('.work-assignment'); expect(assign).toHaveBeenCalledWith(report.id, 1, admin.id)
  await click('关闭'); await click('写周报')
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
