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
  const report = store.createReport({ authorId: outsider.id, weekStart: '2026-09-07', todos: [], nextPlan: '' }, admin);
  assert.equal(report.company, 'B公司'); assert.equal(report.authorName, outsider.name);
  assert.throws(() => store.updateReport(report.id, { version: 1, status: 'submitted' }, outsider), { status: 422 });
  assert.throws(() => store.updateReport(report.id, { version: 1, ...reportInput(), status: 'submitted' }, outsider), { status: 422 });
  const next = store.updateReport(report.id, { version: 1, todos: reportInput().todos, nextPlan: '新计划', status: 'submitted' }, outsider);
  assert.equal(next.version, 2);
  assert.equal(store.reviewReport(report.id, { version: 2, score: 88, comment: '跨公司超管评审' }, admin).score, 88);
  for (const bad of ['2026-09-08', '2026-02-30', 'bad']) assert.throws(() => store.createReport({ ...reportInput(), weekStart: bad }, author), { status: 422 });
  assert.throws(() => store.createReport({ ...reportInput(), company: 'B公司' }, author), { status: 422 });
});

test('requests reveal only submission acknowledgement to ordinary employees and preserve immutable original contents', t => {
  const { store, members } = fixture(t);
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
