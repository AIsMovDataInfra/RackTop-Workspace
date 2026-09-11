import { assignFixtureCompany } from './helpers/account-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTeamServer } from '../server/server.mjs';

const PUBLIC = 'https://equipment.example.test';
const draft = (extra = {}) => ({ name: '设备', category: '台式主机', location: '上海', ...extra });
async function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'racktop-equipment-http-'));
  const distPath = join(directory, 'dist'); mkdirSync(distPath);
  writeFileSync(join(distPath, 'index.html'), '<!doctype html><title>Equipment application</title>');
  const config = { mode: 'account', host: '127.0.0.1', port: 0, publicUrl: PUBLIC,
    dbPath: join(directory, 'team.sqlite'), distPath, bootstrapToken: randomBytes(32).toString('base64url'), nodeEnv: 'production', trustProxy: true };
  let app = createTeamServer(config), port = (await app.start()).port;
  t.after(async () => { await app.close(); rmSync(directory, { recursive: true, force: true }); });
  async function call(path, { method = 'GET', body, session, headers = {} } = {}) {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const values = { host: new URL(PUBLIC).host,
      ...(data === undefined ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) }),
      ...(['POST', 'PATCH', 'PUT', 'DELETE'].includes(method) ? { origin: PUBLIC } : {}),
      ...(session ? { cookie: session.cookie, 'x-csrf-token': session.csrfToken } : {}), ...headers };
    return new Promise((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port, path, method, headers: Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined)) }, res => {
        const chunks = []; res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8'); let payload;
          try { payload = JSON.parse(text); } catch { payload = text; }
          resolve({ status: res.statusCode, headers: res.headers, body: payload, text });
        });
      });
      req.on('error', reject); req.end(data);
    });
  }
  async function register(username) {
    const anonymous = await call('/api/session');
    const initial = { cookie: anonymous.headers['set-cookie'][0].split(';')[0], csrfToken: anonymous.body.csrfToken };
    const response = await call('/api/auth/register', { method: 'POST', session: initial,
      body: { username, name: username, password: 'equipment HTTP test password' } });
    assert.equal(response.status, 201, response.text);
    response.body.user = assignFixtureCompany(config.dbPath, response.body.user);
    return { cookie: response.headers['set-cookie'][0].split(';')[0], csrfToken: response.body.csrfToken, user: response.body.user };
  }
  return { call, register, async restart() { await app.close(); app = createTeamServer(config); port = (await app.start()).port; } };
}

test('equipment requires membership for reading and uses authenticated account attribution', async t => {
  const { call, register } = await fixture(t);
  const empty = await call('/api/equipment');
  assert.equal(empty.status, 401); assert.equal(empty.headers['set-cookie'], undefined);
  const first = await register('first-member'), second = await register('second-member');
  assert.equal(first.user.role, 'member');
  assert.deepEqual((await call('/api/equipment', { session: first })).body, { equipment: [] });
  const created = await call('/api/equipment', { method: 'POST', session: first,
    body: draft({ name: ' 工作站 ', responsiblePerson: '使用负责人', notes: '<script>alert("plain text")</script>' }) });
  assert.equal(created.status, 201, created.text);
  const equipment = created.body.equipment;
  const changed = await call(`/api/equipment/${equipment.id}`, { method: 'PATCH', session: second, body: { version: 1, status: 'in_use' } });
  assert.equal(changed.status, 200, changed.text);
  assert.equal((await call(`/api/equipment/${equipment.id}`)).status, 401);
  const detail = await call(`/api/equipment/${equipment.id}`, { session: first }), listed = await call('/api/equipment', { session: second });
  assert.equal(detail.status, 200); assert.equal(detail.headers['cache-control'], 'no-store'); assert.equal(detail.headers['set-cookie'], undefined);
  assert.equal(detail.body.equipment.notes, '<script>alert("plain text")</script>');
  assert.equal(detail.body.equipment.responsiblePerson, '使用负责人'); assert.equal(detail.body.equipment.location, '上海');
  assert.match(detail.body.equipment.serialNumber, /^[0-9]{8}$/);
  assert.equal(detail.body.history[0].actorName, second.user.name); assert.equal(detail.body.history[1].actorName, first.user.name);
  assert.deepEqual(listed.body.equipment, [detail.body.equipment]);
  for (const id of [first.user.id, second.user.id]) assert.equal(detail.text.includes(id), false);
  assert.equal((await call(`/equipment/${equipment.id}`)).status, 200);
});

test('anonymous equipment writes, wrong CSRF/origin/host and invalid bearer fail without changing reservation permissions', async t => {
  const { call, register } = await fixture(t);
  const member = await register('ordinary-member');
  const payload = draft({ name: '服务器' });
  assert.equal((await call('/api/equipment', { method: 'POST', body: payload })).status, 401);
  for (const headers of [{ 'x-csrf-token': undefined }, { 'x-csrf-token': 'incorrect' }, { origin: undefined }, { origin: 'https://attacker.example' }, { host: 'attacker.example' }]) {
    assert.equal((await call('/api/equipment', { method: 'POST', session: member, body: payload, headers })).status, 403);
  }
  assert.equal((await call('/api/equipment', { headers: { authorization: 'Bearer invalid' } })).status, 401);
  assert.equal((await call('/api/resources', { method: 'POST', session: member, body: { cluster: 'cluster', name: 'GPU', gpuCount: 1, gpuModel: 'A100' } })).status, 403);
  assert.deepEqual((await call('/api/equipment', { session: member })).body.equipment, []);
  const created = await call('/api/equipment', { method: 'POST', session: member, body: payload });
  const id = created.body.equipment.id;
  assert.equal((await call(`/api/equipment/${id}`, { method: 'PATCH', body: { version: 1, status: 'retired' } })).status, 401);
  assert.equal((await call(`/api/equipment/${id}`, { method: 'DELETE', session: member, body: {} })).status, 405);
  assert.equal((await call(`/api/equipment/${id}`, { session: member })).body.equipment.version, 1);
  await call('/api/auth/logout', { method: 'POST', session: member, body: {} });
  for (const path of ['/api/equipment', `/api/equipment/${id}`]) assert.equal((await call(path, { session: member })).status, 401);
});

test('equipment HTTP rejects unknown and duplicate parameters, forged metadata and missing versions', async t => {
  const { call, register } = await fixture(t);
  const member = await register('validation-member');
  for (const query of ['?status=available', '?status=available&status=retired', '?token=secret']) assert.equal((await call(`/api/equipment${query}`, { session: member })).status, 422);
  for (const body of [{ name: ' ' }, { name: 'x', code: 'RT-MYCODE' }, { name: 'x', creatorId: member.user.id }, { name: 'x', status: 'deleted' }, { name: 'x', notes: 'x'.repeat(4001) }, { name: 'x', serialNumber: '12345678' }]) {
    assert.equal((await call('/api/equipment', { method: 'POST', session: member, body: draft(body) })).status, 422);
  }
  assert.equal((await call('/api/equipment/not-a-uuid', { session: member })).status, 422);
  assert.equal((await call(`/api/equipment/${randomUUID()}`, { session: member })).status, 404);
  const created = await call('/api/equipment', { method: 'POST', session: member, body: draft() });
  assert.equal((await call(`/api/equipment/${created.body.equipment.id}`, { method: 'PATCH', session: member, body: { name: '未带版本' } })).status, 422);
});

test('equipment statistics are authenticated, read-only, unfiltered and never routed as an equipment ID', async t => {
  const { call, register } = await fixture(t);
  const anonymous = await call('/api/equipment/stats');
  assert.equal(anonymous.status, 401); assert.equal(anonymous.headers['set-cookie'], undefined);
  const member = await register('statistics-member');
  assert.deepEqual((await call('/api/equipment/stats', { session: member })).body, {
    stats: { total: 0, statuses: { available: 0, in_use: 0, maintenance: 0, retired: 0 }, companies: [], categories: [], locations: [] },
  });
  for (const status of ['available', 'in_use', 'maintenance', 'retired']) {
    const created = await call('/api/equipment', { method: 'POST', session: member,
      body: draft({ name: `不公开统计的设备-${status}`, currentUser: '不公开统计的使用者', status }) });
    assert.equal(created.status, 201, created.text);
  }
  const result = await call('/api/equipment/stats', { session: member });
  assert.equal(result.status, 200); assert.equal(result.headers['cache-control'], 'no-store');
  assert.deepEqual(result.body, { stats: { total: 4, statuses: { available: 1, in_use: 1, maintenance: 1, retired: 1 },
    companies: [{ company: '西浦', count: 4 }], categories: [{ category: '台式主机', count: 4 }], locations: [{ location: '上海', count: 4 }] } });
  assert.equal(result.text.includes('不公开统计'), false); assert.equal(result.text.includes(member.user.id), false);
  for (const query of ['?status=available', '?status=available&status=retired', '?company=A%E5%85%AC%E5%8F%B8', '?q=secret', '?limit=1']) {
    assert.equal((await call(`/api/equipment/stats${query}`, { session: member })).status, 422);
  }
  for (const method of ['POST', 'PATCH', 'DELETE']) assert.equal((await call('/api/equipment/stats', { method, session: member, body: {} })).status, 405);
  assert.equal((await call('/api/equipment/stats', { session: member })).body.stats.total, 4);
  await call('/api/auth/logout', { method: 'POST', session: member, body: {} });
  assert.equal((await call('/api/equipment/stats', { session: member })).status, 401);
});

test('concurrent HTTP updates cannot overwrite each other and retirement keeps its QR identity after restart', async t => {
  const { call, register, restart } = await fixture(t);
  const first = await register('writer-one'), second = await register('writer-two');
  const created = await call('/api/equipment', { method: 'POST', session: first, body: draft({ name: '同一设备' }) });
  const original = created.body.equipment;
  const results = await Promise.all([first, second].map((session, index) => call(`/api/equipment/${original.id}`, { method: 'PATCH', session, body: { version: 1, currentUser: `使用者 ${index}` } })));
  assert.deepEqual(results.map(result => result.status).sort(), [200, 409]);
  assert.equal(results.find(result => result.status === 409).body.error.code, 'VERSION_CONFLICT');
  const retired = await call(`/api/equipment/${original.id}`, { method: 'PATCH', session: second, body: { version: 2, status: 'retired' } });
  assert.equal(retired.status, 200, retired.text);
  await restart();
  const restored = await call(`/api/equipment/${original.id}`, { session: first });
  assert.equal(restored.status, 200); assert.equal(restored.body.equipment.status, 'retired');
  assert.equal(restored.body.equipment.id, original.id); assert.equal(restored.body.equipment.code, original.code);
  assert.equal(restored.body.equipment.version, 3); assert.equal(restored.body.history.length, 3);
});
