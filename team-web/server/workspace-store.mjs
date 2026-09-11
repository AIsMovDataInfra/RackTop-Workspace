import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { ApiError } from './store.mjs';

const companies = new Set(['A公司', 'B公司', 'C公司', '西浦']);
const categories = new Set(['机械臂', '台式主机', '显示屏', '摄像头模组', '实验物料', '小推车', '夹爪']);
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const fail = (status, code, message) => { throw new ApiError(status, code, message); };
const invalid = (message) => fail(422, 'INVALID_INPUT', message);
const iso = (value) => value == null ? null : new Date(value).toISOString();
function fields(value, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) invalid('请求字段无效');
}
function text(value, max, required = false) {
  if (typeof value !== 'string') invalid('文本格式无效');
  const result = value.trim();
  if ((required && !result) || result.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(result)) invalid(`文本不能为空或超过 ${max} 字符`);
  return result;
}
function identifier(value) {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) invalid('记录标识符无效');
  return value.toLowerCase();
}
const dayMilliseconds = 24 * 60 * 60 * 1000;
const beijingOffset = 8 * 60 * 60 * 1000;
const dateOnly = value => value.toISOString().split('T')[0];
function week(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) invalid('请选择有效的周报日期');
  const date = new Date(`${value}T00:00:00Z`);
  if (!Number.isFinite(date.getTime()) || dateOnly(date) !== value) invalid('周报日期无效');
  date.setUTCDate(date.getUTCDate() - (date.getUTCDay() + 6) % 7);
  const weekStart = dateOnly(date), weekEnd = dateOnly(new Date(date.getTime() + 6 * dayMilliseconds));
  if (![weekStart, weekEnd].every(day => /^\d{4}-\d{2}-\d{2}$/.test(day))) invalid('请选择四位年份范围内的完整周');
  return { weekStart, weekEnd,
    // Account registration timestamps are compared with Monday 00:00 in Beijing.
    endExclusive: date.getTime() + 7 * dayMilliseconds - beijingOffset };
}
const average = values => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
const memberCompanies = member => Array.isArray(member?.companies) ? member.companies : (companies.has(member?.company) ? [member.company] : []);
function content(value, submitted) {
  if (!Array.isArray(value.todos) || value.todos.length > 20) invalid('周报最多填写 20 项工作');
  const todos = value.todos.map(item => {
    fields(item, ['text', 'completion', 'unfinishedReason', 'effect']);
    if (typeof item.completion !== 'number' || !Number.isFinite(item.completion) || item.completion < 0 || item.completion > 100) invalid('完成度须为 0–100');
    const todo = { text: text(item.text, 400, submitted), completion: item.completion,
      unfinishedReason: text(item.unfinishedReason, 1000), effect: text(item.effect, 1000) };
    if (submitted && todo.completion < 100 && !todo.unfinishedReason) invalid('未完成的工作请填写原因');
    return todo;
  });
  const nextPlan = text(value.nextPlan, 4000, submitted);
  if (submitted && !todos.length) invalid('提交周报前请至少填写一项工作');
  if (Buffer.byteLength(JSON.stringify({ todos, nextPlan })) > 60 * 1024) invalid('周报内容过长，请精简后保存');
  return { todos, nextPlan };
}

export function createWorkspaceStore({ dbPath = ':memory:', now = Date.now, resolveMember, validateEquipmentTarget, onCollectEquipment } = {}) {
  if (typeof resolveMember !== 'function') throw new Error('Workspace store requires a current member identity resolver');
  if (dbPath !== ':memory:') mkdirSync(dirname(resolve(dbPath)), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(`PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      BEGIN IMMEDIATE;
      CREATE TABLE IF NOT EXISTS weekly_reports (
        id TEXT PRIMARY KEY, author_id TEXT NOT NULL, author_name TEXT NOT NULL, company TEXT NOT NULL,
        week_start TEXT NOT NULL, todos TEXT NOT NULL, next_plan TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('draft','submitted')),
        reviewer_id TEXT, reviewer_name TEXT, score REAL CHECK(score BETWEEN 0 AND 100), review_comment TEXT NOT NULL DEFAULT '',
        reviewed_by TEXT, reviewed_name TEXT, reviewed_at INTEGER, submitted_at INTEGER,
        version INTEGER NOT NULL CHECK(version > 0), created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        UNIQUE(author_id,company,week_start));
      CREATE INDEX IF NOT EXISTS weekly_reports_visible ON weekly_reports(company,author_id,reviewer_id,week_start DESC);
      CREATE TABLE IF NOT EXISTS equipment_requests (
        id TEXT PRIMARY KEY, applicant_id TEXT NOT NULL, applicant_name TEXT NOT NULL, company TEXT NOT NULL,
        category TEXT NOT NULL, quantity INTEGER NOT NULL CHECK(quantity BETWEEN 1 AND 999), purpose TEXT NOT NULL,
        equipment_id TEXT, equipment_name TEXT, equipment_serial TEXT,
        status TEXT NOT NULL CHECK(status IN ('pending','approved','rejected','collected')),
        decision_comment TEXT NOT NULL DEFAULT '', equipment_updated INTEGER NOT NULL DEFAULT 0,
        version INTEGER NOT NULL CHECK(version > 0), created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS workspace_audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT, record_kind TEXT NOT NULL, record_id TEXT NOT NULL,
        actor_id TEXT NOT NULL, actor_name TEXT NOT NULL, action TEXT NOT NULL, at INTEGER NOT NULL, details TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS workspace_audit_record ON workspace_audit(record_kind,record_id,id);`);
    const legacyUnique = db.prepare('PRAGMA index_list(weekly_reports)').all().some(index => index.unique
      && db.prepare(`PRAGMA index_info("${index.name.replaceAll('"', '""')}")`).all().map(column => column.name).join(',') === 'author_id,week_start');
    if (legacyUnique) {
      const definition = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='weekly_reports'").get().sql;
      const dependents = db.prepare("SELECT sql FROM sqlite_master WHERE tbl_name='weekly_reports' AND type IN ('index','trigger') AND sql IS NOT NULL").all();
      const replacement = definition.replace(/CREATE TABLE\s+(?:IF NOT EXISTS\s+)?["`\[]?weekly_reports["`\]]?/i, 'CREATE TABLE weekly_reports_membership_migration')
        .replace(/UNIQUE\s*\(\s*author_id\s*,\s*week_start\s*\)/i, 'UNIQUE(author_id,company,week_start)');
      if (replacement === definition || !replacement.includes('UNIQUE(author_id,company,week_start)')) throw new Error('Cannot safely migrate weekly report uniqueness');
      db.exec(replacement);
      db.exec('INSERT INTO weekly_reports_membership_migration SELECT * FROM weekly_reports; DROP TABLE weekly_reports; ALTER TABLE weekly_reports_membership_migration RENAME TO weekly_reports;');
      for (const item of dependents) db.exec(item.sql);
    }
    db.exec('COMMIT');
  } catch (error) { try { db.exec('ROLLBACK'); } catch {} db.close(); throw error; }
  function transaction(operation, write = true) {
    let started = false;
    try { db.exec(write ? 'BEGIN IMMEDIATE' : 'BEGIN'); started = true; const value = operation(); db.exec('COMMIT'); return value; }
    catch (error) {
      if (started) { try { db.exec('ROLLBACK'); } catch {} }
      if (error?.errcode === 5 || error?.code === 'SQLITE_BUSY') fail(503, 'DATABASE_BUSY', '工作台繁忙，请稍后重试');
      throw error;
    }
  }
  function actor(claim) {
    const user = claim?.id && resolveMember(claim.id);
    if (!user || !['admin', 'member'].includes(user.role)) fail(401, 'UNAUTHENTICATED', '请重新登录');
    if (user.isSuperAdmin) return { ...user, company: null };
    const granted = memberCompanies(user);
    if (!granted.length) fail(403, 'COMPANY_REQUIRED', '请联系超级管理员分配公司');
    // Older identity resolvers are single-company; account sessions explicitly
    // carry an active company, which must still belong to the fresh identity.
    const active = Array.isArray(user.companies) ? claim.company : user.company;
    if (!granted.includes(active)) fail(409, 'COMPANY_CHANGED', '当前组织已变化，请刷新后重试');
    return { ...user, company: active };
  }
  function superAdmin(user) { if (!user.isSuperAdmin) fail(403, 'SUPERADMIN_REQUIRED', '仅超级管理员可操作'); }
  function target(id, allowUnassignedSuper = false) {
    const member = typeof id === 'string' && resolveMember(id);
    if (!member || (!memberCompanies(member).length && !(allowUnassignedSuper && member.isSuperAdmin))) invalid('请选择已分配公司的有效成员');
    return member;
  }
  function version(row, expected) {
    if (!Number.isSafeInteger(expected) || expected < 1) invalid('请提交记录的当前版本');
    if (row.version !== expected || row.version >= Number.MAX_SAFE_INTEGER) fail(409, 'VERSION_CONFLICT', '记录已变化，请读取最新版本并核对');
  }
  function audit(kind, id, user, action, details, at) {
    db.prepare('INSERT INTO workspace_audit(record_kind,record_id,actor_id,actor_name,action,at,details) VALUES(?,?,?,?,?,?,?)')
      .run(kind, id, user.id, user.name, action, at, JSON.stringify(details));
  }
  function history(kind, id) {
    return db.prepare('SELECT actor_name,action,at,details FROM workspace_audit WHERE record_kind=? AND record_id=? ORDER BY id DESC LIMIT 100')
      .all(kind, id).map(row => ({ actorName: row.actor_name, action: row.action, at: iso(row.at), details: JSON.parse(row.details) }));
  }
  function reportView(row) {
    return { id: row.id, authorId: row.author_id, authorName: row.author_name, company: row.company, weekStart: row.week_start,
      todos: JSON.parse(row.todos), nextPlan: row.next_plan, status: row.status, reviewerId: row.reviewer_id, reviewerName: row.reviewer_name,
      score: row.score, reviewComment: row.review_comment, reviewedBy: row.reviewed_by, reviewedName: row.reviewed_name,
      reviewedAt: iso(row.reviewed_at), submittedAt: iso(row.submitted_at), version: row.version, createdAt: iso(row.created_at), updatedAt: iso(row.updated_at) };
  }
  function reportRow(id) {
    const row = db.prepare('SELECT * FROM weekly_reports WHERE id=?').get(identifier(id));
    if (!row) fail(404, 'REPORT_NOT_FOUND', '找不到可访问的周报');
    return row;
  }
  function readable(row, user) {
    return user.isSuperAdmin || (user.company === row.company && (user.id === row.author_id || user.id === row.reviewer_id));
  }
  function readReport(id, user) { const row = reportRow(id); if (!readable(row, user)) fail(404, 'REPORT_NOT_FOUND', '找不到可访问的周报'); return row; }
  function createReport(input, claim) {
    fields(input, ['authorId', 'company', 'weekStart', 'todos', 'nextPlan', 'status']);
    const status = input.status ?? 'draft';
    if (!['draft', 'submitted'].includes(status)) invalid('周报状态无效');
    const data = content(input, status === 'submitted'), { weekStart } = week(input.weekStart);
    return transaction(() => {
      const user = actor(claim), author = target(input.authorId ?? user.id, true);
      if (!user.isSuperAdmin && author.id !== user.id) fail(403, 'FORBIDDEN', '只能为自己创建周报');
      if (author.isSuperAdmin) fail(403, 'SUPERADMIN_REPORT_NOT_REQUIRED', '超级管理员无需填写周报，请选择普通成员');
      const selectedCompany = input.company ?? (user.isSuperAdmin ? author.company : user.company);
      if (!memberCompanies(author).includes(selectedCompany) || (!user.isSuperAdmin && selectedCompany !== user.company)) fail(403, 'COMPANY_NOT_ALLOWED', '不能为此组织创建周报');
      if (db.prepare('SELECT 1 FROM weekly_reports WHERE author_id=? AND company=? AND week_start=?').get(author.id, selectedCompany, weekStart)) fail(409, 'REPORT_EXISTS', '该成员在此组织本周已有周报，请打开已有记录');
      const id = randomUUID(), at = now();
      db.prepare(`INSERT INTO weekly_reports(id,author_id,author_name,company,week_start,todos,next_plan,status,submitted_at,version,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,1,?,?)`).run(id, author.id, author.name, selectedCompany, weekStart, JSON.stringify(data.todos), data.nextPlan, status, status === 'submitted' ? at : null, at, at);
      audit('report', id, user, status === 'submitted' ? 'report-submitted' : 'report-created', { authorId: author.id, weekStart, ...data }, at);
      return reportView(reportRow(id));
    });
  }
  function reportStatistics(query, claim) {
    return transaction(() => {
      const user = actor(claim); superAdmin(user);
      fields(query, ['weekStart', 'company', 'memberId']);
      const { weekStart, weekEnd, endExclusive } = week(query.weekStart ?? dateOnly(new Date(now() + beijingOffset)));
      if (own(query, 'company') && query.company !== 'unassigned' && !companies.has(query.company)) invalid('公司筛选无效');
      const memberId = own(query, 'memberId') ? identifier(query.memberId) : null;
      // Read only profile columns, on this same connection and snapshot as the reports.
      const membershipAware = Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='account_user_companies'").get());
      const members = db.prepare(membershipAware
        ? `SELECT a.id,a.name,m.company FROM account_users a LEFT JOIN account_user_companies m ON m.user_id=a.id
          WHERE a.is_super_admin=0 AND a.deleted_at IS NULL AND a.created_at<?`
        : 'SELECT id,name,company FROM account_users WHERE is_super_admin=0 AND deleted_at IS NULL AND created_at<?').all(endExclusive);
      const reports = db.prepare(`SELECT r.id,r.author_id,r.author_name,r.company,r.todos,r.status,r.score,r.reviewer_name
        FROM weekly_reports r WHERE r.week_start=? AND NOT EXISTS (
          SELECT 1 FROM account_users a WHERE a.id=r.author_id AND a.is_super_admin=1)`).all(weekStart);
      const rowKey = (id, selectedCompany) => membershipAware ? JSON.stringify([id, selectedCompany]) : id;
      const rows = new Map(members.map(member => [rowKey(member.id, member.company), { authorId: member.id, name: member.name, company: member.company,
        weekStart, weekEnd, status: 'missing', reportId: null, todoCount: 0, completedCount: 0, unfinishedCount: 0,
        averageCompletion: null, score: null, reviewerName: null }]));
      // Actual reports retain their historical identity/company, including deleted and backfilled authors.
      for (const report of reports) {
        const todos = JSON.parse(report.todos), completedCount = todos.filter(todo => todo.completion === 100).length;
        rows.set(rowKey(report.author_id, report.company), { authorId: report.author_id, name: report.author_name, company: report.company,
          weekStart, weekEnd, status: report.score == null ? report.status : 'reviewed', reportId: report.id,
          todoCount: todos.length, completedCount, unfinishedCount: todos.length - completedCount,
          averageCompletion: average(todos.map(todo => todo.completion)), score: report.score, reviewerName: report.reviewer_name });
      }
      const selected = [...rows.values()].filter(row => (!memberId || row.authorId === memberId)
        && (!own(query, 'company') || row.company === (query.company === 'unassigned' ? null : query.company)))
        .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN') || a.authorId.localeCompare(b.authorId) || (a.company ?? '').localeCompare(b.company ?? '', 'zh-CN'));
      const submitted = selected.filter(row => ['submitted', 'reviewed'].includes(row.status));
      const reviewed = selected.filter(row => row.status === 'reviewed');
      return { weekStart, weekEnd, timezone: 'Asia/Shanghai', rows: selected,
        summary: { expectedCount: selected.length, submittedCount: submitted.length, unsubmittedCount: selected.length - submitted.length,
          reviewedCount: reviewed.length, averageCompletion: average(submitted.map(row => row.averageCompletion).filter(value => value != null)),
          averageScore: average(reviewed.map(row => row.score)) } };
    }, false);
  }
  function updateReport(id, input, claim) {
    fields(input, ['version', 'todos', 'nextPlan', 'status']);
    return transaction(() => {
      const user = actor(claim), previous = readReport(id, user);
      if (!user.isSuperAdmin && previous.author_id !== user.id) fail(403, 'FORBIDDEN', '只有作者和超级管理员可修改周报');
      version(previous, input.version);
      if (previous.status !== 'draft') fail(409, 'REPORT_LOCKED', '周报已提交，正文不可再修改');
      const status = input.status ?? 'draft';
      if (!['draft', 'submitted'].includes(status)) invalid('周报状态无效');
      const data = content({ todos: own(input, 'todos') ? input.todos : JSON.parse(previous.todos), nextPlan: own(input, 'nextPlan') ? input.nextPlan : previous.next_plan }, status === 'submitted');
      if (status === previous.status && JSON.stringify(data.todos) === previous.todos && data.nextPlan === previous.next_plan) return reportView(previous);
      const at = now();
      db.prepare('UPDATE weekly_reports SET todos=?,next_plan=?,status=?,submitted_at=?,version=version+1,updated_at=? WHERE id=? AND version=?')
        .run(JSON.stringify(data.todos), data.nextPlan, status, status === 'submitted' ? at : null, at, previous.id, input.version);
      audit('report', previous.id, user, status === 'submitted' ? 'report-submitted' : 'report-edited', { before: { todos: JSON.parse(previous.todos), nextPlan: previous.next_plan }, after: data }, at);
      return reportView(reportRow(previous.id));
    });
  }
  function assignReviewer(id, input, claim) {
    fields(input, ['version', 'reviewerId']);
    return transaction(() => {
      const user = actor(claim); superAdmin(user); const previous = reportRow(id); version(previous, input.version);
      const reviewer = input.reviewerId === null ? null : target(input.reviewerId, true);
      if (reviewer && reviewer.id === previous.author_id) invalid('作者不能担任自己的评审人');
      if (reviewer && !reviewer.isSuperAdmin && !memberCompanies(reviewer).includes(previous.company)) invalid('评审人必须与周报属于同一公司');
      if ((reviewer?.id ?? null) === previous.reviewer_id) return reportView(previous);
      const at = now();
      db.prepare("UPDATE weekly_reports SET reviewer_id=?,reviewer_name=?,score=NULL,review_comment='',reviewed_by=NULL,reviewed_name=NULL,reviewed_at=NULL,version=version+1,updated_at=? WHERE id=? AND version=?")
        .run(reviewer?.id ?? null, reviewer?.name ?? null, at, previous.id, input.version);
      audit('report', previous.id, user, 'reviewer-assigned', { previousReviewer: previous.reviewer_name, reviewer: reviewer?.name ?? null, previousScore: previous.score, previousComment: previous.review_comment }, at);
      return reportView(reportRow(previous.id));
    });
  }
  function reviewReport(id, input, claim) {
    fields(input, ['version', 'score', 'comment']);
    if (typeof input.score !== 'number' || !Number.isFinite(input.score) || input.score < 0 || input.score > 100) invalid('评分须为 0–100');
    const comment = text(input.comment, 4000);
    return transaction(() => {
      const user = actor(claim), previous = readReport(id, user); version(previous, input.version);
      if (!user.isSuperAdmin && previous.reviewer_id !== user.id) fail(403, 'FORBIDDEN', '只有指定评审人和超级管理员可评分');
      if (previous.status !== 'submitted') fail(409, 'REPORT_NOT_SUBMITTED', '请等待作者提交周报后再评分');
      const at = now();
      db.prepare('UPDATE weekly_reports SET score=?,review_comment=?,reviewed_by=?,reviewed_name=?,reviewed_at=?,version=version+1,updated_at=? WHERE id=? AND version=?')
        .run(input.score, comment, user.id, user.name, at, at, previous.id, input.version);
      audit('report', previous.id, user, 'report-reviewed', { previousScore: previous.score, previousComment: previous.review_comment, score: input.score, comment }, at);
      return reportView(reportRow(previous.id));
    });
  }
  function requestView(row) {
    return { id: row.id, applicantId: row.applicant_id, applicantName: row.applicant_name, company: row.company, category: row.category,
      quantity: row.quantity, purpose: row.purpose, equipmentId: row.equipment_id, equipmentName: row.equipment_name, equipmentSerial: row.equipment_serial,
      status: row.status, decisionComment: row.decision_comment, equipmentUpdated: Boolean(row.equipment_updated),
      version: row.version, createdAt: iso(row.created_at), updatedAt: iso(row.updated_at) };
  }
  function requestRow(id) {
    const row = db.prepare('SELECT * FROM equipment_requests WHERE id=?').get(identifier(id));
    if (!row) fail(404, 'REQUEST_NOT_FOUND', '找不到设备申请');
    return row;
  }
  function createRequest(input, claim) {
    fields(input, ['category', 'quantity', 'purpose', 'equipmentId']);
    if (!categories.has(input.category)) invalid('请选择设备类别');
    if (!Number.isSafeInteger(input.quantity) || input.quantity < 1 || input.quantity > 999) invalid('数量须为 1–999 的整数');
    const purpose = text(input.purpose, 4000, true), equipmentId = input.equipmentId ? identifier(input.equipmentId) : null;
    if (own(input, 'equipmentId') && input.equipmentId !== null && typeof input.equipmentId !== 'string') invalid('关联设备无效');
    if (equipmentId && input.quantity !== 1) invalid('关联单台已有设备时数量须为 1');
    return transaction(() => {
      const user = actor(claim);
      if (user.isSuperAdmin) fail(403, 'SUPERADMIN_REQUEST_NOT_REQUIRED', '超级管理员无需提交设备申请');
      if (!companies.has(user.company)) fail(403, 'COMPANY_REQUIRED', '提交申请前请先给自己分配公司');
      let equipment = null;
      if (equipmentId) {
        if (typeof validateEquipmentTarget !== 'function') fail(503, 'EQUIPMENT_UNAVAILABLE', '暂不能关联设备，请稍后重试');
        equipment = validateEquipmentTarget({ db, equipmentId, company: user.company, category: input.category, user });
        if (!equipment || equipment.id !== equipmentId) fail(404, 'EQUIPMENT_NOT_FOUND', '找不到可申请的同公司设备');
      }
      const id = randomUUID(), at = now();
      db.prepare(`INSERT INTO equipment_requests(id,applicant_id,applicant_name,company,category,quantity,purpose,equipment_id,equipment_name,equipment_serial,status,version,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,'pending',1,?,?)`).run(id, user.id, user.name, user.company, input.category, input.quantity, purpose, equipmentId, equipment?.name ?? null, equipment?.serialNumber ?? null, at, at);
      audit('request', id, user, 'request-created', { category: input.category, quantity: input.quantity, purpose, equipmentId }, at);
      return { id, submitted: true };
    });
  }
  function updateRequest(id, input, claim) {
    fields(input, ['version', 'status', 'comment']);
    if (!['approved', 'rejected', 'collected'].includes(input.status)) invalid('申请处理状态无效');
    const comment = text(input.comment, 4000);
    return transaction(() => {
      const user = actor(claim); superAdmin(user); const previous = requestRow(id); version(previous, input.version);
      if (previous.status === 'collected' && input.status !== 'collected') fail(409, 'REQUEST_LOCKED', '已领取申请不可回退状态');
      if (input.status === 'collected' && !['approved', 'collected'].includes(previous.status)) fail(409, 'REQUEST_NOT_APPROVED', '请先批准申请再登记领取');
      if (input.status === previous.status && comment === previous.decision_comment) return requestView(previous);
      const at = now(); let equipmentUpdated = previous.equipment_updated;
      if (input.status === 'collected' && previous.status !== 'collected' && previous.equipment_id && onCollectEquipment) {
        const result = onCollectEquipment({ db, request: requestView(previous), user, at });
        if (result?.then) throw new Error('Equipment collection hook must be synchronous');
        equipmentUpdated = 1;
      }
      db.prepare('UPDATE equipment_requests SET status=?,decision_comment=?,equipment_updated=?,version=version+1,updated_at=? WHERE id=? AND version=?')
        .run(input.status, comment, equipmentUpdated, at, previous.id, input.version);
      audit('request', previous.id, user, 'request-decided', { before: previous.status, after: input.status, previousComment: previous.decision_comment, comment, equipmentUpdated: Boolean(equipmentUpdated) }, at);
      return requestView(requestRow(previous.id));
    });
  }
  return {
    createReport, updateReport, assignReviewer, reviewReport, reportStatistics, createRequest, updateRequest,
    listReports(claim) { return transaction(() => { const user = actor(claim); return db.prepare('SELECT * FROM weekly_reports ORDER BY week_start DESC,created_at DESC').all().filter(row => readable(row, user)).map(reportView); }, false); },
    getReport(id, claim) { return transaction(() => { const user = actor(claim), row = readReport(id, user); return { report: reportView(row), history: history('report', row.id) }; }, false); },
    listRequests(claim) { return transaction(() => { const user = actor(claim); superAdmin(user); return db.prepare('SELECT * FROM equipment_requests ORDER BY created_at DESC,id').all().map(requestView); }, false); },
    getRequest(id, claim) { return transaction(() => { const user = actor(claim); superAdmin(user); const row = requestRow(id); return { request: requestView(row), history: history('request', row.id) }; }, false); },
    close() { db.close(); },
  };
}
