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
const resourceDraft = { name: '预约隐私验收', cluster: '训练集群', gpuModel: 'A100', gpuCount: 1, notes: '已登录成员业务备注' };

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
  for (const path of ['/api/resources', '/api/reservations', '/api/equipment', equipment.photo.url]) {
    const denied = await call(path, { token: pendingDevice.body.token });
    assert.equal(denied.status, 403); assert.equal(denied.body.error.code, 'COMPANY_REQUIRED');
  }
  assert.equal(pending.user.company, null); assert.equal(ordinaryAdmin.user.role, 'admin'); assert.equal(ordinaryAdmin.user.isSuperAdmin, false);
  const businessReads = ['/api/resources', `/api/resources/${resource.id}`, '/api/reservations', '/api/reservations?mine=true',
    '/api/equipment', `/api/equipment/${equipment.id}`, equipment.photo.url];
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
  for (const path of ['/api/resources', '/api/reservations', '/api/equipment', `/api/equipment/${equipment.id}`, equipment.photo.url]) assert.equal((await call(path, { session: pending })).status, 200, path);
  const own = await call('/api/equipment', { method: 'POST', session: pending, body: equipmentDraft({ name: '已分配成员设备' }) });
  assert.equal(own.status, 201); assert.equal(own.body.equipment.company, 'A公司');
  assert.equal((await call('/api/equipment', { method: 'POST', session: pending, body: equipmentDraft({ company: 'B公司' }) })).status, 403);
  const changedPassword = await call('/api/auth/change-password', { method: 'POST', session: ordinaryAdmin, body: { oldPassword: '密', newPassword: '新' } });
  assert.equal(changedPassword.status, 200, 'unassigned users can still change their password');
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
  for (const row of directory.body.members) assert.deepEqual(Object.keys(row).sort(), ['id','username','name','role','isSuperAdmin','company','version','createdAt','recoveryRequestedAt'].sort());
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
  const replacement = await call('/api/admin/members', { method: 'POST', session: admin, body: { username: '短', name: '设备使用者', password: '新', company: 'B公司' } });
  assert.equal(replacement.status, 201); assert.notEqual(replacement.body.member.id, member.id);
  const newSession = (await login('短', '新')).session;
  assert.equal((await call(`/api/reservations/${reservation.id}/cancel`, { method: 'POST', session: newSession, body: { version: reservation.version } })).status, 403, 'same username must not inherit old UUID ownership');
  const selfRegister = await call('/api/auth/register', { method: 'POST', session: await anonymous(), body: { username: '自选公司', name: '自选公司', password: '密', company: '西浦' } });
  assert.equal(selfRegister.status, 422, 'self registration cannot assign company');
});
