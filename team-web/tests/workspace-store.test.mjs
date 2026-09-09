import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { once } from 'node:events';
import { createWorkspaceStore } from '../server/workspace-store.mjs';
import { backupTeamDatabase } from '../../scripts/team-backup.mjs';

const author = { id: 'author', name: '作者', role: 'member', company: 'A公司' };
const reviewer = { id: 'reviewer', name: '评审人', role: 'member', company: 'A公司' };
const peer = { id: 'peer', name: '同公司其他员工', role: 'admin', company: 'A公司' };
const outsider = { id: 'outsider', name: '另一公司', role: 'member', company: 'B公司' };
const admin = { id: 'super', name: '超级管理员', role: 'admin', isSuperAdmin: true, company: 'A公司' };
const reportInput = () => ({ weekStart: '2026-09-07', todos: [{ text: '校准机械臂', completion: 80, unfinishedReason: '等待新夹爪', effect: '重复定位误差下降' }], nextPlan: '完成夹爪适配' });
const requestInput = () => ({ category: '机械臂', quantity: 1, purpose: '具身算法实验' });
function fixture(t, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'racktop-workspace-'));
  const dbPath = join(directory, 'team.sqlite');
  const members = new Map([author, reviewer, peer, outsider, admin].map(value => [value.id, { ...value }]));
  const store = createWorkspaceStore({ dbPath, resolveMember: id => members.get(id) ?? null, ...options });
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { store, dbPath, members };
}

test('weekly reports are persistent private records, including drafts, and forged claims never grant access', t => {
  const { store, dbPath, members } = fixture(t);
  const created = store.createReport(reportInput(), author);
  assert.equal(created.company, 'A公司'); assert.equal(created.status, 'draft'); assert.equal(created.version, 1);
  assert.deepEqual(store.listReports(author), [created]); assert.deepEqual(store.listReports(peer), []); assert.deepEqual(store.listReports(outsider), []);
  for (const user of [peer, outsider, { ...peer, isSuperAdmin: true }]) assert.throws(() => store.getReport(created.id, user), { status: 404 });
  assert.deepEqual(store.listReports(admin), [created]);
  assert.throws(() => store.createReport({ ...reportInput(), authorId: author.id }, peer), { status: 403 });
  assert.throws(() => store.createReport(reportInput(), author), { code: 'REPORT_EXISTS' });
  const reopened = createWorkspaceStore({ dbPath, resolveMember: id => members.get(id) }); t.after(() => reopened.close());
  assert.deepEqual(reopened.getReport(created.id, author).report, created);
  members.get(author.id).company = 'B公司';
  assert.deepEqual(store.listReports(author), []); assert.throws(() => store.getReport(created.id, author), { status: 404 });
  members.delete(author.id); assert.throws(() => store.listReports(author), { status: 401 });
});

test('only explicitly assigned same-company reviewers can read and score submitted reports', t => {
  const { store, members } = fixture(t);
  let report = store.createReport(reportInput(), author);
  assert.throws(() => store.assignReviewer(report.id, { version: 1, reviewerId: reviewer.id }, author), { status: 403 });
  assert.throws(() => store.assignReviewer(report.id, { version: 1, reviewerId: outsider.id }, admin), { status: 422 });
  assert.throws(() => store.assignReviewer(report.id, { version: 1, reviewerId: author.id }, admin), { status: 422 });
  report = store.assignReviewer(report.id, { version: 1, reviewerId: reviewer.id }, admin);
  assert.equal(store.listReports(reviewer)[0].id, report.id);
  assert.throws(() => store.reviewReport(report.id, { version: 2, score: 90, comment: '草稿不可评分' }, reviewer), { code: 'REPORT_NOT_SUBMITTED' });
  assert.throws(() => store.updateReport(report.id, { version: 2, nextPlan: '评审人篡改' }, reviewer), { status: 403 });
  report = store.updateReport(report.id, { version: 2, status: 'submitted' }, author);
  assert.throws(() => store.reviewReport(report.id, { version: 3, score: 100, comment: '自评' }, author), { status: 403 });
  assert.throws(() => store.reviewReport(report.id, { version: 3, score: 101, comment: '' }, reviewer), { status: 422 });
  report = store.reviewReport(report.id, { version: 3, score: 93.5, comment: '校准结果清楚' }, reviewer);
  assert.equal(store.getReport(report.id, author).report.score, 93.5);
  assert.throws(() => store.updateReport(report.id, { version: 4, nextPlan: '已评分后篡改' }, admin), { code: 'REPORT_LOCKED' });
  members.get(reviewer.id).company = 'B公司';
  assert.throws(() => store.getReport(report.id, reviewer), { status: 404 });
  assert.throws(() => store.reviewReport(report.id, { version: 4, score: 0, comment: '' }, reviewer), { status: 404 });
  report = store.assignReviewer(report.id, { version: 4, reviewerId: peer.id }, admin);
  assert.equal(report.score, null); assert.equal(report.reviewComment, '');
  assert.ok(store.getReport(report.id, admin).history.some(entry => entry.action === 'report-reviewed' && entry.details.score === 93.5));
  assert.throws(() => store.reviewReport(report.id, { version: 4, score: 90, comment: '' }, peer), { status: 409 });
});

test('super administrators create reports for any assigned company and drafts validate only on submission', t => {
  const { store, members } = fixture(t);
  members.get(admin.id).company = null;
  assert.throws(() => store.createReport(reportInput(), admin), { status: 403, code: 'SUPERADMIN_REPORT_NOT_REQUIRED' });
  const report = store.createReport({ authorId: outsider.id, weekStart: '2026-09-07', todos: [], nextPlan: '' }, admin);
  assert.equal(report.company, 'B公司'); assert.equal(report.authorName, outsider.name);
  assert.throws(() => store.updateReport(report.id, { version: 1, status: 'submitted' }, outsider), { status: 422 });
  assert.throws(() => store.updateReport(report.id, { version: 1, ...reportInput(), status: 'submitted' }, outsider), { status: 422 });
  const next = store.updateReport(report.id, { version: 1, todos: reportInput().todos, nextPlan: '新计划', status: 'submitted' }, outsider);
  assert.equal(next.version, 2);
  assert.equal(store.reviewReport(report.id, { version: 2, score: 88, comment: '跨公司超管评审' }, admin).score, 88);
  for (const bad of ['2026-02-30', 'bad']) assert.throws(() => store.createReport({ ...reportInput(), weekStart: bad }, author), { status: 422 });
  assert.throws(() => store.createReport({ ...reportInput(), company: 'B公司' }, author), { status: 422 });
});

test('any valid calendar date selects its Monday week, including month, year and leap-day boundaries', t => {
  const { store } = fixture(t);
  for (const [selected, monday] of [['2021-01-01', '2020-12-28'], ['2026-05-01', '2026-04-27'],
    ['2024-02-29', '2024-02-26'], ['2026-09-13', '2026-09-07']]) {
    const report = store.createReport({ ...reportInput(), weekStart: selected }, author);
    assert.equal(report.weekStart, monday);
    assert.throws(() => store.createReport({ ...reportInput(), weekStart: monday }, author), { status: 409, code: 'REPORT_EXISTS' });
  }
  for (const selected of ['2026-02-29', '2024-02-30', '2026-13-01', '2026-09-08T00:00:00Z', '2026-9-8', '0000-01-01', '9999-12-31', '', null]) {
    assert.throws(() => store.createReport({ ...reportInput(), weekStart: selected }, author), { status: 422 });
  }
});

function statisticsFixture(t, options = {}) {
  const result = fixture(t, { now: () => Date.parse('2026-09-09T04:00:00Z'), ...options });
  const users = Object.fromEntries([...result.members].map(([key, value]) => [key, { ...value, id: randomUUID() }]));
  result.members.clear(); Object.values(users).forEach(value => result.members.set(value.id, value));
  const db = new DatabaseSync(result.dbPath); t.after(() => db.close());
  db.exec('CREATE TABLE account_users(id TEXT PRIMARY KEY,name TEXT,company TEXT,created_at INTEGER,deleted_at INTEGER,is_super_admin INTEGER NOT NULL DEFAULT 0)');
  const addMember = (user, createdAt = '2026-01-01T00:00:00Z') => {
    result.members.set(user.id, user);
    db.prepare('INSERT INTO account_users VALUES(?,?,?,?,NULL,?)').run(user.id, user.name, user.company, Date.parse(createdAt), user.isSuperAdmin ? 1 : 0);
    return user;
  };
  Object.values(users).forEach(user => addMember(user));
  return { ...result, users, db, addMember };
}

test('superadmin statistics distinguish missing, draft, submitted and reviewed with explicit filtered averages', t => {
  const { store, users, members, db, addMember } = statisticsFixture(t);
  const submitted = store.createReport({ ...reportInput(), status: 'submitted', todos: [
    { text: '完成工作', completion: 100, unfinishedReason: '', effect: '' },
    { text: '未开始工作', completion: 0, unfinishedReason: '等待设备', effect: '' },
  ] }, users.author);
  store.assignReviewer(submitted.id, { version: 1, reviewerId: users.reviewer.id }, users.super);
  store.reviewReport(submitted.id, { version: 2, score: 0, comment: '' }, users.reviewer);
  store.createReport({ ...reportInput(), status: 'submitted', todos: [{ text: '实验', completion: 100, unfinishedReason: '', effect: '' }] }, users.outsider);
  store.createReport({ ...reportInput(), todos: [] }, users.peer);
  const formerMember = addMember({ id: randomUUID(), name: '历史超管', role: 'admin', company: 'C公司' });
  store.createReport({ ...reportInput(), todos: [] }, formerMember);
  members.get(formerMember.id).isSuperAdmin = true;
  db.prepare('UPDATE account_users SET is_super_admin=1 WHERE id=?').run(formerMember.id);
  const result = store.reportStatistics({ weekStart: '2026-09-11' }, users.super);
  assert.equal(result.weekStart, '2026-09-07'); assert.equal(result.weekEnd, '2026-09-13'); assert.equal(result.timezone, 'Asia/Shanghai');
  assert.deepEqual(result.summary, { expectedCount: 4, submittedCount: 2, unsubmittedCount: 2, reviewedCount: 1, averageCompletion: 75, averageScore: 0 });
  const row = result.rows.find(value => value.authorId === users.author.id);
  assert.deepEqual(row, { authorId: users.author.id, name: users.author.name, company: 'A公司', weekStart: '2026-09-07', weekEnd: '2026-09-13',
    status: 'reviewed', reportId: submitted.id, todoCount: 2, completedCount: 1, unfinishedCount: 1, averageCompletion: 50, score: 0, reviewerName: users.reviewer.name });
  for (const [user, status] of [[users.reviewer, 'missing'], [users.peer, 'draft'], [users.outsider, 'submitted']]) {
    assert.equal(result.rows.find(value => value.authorId === user.id).status, status);
  }
  assert.equal(result.rows.find(value => value.authorId === users.peer.id).averageCompletion, null);
  assert.equal(result.rows.some(value => value.authorId === users.super.id || value.authorId === formerMember.id), false);
  const company = store.reportStatistics({ company: 'A公司' }, users.super);
  assert.deepEqual(company.summary, { expectedCount: 3, submittedCount: 1, unsubmittedCount: 2, reviewedCount: 1, averageCompletion: 50, averageScore: 0 });
  assert.equal(store.reportStatistics({ memberId: users.author.id }, users.super).rows.length, 1);
  assert.deepEqual(store.reportStatistics({ memberId: users.super.id }, users.super).rows, []);
  assert.deepEqual(store.reportStatistics({ memberId: formerMember.id }, users.super).rows, []);
  const noMatch = store.reportStatistics({ memberId: users.author.id, company: 'B公司' }, users.super);
  assert.deepEqual(noMatch.summary, { expectedCount: 0, submittedCount: 0, unsubmittedCount: 0, reviewedCount: 0, averageCompletion: null, averageScore: null });
  for (const user of [users.author, users.reviewer, users.peer, { ...users.peer, isSuperAdmin: true }]) {
    assert.throws(() => store.reportStatistics({ memberId: 'invalid' }, user), { status: 403, code: 'SUPERADMIN_REQUIRED' });
  }
  assert.throws(() => store.reportStatistics({}, null), { status: 401 });
  for (const query of [{ extra: 'secret' }, { company: '' }, { company: 'D公司' }, { memberId: 'bad' }, { weekStart: '2026-02-30' }, { weekStart: '0000-01-01' }, { weekStart: '9999-12-31' }]) {
    assert.throws(() => store.reportStatistics(query, users.super), { status: 422 });
  }
});

test('statistics use Beijing week boundaries, registration cutoff and historical author/company snapshots', t => {
  let instant = Date.parse('2026-09-13T15:59:59.999Z');
  const { store, users, members, db, addMember } = statisticsFixture(t, { now: () => instant });
  const pending = addMember({ id: randomUUID(), name: '待分配', company: null, role: 'member' });
  const sunday = addMember({ id: randomUUID(), name: '周日新成员', company: 'A公司', role: 'member' }, '2026-09-13T15:59:59.999Z');
  const monday = addMember({ id: randomUUID(), name: '下周注册', company: 'B公司', role: 'member' }, '2026-09-13T16:00:00Z');
  const backfilled = addMember({ id: randomUUID(), name: '补写报告者', company: 'A公司', role: 'member' }, '2026-09-13T16:00:00Z');
  store.createReport(reportInput(), users.author);
  store.createReport(reportInput(), users.outsider);
  store.createReport({ ...reportInput(), authorId: backfilled.id }, users.super);
  // Soft-deleted identities remain only in actual report snapshots; reassignment never rewrites a report.
  db.prepare('UPDATE account_users SET name=?,company=NULL,deleted_at=? WHERE id=?').run('已删除成员', instant, users.author.id);
  members.delete(users.author.id);
  members.get(users.outsider.id).company = 'A公司';
  db.prepare("UPDATE account_users SET company='A公司' WHERE id=?").run(users.outsider.id);
  const rawBefore = db.prepare('SELECT * FROM weekly_reports ORDER BY id').all();
  const result = store.reportStatistics({}, users.super);
  assert.equal(result.weekStart, '2026-09-07'); assert.equal(result.weekEnd, '2026-09-13');
  assert.equal(result.summary.expectedCount, 7);
  assert.ok(result.rows.some(row => row.authorId === sunday.id));
  assert.equal(result.rows.some(row => row.authorId === monday.id), false);
  assert.equal(result.rows.find(row => row.authorId === users.author.id).name, users.author.name);
  assert.equal(result.rows.find(row => row.authorId === users.outsider.id).company, 'B公司');
  assert.deepEqual(store.reportStatistics({ company: 'unassigned' }, users.super).rows.map(row => row.authorId), [pending.id]);
  assert.ok(store.reportStatistics({ company: 'B公司' }, users.super).rows.some(row => row.authorId === users.outsider.id));
  instant++;
  const next = store.reportStatistics({}, users.super);
  assert.equal(next.weekStart, '2026-09-14'); assert.equal(next.weekEnd, '2026-09-20');
  assert.equal(next.rows.some(row => row.authorId === users.author.id), false, 'deleted authors do not acquire later missing reports');
  assert.ok(next.rows.some(row => row.authorId === monday.id));
  assert.deepEqual(db.prepare('SELECT * FROM weekly_reports ORDER BY id').all(), rawBefore, 'statistics never migrate or rewrite reports');
  assert.equal(store.reportStatistics({ weekStart: '2025-12-31' }, users.super).weekEnd, '2026-01-04');
  assert.equal(store.reportStatistics({ weekStart: '2024-02-29' }, users.super).weekEnd, '2024-03-03');
});

test('a failed statistics read rolls back its transaction and accepts the next read', t => {
  const { store, users, db } = statisticsFixture(t);
  db.exec('ALTER TABLE account_users RENAME TO temporarily_unavailable');
  assert.throws(() => store.reportStatistics({}, users.super), /no such table/);
  db.exec('ALTER TABLE temporarily_unavailable RENAME TO account_users');
  assert.equal(store.reportStatistics({}, users.super).summary.expectedCount, 4);
});

test('requests reveal only submission acknowledgement to ordinary employees and preserve immutable original contents', t => {
  const { store, members } = fixture(t);
  assert.throws(() => store.createRequest(requestInput(), admin), { status: 403, code: 'SUPERADMIN_REQUEST_NOT_REQUIRED' });
  const receipt = store.createRequest(requestInput(), author);
  assert.deepEqual(Object.keys(receipt).sort(), ['id', 'submitted']); assert.equal(receipt.submitted, true);
  for (const user of [author, peer, outsider]) {
    assert.throws(() => store.listRequests(user), { status: 403 });
    assert.throws(() => store.getRequest(receipt.id, user), { status: 403 });
    assert.throws(() => store.updateRequest(receipt.id, { version: 1, status: 'approved', comment: '' }, user), { status: 403 });
  }
  const first = store.getRequest(receipt.id, admin).request;
  assert.equal(first.company, 'A公司'); assert.equal(first.purpose, requestInput().purpose);
  assert.throws(() => store.updateRequest(receipt.id, { version: 1, status: 'collected', comment: '' }, admin), { code: 'REQUEST_NOT_APPROVED' });
  assert.throws(() => store.updateRequest(receipt.id, { version: 1, status: 'approved', purpose: '篡改', comment: '' }, admin), { status: 422 });
  store.updateRequest(receipt.id, { version: 1, status: 'approved', comment: '可领取' }, admin);
  const final = store.updateRequest(receipt.id, { version: 2, status: 'collected', comment: '现场交接完成' }, admin);
  assert.equal(final.purpose, first.purpose); assert.equal(final.equipmentUpdated, false);
  assert.throws(() => store.updateRequest(receipt.id, { version: 3, status: 'rejected', comment: '' }, admin), { code: 'REQUEST_LOCKED' });
  assert.equal(store.getRequest(receipt.id, admin).history.length, 3);
  members.get(author.id).company = null;
  assert.throws(() => store.createRequest(requestInput(), author), { status: 403, code: 'COMPANY_REQUIRED' });
});

test('linked-device validation and collection use one transaction, rolling equipment back if the request audit fails', t => {
  let updates = 0;
  const equipmentId = randomUUID();
  const { store, dbPath } = fixture(t, {
    validateEquipmentTarget({ db, equipmentId: id, company }) {
      const equipment = db.prepare('SELECT * FROM test_equipment WHERE id=? AND company=?').get(id, company);
      return equipment ? { ...equipment, serialNumber: '00000001' } : null;
    },
    onCollectEquipment({ db, request }) { updates++; db.prepare('UPDATE test_equipment SET holder=? WHERE id=? AND company=?').run(request.applicantId, request.equipmentId, request.company); },
  });
  const db = new DatabaseSync(dbPath); t.after(() => db.close());
  db.exec('CREATE TABLE test_equipment(id TEXT PRIMARY KEY,name TEXT,company TEXT,holder TEXT)');
  db.prepare('INSERT INTO test_equipment VALUES(?,?,?,?)').run(equipmentId, '机械臂设备', 'A公司', '');
  assert.throws(() => store.createRequest({ ...requestInput(), equipmentId }, outsider), { status: 404 });
  assert.throws(() => store.createRequest({ ...requestInput(), equipmentId, quantity: 2 }, author), { status: 422 });
  const receipt = store.createRequest({ ...requestInput(), equipmentId }, author);
  store.updateRequest(receipt.id, { version: 1, status: 'approved', comment: '' }, admin);
  db.exec("CREATE TRIGGER fail_request_audit BEFORE INSERT ON workspace_audit WHEN NEW.action='request-decided' BEGIN SELECT RAISE(ABORT,'audit failed'); END");
  assert.throws(() => store.updateRequest(receipt.id, { version: 2, status: 'collected', comment: '' }, admin), /audit failed/);
  assert.equal(db.prepare('SELECT holder FROM test_equipment').get().holder, '');
  assert.equal(store.getRequest(receipt.id, admin).request.status, 'approved');
  db.exec('DROP TRIGGER fail_request_audit');
  const collected = store.updateRequest(receipt.id, { version: 2, status: 'collected', comment: '领取' }, admin);
  assert.equal(collected.equipmentUpdated, true); assert.equal(db.prepare('SELECT holder FROM test_equipment').get().holder, author.id);
  store.updateRequest(receipt.id, { version: 3, status: 'collected', comment: '补充交接备注' }, admin);
  assert.equal(updates, 2);
});

test('independent concurrent report writers accept one version, and backup restores report/request audit', { timeout: 15000 }, async t => {
  const { store, dbPath, members } = fixture(t);
  const report = store.createReport(reportInput(), author);
  const gate = new SharedArrayBuffer(4);
  const source = `const {parentPort,workerData:d}=require('node:worker_threads');(async()=>{const {createWorkspaceStore}=await import(d.module);const s=createWorkspaceStore({dbPath:d.dbPath,resolveMember:id=>d.user});parentPort.postMessage('ready');Atomics.wait(new Int32Array(d.gate),0,0);try{parentPort.postMessage({version:s.updateReport(d.id,{version:1,nextPlan:d.plan},d.user).version});}catch(e){parentPort.postMessage({code:e.code});}finally{s.close();}})();`;
  const workers = ['甲计划', '乙计划'].map(plan => new Worker(source, { eval: true, workerData: { dbPath, user: author, gate, plan, id: report.id, module: new URL('../server/workspace-store.mjs', import.meta.url).href } }));
  t.after(() => Promise.all(workers.map(worker => worker.terminate())));
  await Promise.all(workers.map(worker => once(worker, 'message')));
  const replies = workers.map(worker => once(worker, 'message'));
  Atomics.store(new Int32Array(gate), 0, 1); Atomics.notify(new Int32Array(gate), 0);
  const results = (await Promise.all(replies)).map(([reply]) => reply);
  assert.equal(results.filter(value => value.version === 2).length, 1); assert.equal(results.filter(value => value.code === 'VERSION_CONFLICT').length, 1);
  const request = store.createRequest(requestInput(), author);
  await backupTeamDatabase(dbPath, `${dbPath}.backup`);
  const restored = createWorkspaceStore({ dbPath: `${dbPath}.backup`, resolveMember: id => members.get(id) }); t.after(() => restored.close());
  assert.deepEqual(restored.getReport(report.id, author), store.getReport(report.id, author));
  assert.deepEqual(restored.getRequest(request.id, admin), store.getRequest(request.id, admin));
});
