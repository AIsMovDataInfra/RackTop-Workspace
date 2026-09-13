import { assignFixtureCompany } from './helpers/account-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTeamServer, readConfig } from '../server/server.mjs';

const PUBLIC = 'https://team.example.test';
const BASE = Date.parse('2026-09-08T04:00:00Z');
const PASSWORD = 'test only account password';
const iso = minutes => new Date(BASE + minutes * 60_000).toISOString();
const gpu = (number, index = number - 1) => ({ uuid: `GPU-00000000-0000-4000-8000-${String(number).padStart(12, '0')}`, index, name: 'NVIDIA A100', memoryTotalMb: 81920 });
const inventory = (extra = {}) => ({ sourceId: 'owner-desktop', serverId: 'private-ssh-profile', cluster: '训练集群', name: 'A100 服务器', notes: 'private connection notes', observedAt: BASE, status: 'online', gpus: [gpu(1), gpu(2)], ...extra });
const resourceDraft = (extra = {}) => ({ cluster: '训练集群', name: '手工服务器', gpuModel: 'A100', gpuCount: 2, notes: 'private resource notes', ...extra });
const booking = (resource, extra = {}) => ({ resourceId: resource.id, scope: 'machine', gpuIndices: [], startAt: iso(10), endAt: iso(70), purpose: 'private training plan', ...(resource.inventoryVersion ? { inventoryVersion: resource.inventoryVersion } : {}), ...extra });

async function fixture(t, extra = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'racktop-account-http-'));
  const distPath = join(directory, 'dist'); mkdirSync(distPath);
  writeFileSync(join(distPath, 'index.html'), '<!doctype html><title>Account booking integration test</title>');
  const bootstrapToken = randomBytes(32).toString('base64url');
  let clock = BASE;
  const app = createTeamServer({ mode: 'account', host: '127.0.0.1', port: 0, publicUrl: PUBLIC, dbPath: join(directory, 'team.sqlite'), distPath,
    adminUsername: 'owner', bootstrapToken, nodeEnv: 'production', now: () => clock, trustProxy: true, ...extra });
  const { port } = await app.start();
  t.after(async () => { await app.close(); rmSync(directory, { recursive: true, force: true }); });
  async function call(path, { method = 'GET', body, session, bearer, headers = {}, raw } = {}) {
    const data = raw ?? (body !== undefined ? JSON.stringify(body) : undefined);
    const values = { host: new URL(PUBLIC).host, ...(data !== undefined ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}),
      ...(['POST', 'PATCH', 'DELETE', 'PUT'].includes(method) ? { origin: PUBLIC } : {}),
      ...(session ? { cookie: session.cookie, 'x-csrf-token': session.csrfToken } : {}), ...(bearer ? { authorization: `Bearer ${bearer}` } : {}), ...headers };
    return new Promise((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port, path, method, headers: Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined)) }, res => {
        const chunks = []; res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8'); let result;
          try { result = JSON.parse(text); } catch { result = text; }
          resolve({ status: res.statusCode, body: result, headers: res.headers, text });
        });
      });
      req.on('error', reject); req.end(data);
    });
  }
  const sessionOf = response => ({ cookie: response.headers['set-cookie']?.[0]?.split(';')[0], csrfToken: response.body.csrfToken, user: response.body.user });
  async function anonymous() { const response = await call('/api/session'); assert.equal(response.status, 200); return sessionOf(response); }
  async function register(local = 'member', extraBody = {}) {
    const response = await call('/api/auth/register', { method: 'POST', session: await anonymous(), body: { username: `${local}`, name: local, password: PASSWORD, ...(local === 'owner' ? { bootstrapToken } : {}), ...extraBody } });
    assert.equal(response.status, 201, response.text); response.body.user = assignFixtureCompany(app.config.dbPath, response.body.user); return sessionOf(response);
  }
  async function device(local = 'owner') {
    const response = await call('/api/auth/device-login', { method: 'POST', body: { username: `${local}`, password: PASSWORD, deviceName: 'HTTP 集成测试设备' } });
    assert.equal(response.status, 200, response.text); assert.equal(response.headers['set-cookie'], undefined); return response.body.token;
  }
  return { call, register, anonymous, sessionOf, device, app, bootstrapToken, setClock(value) { clock = value; } };
}

test('all business reads require a registered member while login and static shells stay reachable', async t => {
  const { call, register, anonymous, setClock } = await fixture(t);
  assert.deepEqual((await call('/api/health')).body, { ok: true });
  for (const path of ['/', '/equipment', '/equipment/00000000-0000-4000-8000-000000000001']) assert.equal((await call(path)).status, 200);
  const guest = await anonymous();
  const admin = await register('owner'), member = await register('中', { password: '密' });
  assert.equal(member.user.role, 'member');
  const resource = (await call('/api/resources', { method: 'POST', session: admin, body: resourceDraft() })).body.resource;
  const reserved = await call('/api/reservations', { method: 'POST', session: member, body: booking(resource) });
  assert.equal(reserved.status, 201, reserved.text);
  const reservation = reserved.body.reservation;
  const paths = ['/api/resources', `/api/resources/${resource.id}`, '/api/reservations', '/api/reservations?mine=false',
    '/api/reservations?mine=true', '/api/reservations?unexpected=1', `/api/reservations/${reservation.id}`,
    '/api/equipment', '/api/equipment/00000000-0000-4000-8000-000000000001'];
  for (const path of paths) for (const options of [{}, { session: guest }, { headers: { authorization: 'Bearer invalid' } }]) {
    const response = await call(path, options);
    assert.equal(response.status, 401, path); assert.equal(response.headers['cache-control'], 'no-store');
    for (const value of ['private resource notes', 'private training plan', resource.name, member.user.name]) assert.equal(response.text.includes(value), false);
  }
  assert.equal((await call('/api/resources', { session: member })).body.resources[0].notes, 'private resource notes');
  assert.equal((await call(`/api/reservations/${reservation.id}`, { session: member })).body.reservation.purpose, 'private training plan');
  assert.equal((await call('/api/equipment', { session: member })).status, 200);
  assert.equal((await call('/api/reservations?mine=true&mine=false', { session: member })).status, 422);
  assert.equal((await call('/api/reservations?unexpected=1', { session: member })).status, 422);
  await call('/api/auth/logout', { method: 'POST', session: member, body: {} });
  for (const path of paths) assert.equal((await call(path, { session: member })).status, 401, `logged out: ${path}`);
  setClock(BASE + 9 * 60 * 60_000);
  for (const path of paths) assert.equal((await call(path, { session: admin })).status, 401, `expired: ${path}`);
});

test('account HTTP writes require CSRF and members can only alter their own bookings', async t => {
  const { call, register } = await fixture(t);
  const admin = await register('owner'), member = await register(), other = await register('other');
  const resource = (await call('/api/resources', { method: 'POST', session: admin, body: resourceDraft() })).body.resource;
  for (const options of [{}, { session: member, headers: { 'x-csrf-token': undefined } }, { session: member, headers: { origin: 'https://attacker.test' } }]) {
    const response = await call('/api/reservations', { method: 'POST', body: booking(resource), ...options });
    assert.ok([401, 403].includes(response.status));
  }
  assert.equal((await call('/api/reservations', { session: member })).body.reservations.length, 0);
  assert.equal((await call('/api/resources', { method: 'POST', session: member, body: resourceDraft({ name: 'Forbidden' }) })).status, 403);
  const reservation = (await call('/api/reservations', { method: 'POST', session: member, body: booking(resource) })).body.reservation;
  assert.equal(reservation.ownerId, member.user.id);
  for (const [path, method, body] of [[`/api/reservations/${reservation.id}`, 'PATCH', { version: 1, purpose: 'stolen' }],
    [`/api/reservations/${reservation.id}/cancel`, 'POST', { version: 1 }], [`/api/reservations/${reservation.id}/finish`, 'POST', { version: 1 }]]) {
    const response = await call(path, { method, body, session: other }); assert.equal(response.status, 403, response.text);
  }
  const changed = await call(`/api/reservations/${reservation.id}`, { method: 'PATCH', session: member, body: { version: 1, purpose: 'owner updated' } });
  assert.equal(changed.status, 200); assert.equal(changed.body.reservation.version, 2);
  assert.equal((await call('/api/reservations?mine=true', { session: other })).body.reservations.length, 0);
  assert.equal((await call('/api/reservations?mine=true', { session: member })).body.reservations.length, 1);
  const cancelled = await call(`/api/reservations/${reservation.id}/cancel`, { method: 'POST', session: member, body: { version: 2 } });
  assert.equal(cancelled.status, 200); assert.equal(cancelled.body.reservation.status, 'cancelled');
});

test('actual HTTP admin device sync carries GPU identities and member device cannot manage resources', async t => {
  const { call, register, device, setClock } = await fixture(t);
  await register('owner'); const reader = await register();
  const adminToken = await device(), memberToken = await device('member');
  assert.equal((await call('/api/resources/sync', { method: 'POST', bearer: memberToken, body: inventory() })).status, 403);
  assert.equal((await call('/api/resources/sync', { method: 'POST', bearer: adminToken, headers: { origin: undefined }, body: inventory() })).status, 403);
  const first = await call('/api/resources/sync', { method: 'POST', bearer: adminToken, body: inventory() });
  assert.equal(first.status, 200, first.text);
  const resource = first.body.resource;
  assert.equal(resource.status, 'online'); assert.equal(resource.inventoryState, 'synced');
  assert.equal(resource.observedAt, new Date(BASE).toISOString());
  assert.equal(resource.gpus.length, 2); assert.equal(resource.gpus[0].memoryTotalMb, 81920);
  assert.match(resource.gpus[0].id, /^[0-9a-f-]{36}$/); assert.equal(resource.gpus[0].uuid, gpu(1).uuid.toLowerCase());
  const alias = await call('/api/resources/sync', { method: 'POST', bearer: adminToken, body: inventory({ sourceId: 'second-computer', serverId: 'another-ssh-user', name: 'Alias' }) });
  assert.equal(alias.status, 200); assert.equal(alias.body.resource.id, resource.id); assert.equal(alias.body.resource.binding.authoritative, false);
  assert.deepEqual((await call('/api/resources', { bearer: memberToken })).body.resources, [], 'legacy inventory alone is not SSH authorization');
  assert.equal((await call(`/api/resources/${resource.id}`, { bearer: memberToken })).status, 404);
  const catalog = await call('/api/servers', { method: 'POST', bearer: adminToken,
    body: { company: reader.user.company, name: 'Authorized GPU', host: 'fixture.example.test', port: 22, username: 'fixture', memberIds: [reader.user.id] } });
  assert.equal(catalog.status, 201, catalog.text);
  const linked = await call(`/api/servers/${catalog.body.server.id}/telemetry`, { method: 'POST', bearer: adminToken,
    headers: { 'x-racktop-company': encodeURIComponent(reader.user.company) }, body: { serverVersion: 1, observedAt: BASE, status: 'online',
      inventoryComplete: true, processQueryOk: true, gpuUsageValid: true,
      gpus: inventory().gpus.map(value => ({ ...value, utilization: 0, memoryUsedMb: 0, users: [], hasProcesses: false })) } });
  assert.equal(linked.status, 200, linked.text); assert.equal(linked.body.resource.id, resource.id);
  assert.equal((await call('/api/resources', { bearer: memberToken })).body.resources.length, 1);
  const reserved = await call('/api/reservations', { method: 'POST', bearer: memberToken, body: booking(resource, { scope: 'gpus', gpuIds: [resource.gpus[0].id] }) });
  assert.equal(reserved.status, 201, reserved.text);
  assert.deepEqual(reserved.body.reservation.gpuIds, [resource.gpus[0].id]);
  const changed = await call('/api/resources/sync', { method: 'POST', bearer: adminToken, body: inventory({ gpus: [gpu(2, 0), gpu(3, 1)] }) });
  assert.equal(changed.status, 409); assert.equal(changed.body.error.code, 'INVENTORY_CHANGED');
  const memberResource = (await call('/api/resources', { bearer: memberToken })).body.resources[0];
  assert.equal(memberResource.inventoryState, 'conflict');
  assert.deepEqual(memberResource.gpus.map(value => value.id), resource.gpus.map(value => value.id));
  setClock(BASE + 91_000);
  assert.equal((await call('/api/resources', { bearer: memberToken })).body.resources[0].status, 'unknown');
  assert.equal((await call('/api/auth/device-logout', { method: 'POST', bearer: adminToken, body: {} })).status, 200);
  assert.equal((await call('/api/resources/sync', { method: 'POST', bearer: adminToken, body: inventory() })).status, 401);
  for (const path of ['/api/resources', '/api/reservations', '/api/equipment']) {
    assert.equal((await call(path, { bearer: adminToken })).status, 401, 'revoked credentials must not downgrade to public access');
    assert.equal((await call(path, { bearer: 'invalid' })).status, 401, 'malformed credentials must not downgrade to public access');
    assert.equal((await call(path)).status, 401, 'visitors must sign in before business access');
  }
  setClock(BASE + 31 * 24 * 60 * 60_000);
  assert.equal((await call('/api/resources', { bearer: memberToken })).status, 401, 'expired device credentials must require login');
  assert.equal((await call('/api/reservations', { bearer: memberToken })).status, 401);
});

test('HTTP registration cannot inject roles or squat the configured administrator username, and passwords are not reflected', async t => {
  const { call, anonymous, register, bootstrapToken } = await fixture(t);
  const session = await anonymous();
  const input = { username: 'owner', name: 'owner', password: PASSWORD };
  const squat = await call('/api/auth/register', { method: 'POST', session, body: input });
  assert.equal(squat.status, 403); assert.equal(squat.body.error.code, 'BOOTSTRAP_REQUIRED');
  const elevated = await call('/api/auth/register', { method: 'POST', session, body: { ...input, username: 'other', role: 'admin' } });
  assert.equal(elevated.status, 422);
  const wrongBootstrap = await call('/api/auth/register', { method: 'POST', session, body: { ...input, bootstrapToken: `${bootstrapToken}x` } });
  assert.equal(wrongBootstrap.status, 403);
  for (const response of [squat, elevated, wrongBootstrap]) { assert.equal(response.text.includes(PASSWORD), false); assert.equal(response.text.includes(bootstrapToken), false); }
  const owner = await register('owner'); assert.equal(owner.user.role, 'admin'); assert.equal(Object.hasOwn(owner.user, 'email'), false);
  const current = await call('/api/session', { session: owner });
  assert.equal(current.body.user.id, owner.user.id); assert.equal(current.body.accountRegistration, true);
  const logout = await call('/api/auth/logout', { method: 'POST', session: owner, body: {} }); assert.equal(logout.status, 200);
  assert.equal((await call('/api/session', { session: owner })).body.user, null);
  assert.equal((await call('/api/resources', { session: owner })).status, 401);
});

test('readConfig propagates production account settings and rejects unsafe deployment configuration before opening a database', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'racktop-account-config-')); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const dbPath = join(directory, 'must-not-open.sqlite'), bootstrapToken = randomBytes(32).toString('base64url');
  const config = readConfig({ NODE_ENV: 'production', TEAM_AUTH_MODE: 'account', TEAM_HOST: '127.0.0.1', TEAM_PORT: '4318',
    TEAM_PUBLIC_URL: PUBLIC, TEAM_DB_PATH: dbPath, TEAM_ADMIN_USERNAME: 'owner', TEAM_BOOTSTRAP_TOKEN: bootstrapToken, TEAM_TRUST_PROXY: 'true' });
  assert.equal(config.mode, 'account'); assert.equal(config.nodeEnv, 'production'); assert.equal(config.trustProxy, true);
  assert.equal(config.adminUsername, 'owner'); assert.equal(config.bootstrapToken, bootstrapToken);
  assert.equal(readConfig({ TEAM_TRUST_PROXY: 'false' }).trustProxy, false);
  assert.throws(() => readConfig({ TEAM_TRUST_PROXY: 'yes' }), /TEAM_TRUST_PROXY/);
  for (const extra of [{ publicUrl: 'http://127.0.0.1:4318' }, { adminUsername: '   ' }, { bootstrapToken: 'too-short' },
    { host: '0.0.0.0' }, { trustProxy: 'true' }, { publicUrl: 'https://team.example.test/path' }]) {
    assert.throws(() => createTeamServer({ ...config, ...extra })); assert.equal(existsSync(dbPath), false);
  }
  const app = createTeamServer({ ...config, port: 0 }); await app.close();
  // Site restarts may omit the setup token; keeping that secret configured is not required.
  const restarted = createTeamServer({ ...config, port: 0, bootstrapToken: '' }); await restarted.close();
});

test('HTTP accounts accept short Chinese credentials and long ordinary values while retaining the total body limit', async t => {
  const { call, register, anonymous, sessionOf } = await fixture(t);
  let session = await register('小', { name: '短账号', password: '密' });
  const change = await call('/api/auth/change-password', { method: 'POST', session, body: { oldPassword: '密', newPassword: '新' } });
  assert.equal(change.status, 200, change.text); session = sessionOf(change);
  await call('/api/auth/logout', { method: 'POST', session, body: {} });
  const login = await call('/api/auth/login', { method: 'POST', session: await anonymous(), body: { username: ' 小 ', password: '新' } });
  assert.equal(login.status, 200, login.text);
  const username = 'Name 中文 + @.'.repeat(80), password = '密 '.repeat(300);
  const long = await register(username, { name: '长账号', password });
  assert.equal(long.user.username, username.toLowerCase());
  const device = await call('/api/auth/device-login', { method: 'POST', body: { username, password, deviceName: '桌面' } });
  assert.equal(device.status, 200, device.text);
  const oversized = await call('/api/auth/register', { method: 'POST', session: await anonymous(), body: { name: 'x'.repeat(64 * 1024), password: '密' } });
  assert.equal(oversized.status, 413); assert.equal(oversized.body.error.code, 'BODY_TOO_LARGE');
});

for (const [label, name] of [['long Chinese and English', 'Member中文 + @.'.repeat(100)], ['decomposed accents', 'Cafe\u0301中文']]) {
  test(`HTTP single-name registration, logout and login preserve ${label}`, async t => {
    const { call, anonymous, sessionOf } = await fixture(t);
    const registered = await call('/api/auth/register', { method: 'POST', session: await anonymous(), body: { name: `  ${name}  `, password: '密' } });
    assert.equal(registered.status, 201, registered.text);
    assert.equal(registered.body.user.name, name); assert.equal(registered.body.user.username, name);
    const session = sessionOf(registered);
    assert.equal((await call('/api/auth/logout', { method: 'POST', session, body: {} })).status, 200);
    assert.equal((await call('/api/session', { session })).body.user, null);
    const login = await call('/api/auth/login', { method: 'POST', session: await anonymous(), body: { username: ` ${name.toUpperCase()} `, password: '密' } });
    assert.equal(login.status, 200, login.text);
    assert.equal(login.body.user.id, registered.body.user.id);
    assert.equal(login.body.user.name, name); assert.equal(login.body.user.username, name);
    const grant = await call('/api/auth/device-login', { method: 'POST', body: { username: name, password: '密', deviceName: '桌面' } });
    assert.equal(grant.status, 200, grant.text); assert.equal(grant.body.user.name, name);
    const duplicate = await call('/api/auth/register', { method: 'POST', session: await anonymous(), body: { name: ` ${name.toLowerCase()} `, password: '密' } });
    assert.equal(duplicate.status, 409, duplicate.text); assert.equal(duplicate.body.error.code, 'ACCOUNT_EXISTS');
  });
}
