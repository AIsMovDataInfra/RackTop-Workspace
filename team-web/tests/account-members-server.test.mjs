import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { createTeamServer } from '../server/server.mjs';

const PUBLIC = 'https://members.example.test';
const BASE = Date.parse('2026-09-09T04:00:00Z');
const iso = minutes => new Date(BASE + minutes * 60_000).toISOString();
async function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'racktop-members-http-'));
  const distPath = join(directory, 'dist'); mkdirSync(distPath);
  writeFileSync(join(distPath, 'index.html'), '<!doctype html><title>Member integration fixture</title>');
  const password = randomBytes(24).toString('base64url'), bootstrapToken = randomBytes(32).toString('base64url');
  const app = createTeamServer({ mode: 'account', host: '127.0.0.1', port: 0, publicUrl: PUBLIC,
    dbPath: join(directory, 'team.sqlite'), distPath, bootstrapToken, nodeEnv: 'production', now: () => BASE });
  await app.auth.provisionSuperAdmin({ mode: 'create', password });
  const { port } = await app.start();
  t.after(async () => { await app.close(); rmSync(directory, { recursive: true, force: true }); });
  const call = (path, { method = 'GET', body, session, token, headers = {} } = {}) => new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const req = request({ host: '127.0.0.1', port, path, method, agent: false, headers: {
      host: new URL(PUBLIC).host, origin: PUBLIC,
      ...(data === undefined ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) }),
      ...(session ? { cookie: session.cookie, 'x-csrf-token': session.csrfToken } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers,
    } }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const bytes = Buffer.concat(chunks), text = bytes.toString(); let result;
        try { result = JSON.parse(text); } catch { result = text; }
        resolve({ status: res.statusCode, headers: res.headers, body: result, text, bytes });
      });
    });
    req.on('error', reject); req.end(data);
  });
  const sessionOf = response => ({ cookie: response.headers['set-cookie']?.[0]?.split(';')[0], csrfToken: response.body.csrfToken, user: response.body.user });
  const anonymous = async () => sessionOf(await call('/api/session'));
  async function login(username, supplied) {
    const response = await call('/api/auth/login', { method: 'POST', session: await anonymous(), body: { username, password: supplied } });
    return { ...response, session: sessionOf(response) };
  }
  async function register(username, extra = {}) {
    const response = await call('/api/auth/register', { method: 'POST', session: await anonymous(), body: { username, name: username, password: '密', ...extra } });
    assert.equal(response.status, 201, response.text); return sessionOf(response);
  }
  const admin = (await login('admin', password)).session;
  return { app, call, anonymous, sessionOf, login, register, admin, bootstrapToken };
}
const equipmentDraft = (extra = {}) => ({ name: '设备管理隐私验收', category: '摄像头模组', location: '上海', ...extra });
const resourceDraft = { company: '西浦', name: '预约隐私验收', cluster: '训练集群', gpuModel: 'A100', gpuCount: 1, notes: '已登录成员业务备注' };

test('browser and device organization switches isolate catalogs, reports and stale writes while legacy sessions keep the primary organization', async t => {
  const { app, call, admin, login } = await fixture(t);
  const added = await call('/api/admin/members', { method: 'POST', session: admin, body: { name: '跨组织成员', password: '密', companies: ['A公司', '西浦'] } });
  assert.equal(added.status, 201, added.text);
  let member = added.body.member;
  const session = (await login(member.name, '密')).session;
  const legacy = (await login(member.name, '密')).session;
  const device = (await call('/api/auth/device-login', { method: 'POST', body: { username: member.name, password: '密', deviceName: '组织切换测试' } })).body;
  const scoped = company => ({ 'x-racktop-company': encodeURIComponent(company) });
  for (const company of ['A公司', '西浦']) {
    assert.equal((await call('/api/equipment', { method: 'POST', session: admin, body: equipmentDraft({ company, name: company }) })).status, 201);
    assert.equal((await call('/api/resources', { method: 'POST', session: admin, body: { ...resourceDraft, company, name: company } })).status, 201);
  }
  const reportInput = { weekStart: '2026-09-07', todos: [], nextPlan: '' };
  const reportA = await call('/api/workspace/reports', { method: 'POST', session, headers: scoped('A公司'), body: reportInput });
  assert.equal(reportA.status, 201, reportA.text);
  const switched = await call('/api/auth/company', { method: 'POST', session, headers: scoped('A公司'), body: { company: '西浦' } });
  assert.equal(switched.status, 200, switched.text); assert.equal(switched.body.user.company, '西浦');
  assert.deepEqual(switched.body.user.companies, ['A公司', '西浦']);
  assert.equal(app.auth.getMemberIdentity(member.id).company, 'A公司', 'switching preserves the legacy primary');
  assert.equal((await call('/api/session', { session: legacy })).body.user.company, 'A公司');
  assert.equal((await call('/api/session', { token: device.token })).body.user.company, 'A公司');
  assert.equal((await call('/api/equipment', { session: legacy })).body.equipment[0].company, 'A公司');
  for (const headers of [{}, scoped('A公司'), { 'x-racktop-company': '%' }, { 'x-racktop-company': '%FF' }, scoped('D公司')]) {
    const stale = await call('/api/equipment', { method: 'POST', session, headers, body: equipmentDraft() });
    assert.equal(stale.status, 409, stale.text); assert.equal(stale.body.error.code, 'COMPANY_CHANGED');
  }
  for (const [path, key] of [['/api/equipment', 'equipment'], ['/api/resources', 'resources']]) {
    const result = await call(path, { session, headers: scoped('西浦') });
    assert.equal(result.status, 200, result.text); assert.deepEqual(result.body[key].map(row => row.company), ['西浦']);
  }
  assert.equal((await call(`/api/workspace/reports/${reportA.body.report.id}`, { session, headers: scoped('西浦') })).status, 404);
  const reportB = await call('/api/workspace/reports', { method: 'POST', session, headers: scoped('西浦'), body: reportInput });
  assert.equal(reportB.status, 201, reportB.text); assert.equal(reportB.body.report.company, '西浦');
  const statistics = await call(`/api/workspace/reports/statistics?weekStart=2026-09-07&memberId=${member.id}`, { session: admin });
  assert.equal(statistics.status, 200, statistics.text); assert.equal(statistics.body.rows.length, 2);
  assert.deepEqual(new Set(statistics.body.rows.map(row => row.reportId)), new Set([reportA.body.report.id, reportB.body.report.id]));
  assert.equal((await call('/api/auth/company', { method: 'POST', token: device.token, body: { company: '西浦' } })).status, 200);
  assert.equal((await call('/api/equipment', { token: device.token, headers: scoped('A公司') })).status, 409);
  assert.equal((await call('/api/equipment', { token: device.token, headers: scoped('西浦') })).status, 200);
  assert.equal((await call('/api/auth/company', { method: 'POST', session, body: { company: 'B公司' } })).status, 403);
  const revoked = await call(`/api/admin/members/${member.id}`, { method: 'PATCH', session: admin, body: { version: member.version, companies: ['A公司'] } });
  assert.equal(revoked.status, 200, revoked.text); member = revoked.body.member;
  for (const auth of [{ session }, { token: device.token }]) {
    assert.equal((await call('/api/equipment', { ...auth, headers: scoped('西浦') })).status, 409);
    assert.equal((await call('/api/session', auth)).body.user.company, 'A公司');
    assert.equal((await call('/api/auth/company', { method: 'POST', ...auth, body: { company: '西浦' } })).status, 403);
  }
  const unassigned = await call(`/api/admin/members/${member.id}`, { method: 'PATCH', session: admin, body: { version: member.version, companies: [] } });
  assert.equal(unassigned.status, 200, unassigned.text);
  assert.equal((await call('/api/equipment', { session, headers: scoped('') })).status, 403);
  assert.equal((await call('/api/equipment', { session: legacy })).status, 403);
  assert.equal((await call('/api/equipment', { session: admin, headers: scoped('') })).body.equipment.length, 2);
  assert.equal((await call('/api/auth/company', { method: 'POST', session: admin, body: { company: 'A公司' } })).status, 403);
});

test('non-primary membership permits equipment collection and reviewer assignment, and revocation removes both grants', async t => {
  const { call, admin, login } = await fixture(t);
  const add = async name => {
    const result = await call('/api/admin/members', { method: 'POST', session: admin, body: { name, password: '密', companies: ['A公司', '西浦'] } });
    assert.equal(result.status, 201, result.text);
    const session = (await login(name, '密')).session;
    assert.equal((await call('/api/auth/company', { method: 'POST', session, body: { company: '西浦' } })).status, 200);
    return { member: result.body.member, session };
  };
  const author = await add('双组织领用人'), reviewer = await add('双组织评审人');
  const headers = { 'x-racktop-company': encodeURIComponent('西浦') };
  for (const revoke of [false, true]) {
    const equipment = (await call('/api/equipment', { method: 'POST', session: author.session, headers, body: equipmentDraft() })).body.equipment;
    const requestInput = { category: equipment.category, quantity: 1, purpose: '非主组织领用', equipmentId: equipment.id };
    const created = await call('/api/workspace/requests', { method: 'POST', session: author.session, headers, body: requestInput });
    assert.equal(created.status, 201, created.text);
    const path = `/api/workspace/requests/${created.body.id}`;
    assert.equal((await call(path, { method: 'PATCH', session: admin, body: { version: 1, status: 'approved', comment: '' } })).status, 200);
    if (revoke) assert.equal((await call(`/api/admin/members/${author.member.id}`, { method: 'PATCH', session: admin, body: { version: author.member.version, companies: ['A公司'] } })).status, 200);
    const collected = await call(path, { method: 'PATCH', session: admin, body: { version: 2, status: 'collected', comment: '' } });
    assert.equal(collected.status, revoke ? 409 : 200, collected.text);
    if (revoke) assert.equal((await call(path, { session: admin })).body.request.status, 'approved');
  }
  const report = await call('/api/workspace/reports', { method: 'POST', session: admin,
    body: { authorId: reviewer.member.id, company: '西浦', weekStart: '2026-09-07', todos: [], nextPlan: '' } });
  assert.equal(report.status, 201, report.text);
  // Regrant the author's secondary membership, then use it as a reviewer grant.
  assert.equal((await call(`/api/admin/members/${author.member.id}`, { method: 'PATCH', session: admin, body: { version: author.member.version + 1, companies: ['A公司', '西浦'] } })).status, 200);
  assert.equal((await call('/api/auth/company', { method: 'POST', session: author.session, body: { company: '西浦' } })).status, 200);
  const path = `/api/workspace/reports/${report.body.report.id}`;
  const assigned = await call(`${path}/reviewer`, { method: 'POST', session: admin, body: { version: 1, reviewerId: author.member.id } });
  assert.equal(assigned.status, 200, assigned.text);
  assert.equal((await call(path, { session: author.session, headers })).status, 200);
  assert.equal((await call(`/api/admin/members/${author.member.id}`, { method: 'PATCH', session: admin, body: { version: author.member.version + 2, companies: ['A公司'] } })).status, 200);
  assert.equal((await call(path, { session: author.session, headers })).status, 409);
  assert.equal((await call(`${path}/reviewer`, { method: 'POST', session: admin, body: { version: 2, reviewerId: author.member.id } })).status, 422);
});

async function seedBusiness(call, admin) {
  const resource = await call('/api/resources', { method: 'POST', session: admin, body: resourceDraft });
  assert.equal(resource.status, 201, resource.text);
  const equipment = await call('/api/equipment', { method: 'POST', session: admin, body: equipmentDraft({ company: '西浦' }) });
  assert.equal(equipment.status, 201, equipment.text);
  const bytes = await sharp({ create: { width: 32, height: 24, channels: 3, background: '#405060' } }).jpeg().toBuffer();
  const photo = await call(`/api/equipment/${equipment.body.equipment.id}/photo`, { method: 'POST', session: admin,
    body: { version: 1, dataUrl: `data:image/jpeg;base64,${bytes.toString('base64')}` } });
  assert.equal(photo.status, 200, photo.text);
  return { resource: resource.body.resource, equipment: photo.body.equipment };
}

test('company assignment gates every business path and photo buffering; session, recovery and administrator APIs remain reachable', async t => {
  const { call, register, anonymous, admin, bootstrapToken } = await fixture(t);
  assert.equal(admin.user.isSuperAdmin, true); assert.equal(admin.user.company, null);
  const { resource, equipment } = await seedBusiness(call, admin);
  const pending = await register('待分配'), ordinaryAdmin = await register('旧资源管理员', { bootstrapToken });
  const guest = await anonymous();
  const pendingDevice = await call('/api/auth/device-login', { method: 'POST', body: { username: '待分配', password: '密', deviceName: '未分配公司的桌面端' } });
  assert.equal(pendingDevice.status, 200);
  for (const path of ['/api/resources', '/api/reservations', '/api/equipment', '/api/equipment/stats', equipment.photo.url]) {
    const denied = await call(path, { token: pendingDevice.body.token });
    assert.equal(denied.status, 403); assert.equal(denied.body.error.code, 'COMPANY_REQUIRED');
  }
  assert.equal(pending.user.company, null); assert.equal(ordinaryAdmin.user.role, 'admin'); assert.equal(ordinaryAdmin.user.isSuperAdmin, false);
  const businessReads = ['/api/resources', `/api/resources/${resource.id}`, '/api/reservations', '/api/reservations?mine=true',
    '/api/equipment', '/api/equipment/stats', `/api/equipment/${equipment.id}`, equipment.photo.url];
  for (const session of [pending, ordinaryAdmin]) {
    for (const path of businessReads) {
      const response = await call(path, { session });
      assert.equal(response.status, 403, path); assert.equal(response.body.error.code, 'COMPANY_REQUIRED');
      assert.equal(response.headers['cache-control'], 'no-store'); assert.equal(response.text.includes(equipment.name), false);
    }
    const changes = [['/api/resources/sync', 'POST', {}], ['/api/resources', 'POST', resourceDraft],
      ['/api/reservations', 'POST', {}], ['/api/equipment', 'POST', equipmentDraft()],
      [`/api/equipment/${equipment.id}`, 'PATCH', { version: 2, currentUser: '不能写入' }],
      [`/api/equipment/${equipment.id}/photo`, 'DELETE', { version: 2 }]];
    for (const [path, method, body] of changes) {
      const response = await call(path, { method, body, session }); assert.equal(response.status, 403); assert.equal(response.body.error.code, 'COMPANY_REQUIRED');
    }
    const oversized = await call(`/api/equipment/${equipment.id}/photo`, { method: 'POST', body: {}, session, headers: { 'content-length': 3 * 1024 * 1024 } });
    assert.equal(oversized.status, 403); assert.equal(oversized.body.error.code, 'COMPANY_REQUIRED', 'company check precedes buffering/body-size errors');
    assert.equal((await call('/api/session', { session })).status, 200);
    assert.equal((await call('/api/admin/members', { session })).status, 403);
    assert.equal((await call('/api/admin/members', { session })).body.error.code, 'SUPERADMIN_REQUIRED');
  }
  assert.equal((await call('/api/admin/members', { session: guest })).status, 401);
  assert.equal((await call('/api/auth/recovery-request', { method: 'POST', session: guest, body: { username: '待分配' } })).status, 200);
  const pendingProfile = (await call('/api/admin/members', { session: admin })).body.members.find(row => row.id === pending.user.id);
  const assigned = await call(`/api/admin/members/${pending.user.id}`, { method: 'PATCH', session: admin, body: { version: pendingProfile.version, company: 'A公司' } });
  assert.equal(assigned.status, 200, assigned.text);
  assert.equal((await call('/api/session', { session: pending })).body.user.company, 'A公司');
  assert.equal((await call('/api/resources', { token: pendingDevice.body.token })).status, 200, 'existing device sessions observe company assignment');
  for (const path of ['/api/resources', '/api/reservations', '/api/equipment', '/api/equipment/stats']) assert.equal((await call(path, { session: pending })).status, 200, path);
  for (const path of [`/api/equipment/${equipment.id}`, equipment.photo.url]) assert.equal((await call(path, { session: pending })).status, 404, 'Other company records are not accessible');
  assert.deepEqual((await call('/api/resources', { session: pending })).body.resources, []);
  const own = await call('/api/equipment', { method: 'POST', session: pending, body: equipmentDraft({ name: '已分配成员设备' }) });
  assert.equal(own.status, 201); assert.equal(own.body.equipment.company, 'A公司');
  assert.equal((await call('/api/equipment', { method: 'POST', session: pending, body: equipmentDraft({ company: 'B公司' }) })).status, 403);
  const changedPassword = await call('/api/auth/change-password', { method: 'POST', session: ordinaryAdmin, body: { oldPassword: '密', newPassword: '新' } });
  assert.equal(changedPassword.status, 200, 'unassigned users can still change their password');
});

test('equipment statistics HTTP scopes members and ordinary administrators while super administrators see every company', async t => {
  const { call, admin, login, register, bootstrapToken } = await fixture(t);
  const employee = await call('/api/admin/members', { method: 'POST', session: admin,
    body: { name: '统计成员', password: '密', company: 'A公司' } });
  assert.equal(employee.status, 201, employee.text);
  const member = (await login('统计成员', '密')).session;
  const ordinaryAdmin = await register('统计资源管理员', { bootstrapToken });
  assert.equal(ordinaryAdmin.user.role, 'admin'); assert.equal(ordinaryAdmin.user.isSuperAdmin, false);
  const assigned = await call(`/api/admin/members/${ordinaryAdmin.user.id}`, { method: 'PATCH', session: admin,
    body: { version: 1, company: 'B公司' } });
  assert.equal(assigned.status, 200, assigned.text);
  const a = await call('/api/equipment', { method: 'POST', session: member, body: equipmentDraft({ category: '机械臂' }) });
  assert.equal(a.status, 201, a.text);
  for (const [company, status] of [['B公司', 'maintenance'], ['C公司', 'retired']]) {
    const created = await call('/api/equipment', { method: 'POST', session: admin, body: equipmentDraft({ company, status, location: '太仓' }) });
    assert.equal(created.status, 201, created.text);
  }
  const statsFor = async session => {
    const response = await call('/api/equipment/stats', { session });
    assert.equal(response.status, 200, response.text); return response.body.stats;
  };
  const own = await statsFor(member), managed = await statsFor(ordinaryAdmin), all = await statsFor(admin);
  assert.equal(own.total, 1); assert.deepEqual(own.companies, [{ company: 'A公司', count: 1 }]);
  assert.deepEqual(own.categories, [{ category: '机械臂', count: 1 }]); assert.deepEqual(own.locations, [{ location: '上海', count: 1 }]);
  assert.equal(managed.total, 1); assert.deepEqual(managed.companies, [{ company: 'B公司', count: 1 }]);
  assert.deepEqual(managed.statuses, { available: 0, in_use: 0, maintenance: 1, retired: 0 });
  assert.equal(all.total, 3); assert.deepEqual(all.companies, [{ company: 'A公司', count: 1 }, { company: 'B公司', count: 1 }, { company: 'C公司', count: 1 }]);
  assert.deepEqual(all.statuses, { available: 1, in_use: 0, maintenance: 1, retired: 1 });
  const moved = await call(`/api/equipment/${a.body.equipment.id}`, { method: 'PATCH', session: admin,
    body: { version: 1, company: 'B公司', status: 'in_use' } });
  assert.equal(moved.status, 200, moved.text);
  assert.equal((await statsFor(member)).total, 0);
  assert.equal((await statsFor(ordinaryAdmin)).total, 2);
  assert.equal((await statsFor(admin)).total, 3);
});

test('real HTTP member administration protects the directory, recovers access and retains reservation/equipment history after deletion', async t => {
  const { call, register, anonymous, login, admin } = await fixture(t);
  const created = await call('/api/admin/members', { method: 'POST', session: admin, body: { username: '短', name: '设备使用者', password: '密', company: '西浦' } });
  assert.equal(created.status, 201, created.text);
  const member = created.body.member, employee = (await login('短', '密')).session;
  const { resource } = await seedBusiness(call, admin);
  const equipment = (await call('/api/equipment', { method: 'POST', session: employee, body: equipmentDraft({ name: '员工登记设备', responsiblePerson: '设备使用者' }) })).body.equipment;
  const reserved = await call('/api/reservations', { method: 'POST', session: employee, body: {
    resourceId: resource.id, scope: 'machine', gpuIndices: [], startAt: iso(10), endAt: iso(70), purpose: '保留预约历史',
  } });
  assert.equal(reserved.status, 201, reserved.text);
  const reservation = reserved.body.reservation;
  const beforeEquipment = (await call(`/api/equipment/${equipment.id}`, { session: admin })).body;
  const beforeReservation = (await call(`/api/reservations/${reservation.id}`, { session: admin })).body;
  const directory = await call('/api/admin/members', { session: admin });
  for (const row of directory.body.members) assert.deepEqual(Object.keys(row).sort(), ['id','username','name','role','isSuperAdmin','company','companies','version','createdAt','recoveryRequestedAt','avatar'].sort());
  assert.equal(directory.headers['cache-control'], 'no-store');
  const denied = await call('/api/admin/members', { session: employee });
  assert.equal(denied.status, 403); assert.equal(denied.text.includes('设备使用者'), false);
  assert.equal((await call('/api/admin/members', { method: 'POST', session: employee, body: { username: '冒充', name: '冒充', password: '密', company: '西浦' } })).status, 403);
  assert.equal((await call(`/api/admin/members/${member.id}`, { method: 'DELETE', session: { ...admin, csrfToken: 'bad' }, body: { version: member.version } })).status, 403);
  const grant = await call('/api/auth/device-login', { method: 'POST', body: { username: '短', password: '密', deviceName: '员工测试设备' } });
  assert.equal(grant.status, 200);
  const visitor = await anonymous();
  const known = await call('/api/auth/recovery-request', { method: 'POST', session: visitor, body: { username: '短' } });
  const absent = await call('/api/auth/recovery-request', { method: 'POST', session: visitor, body: { username: '并不存在' } });
  assert.equal(known.status, 200); assert.equal(absent.status, 200); assert.deepEqual(known.body, absent.body);
  const requested = (await call('/api/admin/members', { session: admin })).body.members.find(row => row.id === member.id);
  assert.ok(requested.recoveryRequestedAt);
  const reset = await call(`/api/admin/members/${member.id}/reset-password`, { method: 'POST', session: admin, body: { version: requested.version, newPassword: '新' } });
  assert.equal(reset.status, 200, reset.text); assert.equal(reset.body.member.recoveryRequestedAt, null);
  assert.equal((await call('/api/equipment', { session: employee })).status, 401);
  assert.equal((await call('/api/resources', { token: grant.body.token })).status, 401);
  assert.equal((await login('短', '密')).status, 401);
  const renewed = await login('短', '新'); assert.equal(renewed.status, 200);
  const deleted = await call(`/api/admin/members/${member.id}`, { method: 'DELETE', session: admin, body: { version: reset.body.member.version } });
  assert.equal(deleted.status, 200, deleted.text);
  assert.equal((await call('/api/equipment', { session: renewed.session })).status, 401);
  assert.equal((await login('短', '新')).status, 401);
  assert.deepEqual((await call(`/api/equipment/${equipment.id}`, { session: admin })).body, beforeEquipment);
  assert.deepEqual((await call(`/api/reservations/${reservation.id}`, { session: admin })).body, beforeReservation);
  assert.equal((await call('/api/admin/members', { session: admin })).body.members.some(row => row.id === member.id), false);
  const replacement = await call('/api/admin/members', { method: 'POST', session: admin, body: { username: '短', name: '设备使用者', password: '新', company: '西浦' } });
  assert.equal(replacement.status, 201); assert.notEqual(replacement.body.member.id, member.id);
  const newSession = (await login('短', '新')).session;
  assert.equal((await call(`/api/reservations/${reservation.id}/cancel`, { method: 'POST', session: newSession, body: { version: reservation.version } })).status, 403, 'same username must not inherit old UUID ownership');
  const selfRegister = await call('/api/auth/register', { method: 'POST', session: await anonymous(), body: { username: '自选公司', name: '自选公司', password: '密', company: '西浦' } });
  assert.equal(selfRegister.status, 422, 'self registration cannot assign company');
});

test('company isolation hides resources, reservations, equipment, photos and mutations from other companies immediately', async t => {
  const { call, admin, login } = await fixture(t);
  const add = async (name, company) => {
    const result = await call('/api/admin/members', { method: 'POST', session: admin, body: { name, password: '密', company } });
    assert.equal(result.status, 201, result.text);
    return { member: result.body.member, session: (await login(name, '密')).session };
  };
  const a = await add('甲成员', 'A公司'), b = await add('乙成员', 'B公司');
  const resourceA = (await call('/api/resources', { method: 'POST', session: admin, body: { ...resourceDraft, company: 'A公司' } })).body.resource;
  const resourceB = await call('/api/resources', { method: 'POST', session: admin, body: { ...resourceDraft, company: 'B公司' } });
  assert.equal(resourceB.status, 201, 'Different companies may use identical resource names');
  const reservation = await call('/api/reservations', { method: 'POST', session: a.session, body: { resourceId: resourceA.id, scope: 'machine', gpuIndices: [], startAt: iso(10), endAt: iso(70), purpose: '甲公司的计划' } });
  assert.equal(reservation.status, 201, reservation.text);
  const created = await call('/api/equipment', { method: 'POST', session: a.session, body: equipmentDraft({ company: 'A公司', notes: '甲公司的旧备注' }) });
  assert.equal(created.status, 201, created.text);
  const equipment = created.body.equipment;
  const jpeg = await sharp({ create: { width: 16, height: 16, channels: 3, background: '#ffffff' } }).jpeg().toBuffer();
  const uploaded = await call(`/api/equipment/${equipment.id}/photo`, { method: 'POST', session: a.session, body: { version: 1, dataUrl: `data:image/jpeg;base64,${jpeg.toString('base64')}` } });
  assert.equal(uploaded.status, 200, uploaded.text);
  assert.deepEqual((await call('/api/equipment', { session: b.session })).body.equipment, []);
  assert.deepEqual((await call('/api/reservations', { session: b.session })).body.reservations, []);
  assert.equal((await call('/api/resources', { session: b.session })).body.resources[0].company, 'B公司');
  for (const path of [`/api/equipment/${equipment.id}`, `/api/equipment/${equipment.id}/photo`, `/api/reservations/${reservation.body.reservation.id}`]) {
    const response = await call(path, { session: b.session });
    assert.equal(response.status, 404, path); assert.equal(response.text.includes('甲公司的计划'), false);
  }
  for (const [path, body, method] of [
    [`/api/equipment/${equipment.id}`, { version: 2, currentUser: '伪造领用' }, 'PATCH'],
    [`/api/equipment/${equipment.id}/photo`, { version: 2 }, 'DELETE'],
    ['/api/reservations', { resourceId: resourceA.id, scope: 'machine', gpuIndices: [], startAt: iso(80), endAt: iso(90), purpose: '跨公司' }, 'POST'],
  ]) assert.equal((await call(path, { method, session: b.session, body })).status, 404, path);
  const move = await call(`/api/equipment/${equipment.id}`, { method: 'PATCH', session: admin, body: { version: 2, company: 'B公司', notes: '乙公司的新备注' } });
  assert.equal(move.status, 200, move.text); assert.equal(move.body.equipment.serialNumber, equipment.serialNumber);
  assert.equal((await call(`/api/equipment/${equipment.id}/photo`, { session: a.session })).status, 404);
  assert.equal((await call(`/api/equipment/${equipment.id}/photo`, { session: b.session })).status, 200);
  const transferred = await call(`/api/equipment/${equipment.id}`, { session: b.session });
  assert.deepEqual(transferred.body.history, []);
  assert.equal(transferred.text.includes('甲公司的旧备注'), false);
  assert.equal((await call(`/api/equipment/${equipment.id}`, { session: admin })).text.includes('甲公司的旧备注'), true);
  assert.equal((await call(`/api/equipment/${equipment.id}`, { method: 'PATCH', session: b.session, body: { version: 3, company: 'B公司' } })).status, 200);
  assert.equal((await call(`/api/equipment/${equipment.id}`, { method: 'PATCH', session: b.session, body: { version: 3, company: 'A公司' } })).status, 403);
  const change = await call(`/api/admin/members/${a.member.id}`, { method: 'PATCH', session: admin, body: { version: a.member.version, company: 'B公司' } });
  assert.equal(change.status, 200, change.text);
  assert.equal((await call(`/api/reservations/${reservation.body.reservation.id}`, { session: a.session })).status, 404, 'Existing session immediately loses old-company access');
  assert.equal((await call('/api/resources', { session: a.session })).body.resources[0].company, 'B公司');
  const resourceMove = await call(`/api/resources/${resourceA.id}`, { method: 'PATCH', session: admin, body: { company: 'B公司', companyVersion: resourceA.companyVersion } });
  assert.equal(resourceMove.status, 409, 'Future reservations prevent a cross-company resource move');
});

test('workspace HTTP saves private requests and approved collection atomically updates the actual equipment ledger', async t => {
  const { call, admin, login } = await fixture(t);
  const employee = await call('/api/admin/members', { method: 'POST', session: admin, body: { name: '领用成员', password: '密', company: 'A公司' } });
  assert.equal(employee.status, 201, employee.text);
  const session = (await login('领用成员', '密')).session;
  const equipment = (await call('/api/equipment', { method: 'POST', session, body: equipmentDraft({ company: 'A公司' }) })).body.equipment;
  const result = await call('/api/workspace/requests', { method: 'POST', session, body: { category: equipment.category, quantity: 1, purpose: '测试设备领取', equipmentId: equipment.id } });
  assert.equal(result.status, 201, result.text); assert.deepEqual(Object.keys(result.body).sort(), ['id','submitted']);
  const id = result.body.id;
  for (const path of ['/api/workspace/requests', `/api/workspace/requests/${id}`]) assert.equal((await call(path, { session })).status, 403);
  const approved = await call(`/api/workspace/requests/${id}`, { method: 'PATCH', session: admin, body: { version: 1, status: 'approved', comment: '已批准' } });
  assert.equal(approved.status, 200, approved.text);
  const collected = await call(`/api/workspace/requests/${id}`, { method: 'PATCH', session: admin, body: { version: 2, status: 'collected', comment: '当面交付' } });
  assert.equal(collected.status, 200, collected.text); assert.equal(collected.body.request.equipmentUpdated, true);
  const updated = (await call(`/api/equipment/${equipment.id}`, { session })).body;
  assert.equal(updated.equipment.currentUser, '领用成员'); assert.equal(updated.equipment.status, 'in_use');
  assert.equal(updated.equipment.version, 2); assert.equal(updated.history[0].changes.length, 2);
  const duplicate = await call(`/api/workspace/requests/${id}`, { method: 'PATCH', session: admin, body: { version: 2, status: 'collected', comment: '重试' } });
  assert.equal(duplicate.status, 409);
  assert.equal((await call(`/api/equipment/${equipment.id}`, { session })).body.equipment.version, 2);
  const report = await call('/api/workspace/reports', { method: 'POST', session, body: { weekStart: '2026-09-07', todos: [{ text: '完成接线', completion: 80, unfinishedReason: '待校准', effect: '已联调' }], nextPlan: '完成校准', status: 'submitted' } });
  assert.equal(report.status, 201, report.text);
  assert.equal((await call(`/api/workspace/reports/${report.body.report.id}`, { session })).status, 200);
  assert.equal((await call('/api/workspace/reports', { session })).body.reports.length, 1);
});

test('weekly statistics HTTP protects the full roster and retains deleted authors without exposing account secrets', async t => {
  const { call, admin, login, register, anonymous, bootstrapToken } = await fixture(t);
  const add = async name => {
    const result = await call('/api/admin/members', { method: 'POST', session: admin, body: { name, password: '密', company: 'A公司' } });
    assert.equal(result.status, 201, result.text);
    return { member: result.body.member, session: (await login(name, '密')).session };
  };
  const author = await add('周报作者'), reviewer = await add('指定评审人');
  const ordinaryAdmin = await register('资源管理员', { bootstrapToken });
  assert.equal(ordinaryAdmin.user.role, 'admin'); assert.equal(ordinaryAdmin.user.isSuperAdmin, false);
  const assigned = await call(`/api/admin/members/${ordinaryAdmin.user.id}`, { method: 'PATCH', session: admin, body: { version: 1, company: 'B公司' } });
  assert.equal(assigned.status, 200, assigned.text);
  const pending = await register('尚未分配');
  const reportInput = { weekStart: '2026-09-09', todos: [{ text: '机械臂联调', completion: 100, unfinishedReason: '', effect: '调试完成' }], nextPlan: '回归测试', status: 'submitted' };
  const created = await call('/api/workspace/reports', { method: 'POST', session: author.session, body: reportInput });
  assert.equal(created.status, 201, created.text); assert.equal(created.body.report.weekStart, '2026-09-07');
  assert.equal((await call('/api/workspace/reports', { method: 'POST', session: author.session, body: { ...reportInput, weekStart: '2026-09-13' } })).status, 409);
  const id = created.body.report.id;
  assert.equal((await call(`/api/workspace/reports/${id}/reviewer`, { method: 'POST', session: admin, body: { version: 1, reviewerId: reviewer.member.id } })).status, 200);
  assert.equal((await call(`/api/workspace/reports/${id}/review`, { method: 'POST', session: reviewer.session, body: { version: 2, score: 0, comment: '人工评分' } })).status, 200);
  const path = '/api/workspace/reports/statistics';
  assert.equal((await call(path, { session: await anonymous() })).status, 401);
  for (const session of [author.session, reviewer.session, ordinaryAdmin]) {
    for (const query of ['', '?company=A%E5%85%AC%E5%8F%B8', `?memberId=${session.user.id}`, '?secret=1&weekStart=invalid']) {
      const result = await call(`${path}${query}`, { session });
      assert.equal(result.status, 403, result.text); assert.equal(result.body.error.code, 'SUPERADMIN_REQUIRED');
      assert.equal(result.text.includes('周报作者'), false);
    }
  }
  assert.equal((await call(path, { session: pending })).status, 403);
  const result = await call(`${path}?weekStart=2026-09-10`, { session: admin });
  assert.equal(result.status, 200, result.text); assert.equal(result.headers['cache-control'], 'no-store');
  assert.deepEqual(result.body.summary, { expectedCount: 4, submittedCount: 1, unsubmittedCount: 3, reviewedCount: 1, averageCompletion: 100, averageScore: 0 });
  assert.equal(result.body.rows.some(row => row.authorId === admin.user.id), false);
  assert.equal(result.body.rows.find(row => row.authorId === author.member.id).reviewerName, '指定评审人');
  assert.deepEqual(Object.keys(result.body.rows[0]).sort(), ['authorId', 'name', 'company', 'weekStart', 'weekEnd', 'status', 'reportId', 'todoCount', 'completedCount', 'unfinishedCount', 'averageCompletion', 'score', 'reviewerName'].sort());
  for (const query of ['?unknown=x', '?weekStart=2026-09-07&weekStart=2026-09-14', '?company=A%E5%85%AC%E5%8F%B8&company=B%E5%85%AC%E5%8F%B8', '?memberId=bad', '?weekStart=', '?company=']) {
    assert.equal((await call(`${path}${query}`, { session: admin })).status, 422, query);
  }
  assert.equal((await call(path, { method: 'POST', body: {}, session: admin })).status, 405);
  assert.equal((await call('/api/workspace/reports?weekStart=2026-09-07', { session: admin })).status, 422, 'other workspace routes still reject queries');
  const company = await call(`${path}?company=${encodeURIComponent('A公司')}&memberId=${author.member.id}`, { session: admin });
  assert.equal(company.body.rows.length, 1); assert.equal(company.body.rows[0].score, 0);
  const unassigned = await call(`${path}?company=unassigned`, { session: admin });
  assert.equal(unassigned.body.rows.length, 1); assert.ok(unassigned.body.rows.every(row => row.company === null));
  const earlier = await call(`${path}?weekStart=2026-08-31`, { session: admin });
  assert.equal(earlier.body.rows.length, 0, 'accounts registered later do not acquire missing reports');
  const removed = await call(`/api/admin/members/${author.member.id}`, { method: 'DELETE', session: admin, body: { version: author.member.version } });
  assert.equal(removed.status, 200, removed.text);
  assert.equal((await call(path, { session: author.session })).status, 401, 'deleted sessions cannot access statistics');
  const historical = await call(`${path}?memberId=${author.member.id}`, { session: admin });
  assert.equal(historical.body.rows[0].name, '周报作者'); assert.equal(historical.body.rows[0].company, 'A公司');
  assert.equal(historical.body.summary.reviewedCount, 1); assert.equal(historical.body.summary.expectedCount, 1);
  assert.equal((await call(`${path}?weekStart=2026-09-14&memberId=${author.member.id}`, { session: admin })).body.rows.length, 0);
});
