import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTeamServer } from '../server/server.mjs';

const PUBLIC = 'https://telemetry.example.test';
const NOW = Date.parse('2026-09-12T12:00:00Z');
const password = 'synthetic-telemetry-password';
const body = (extra = {}) => ({ serverVersion: 1, observedAt: NOW, status: 'online', inventoryComplete: true, processQueryOk: true, gpuUsageValid: true,
  gpus: [{ uuid: 'GPU-00000000-0000-4000-8000-000000000001', index: 0, name: 'NVIDIA Synthetic', memoryTotalMb: 24000, utilization: 10, memoryUsedMb: 3000, users: ['synthetic-worker'], hasProcesses: true }], ...extra });
async function fixture(t, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'racktop-telemetry-http-')), dbPath = join(directory, 'team.sqlite'), distPath = join(directory, 'dist');
  mkdirSync(distPath); writeFileSync(join(distPath, 'index.html'), '<!doctype html><title>Synthetic telemetry</title>');
  const app = createTeamServer({ mode: 'account', host: '127.0.0.1', port: 0, publicUrl: PUBLIC, dbPath, distPath, nodeEnv: 'production', now: () => NOW, ...options });
  await app.auth.provisionSuperAdmin({ mode: 'create', password });
  const { port } = await app.start();
  t.after(async () => { await app.close(); rmSync(directory, { recursive: true, force: true }); });
  const call = (path, { method = 'GET', body, browser, device, headers = {} } = {}) => new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const req = request({ host: '127.0.0.1', port, path, method, agent: false, headers: { host: new URL(PUBLIC).host, origin: PUBLIC,
      ...(data === undefined ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) }),
      ...(browser ? { cookie: browser.cookie, 'x-csrf-token': browser.csrfToken, 'x-racktop-company': encodeURIComponent(browser.user?.company ?? '') } : {}),
      ...(device ? { authorization: `Bearer ${device.token}`, 'x-racktop-company': encodeURIComponent(device.user.company ?? '') } : {}), ...headers } }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('end', () => { const text = Buffer.concat(chunks).toString(); resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(text), text }); });
    }); req.on('error', reject); req.end(data);
  });
  const session = result => ({ cookie: result.headers['set-cookie']?.[0]?.split(';')[0], csrfToken: result.body.csrfToken, user: result.body.user });
  const guest = session(await call('/api/session'));
  const login = await call('/api/auth/login', { method: 'POST', browser: guest, body: { username: 'admin', password } });
  assert.equal(login.status, 200, login.text); const admin = session(login);
  const deviceLogin = async username => {
    const result = await call('/api/auth/device-login', { method: 'POST', body: { username, password, deviceName: 'Synthetic telemetry fixture' } });
    assert.equal(result.status, 200, result.text); return result.body;
  };
  const adminDevice = await deviceLogin('admin');
  const add = async (name, company = 'A公司', role = 'member') => {
    const result = await call('/api/admin/members', { method: 'POST', browser: admin, body: { name, password, companies: [company] } });
    assert.equal(result.status, 201, result.text);
    if (role === 'admin') { const db = new DatabaseSync(dbPath); try { db.prepare("UPDATE account_users SET role='admin' WHERE id=?").run(result.body.member.id); } finally { db.close(); } }
    return { member: result.body.member, device: await deviceLogin(name) };
  };
  const create = async (extra = {}) => {
    const result = await call('/api/servers', { method: 'POST', browser: admin, body: { company: 'A公司', name: 'Synthetic GPU', host: 'sensitive-host.example.test', port: 22, username: 'sensitive-ssh-user', ...extra } });
    assert.equal(result.status, 201, result.text); return result.body.server;
  };
  return { app, call, admin, adminDevice, add, create, dbPath };
}

test('telemetry route requires device administrator and live company membership; browser, member and cross-company requests cannot upload', async t => {
  const { call, admin, adminDevice, add, create } = await fixture(t);
  const reader = await add('reader'), maintainer = await add('maintainer', 'A公司', 'admin'), outsider = await add('outsider', 'B公司', 'admin');
  const server = await create({ memberIds: [reader.member.id] }), path = `/api/servers/${server.id}/telemetry`;
  for (const options of [{}, { browser: admin }, { device: reader.device }, { device: outsider.device }]) {
    const result = await call(path, { method: 'POST', body: body(), ...options });
    assert.ok([401, 403, 404].includes(result.status), result.text);
  }
  for (const query of ['?schema=2', '?company=A', '?other=1']) assert.equal((await call(path + query, { method: 'POST', device: adminDevice, body: body() })).status, 422);
  const missingScope = await call(path, { method: 'POST', body: body(), headers: { authorization: `Bearer ${adminDevice.token}` } });
  assert.equal(missingScope.status, 409);
  const valid = await call(path, { method: 'POST', device: maintainer.device, body: body() });
  assert.equal(valid.status, 200, valid.text); assert.equal(valid.body.resource.usage.state, 'busy');
  for (const sensitive of ['sensitive-host', 'sensitive-ssh-user', 'password', 'credentialRevision', 'memberIds']) assert.equal(valid.text.includes(sensitive), false, sensitive);
  const resources = await call('/api/resources', { device: reader.device });
  assert.equal(resources.body.resources[0].id, valid.body.resource.id);
  assert.deepEqual((await call('/api/resources', { device: outsider.device })).body.resources, []);
});

test('directory version changes and disabled nodes invalidate cached usage and reject stale uploads', async t => {
  const { call, admin, adminDevice, create } = await fixture(t);
  const server = await create(), path = `/api/servers/${server.id}/telemetry`;
  const first = await call(path, { method: 'POST', device: adminDevice, body: body() });
  assert.equal(first.status, 200, first.text);
  const updated = await call(`/api/servers/${server.id}`, { method: 'PATCH', browser: admin, body: { version: 1, host: 'new-destination.example.test' } });
  assert.equal(updated.status, 200, updated.text);
  assert.deepEqual((await call('/api/resources', { device: adminDevice })).body.resources, []);
  const stale = await call(path, { method: 'POST', device: adminDevice, body: body() });
  assert.equal(stale.status, 409); assert.equal(stale.body.error.code, 'VERSION_CONFLICT');
  const fresh = await call(path, { method: 'POST', device: adminDevice, body: body({ serverVersion: 2, observedAt: NOW + 1 }) });
  assert.equal(fresh.status, 200, fresh.text); assert.equal(fresh.body.resource.usage.state, 'busy');
  const disabled = await call(`/api/servers/${server.id}`, { method: 'PATCH', browser: admin, body: { version: 2, enabled: false } });
  assert.equal(disabled.status, 200, disabled.text);
  assert.deepEqual((await call('/api/resources', { device: adminDevice })).body.resources, []);
  const stopped = await call(path, { method: 'POST', device: adminDevice, body: body({ serverVersion: 3, observedAt: NOW + 2 }) });
  assert.equal(stopped.status, 409); assert.equal(stopped.body.error.code, 'SERVER_DISABLED');
});

test('revoked membership is checked for every telemetry request and no failed first observation creates a resource', async t => {
  const { call, admin, add, create, dbPath } = await fixture(t);
  const maintainer = await add('revocable-admin', 'A公司', 'admin'), server = await create(), path = `/api/servers/${server.id}/telemetry`;
  const failure = await call(path, { method: 'POST', device: maintainer.device, body: body({ status: 'unknown', inventoryComplete: false, processQueryOk: false, gpuUsageValid: false, gpus: [] }) });
  assert.equal(failure.status, 200, failure.text); assert.equal(failure.body.resource, null);
  assert.deepEqual((await call('/api/resources', { browser: admin })).body.resources, []);
  const db = new DatabaseSync(dbPath);
  try { db.prepare('DELETE FROM account_user_companies WHERE user_id=?').run(maintainer.member.id); } finally { db.close(); }
  const revoked = await call(path, { method: 'POST', device: maintainer.device, body: body() });
  assert.ok([401, 403, 409].includes(revoked.status), revoked.text);
  assert.deepEqual((await call('/api/resources', { browser: admin })).body.resources, []);
});

test('HTTP resource and reservation access requires current SSH grants without stranding the owner history', async t => {
  const { call, admin, adminDevice, add, create } = await fixture(t);
  const reader = await add('authorized-reader'), peer = await add('ungranted-peer'), outside = await add('outside-reader', 'B公司');
  const server = await create({ memberIds: [reader.member.id] });
  const synced = await call(`/api/servers/${server.id}/telemetry`, { method: 'POST', device: adminDevice, body: body() });
  const resource = synced.body.resource;
  const draft = { resourceId: resource.id, scope: 'gpus', gpuIds: [resource.gpus[0].id], inventoryVersion: resource.inventoryVersion,
    startAt: new Date(NOW + 60_000).toISOString(), endAt: new Date(NOW + 3_600_000).toISOString(), purpose: 'Synthetic booked task' };
  const booked = await call('/api/reservations', { method: 'POST', device: reader.device, body: draft });
  assert.equal(booked.status, 201, booked.text); const reservation = booked.body.reservation;
  for (const device of [peer.device, outside.device]) {
    assert.deepEqual((await call('/api/resources', { device })).body.resources, []);
    assert.equal((await call(`/api/resources/${resource.id}`, { device })).status, 404);
    assert.deepEqual((await call('/api/reservations', { device })).body.reservations, []);
    assert.equal((await call(`/api/reservations/${reservation.id}`, { device })).status, 404);
    assert.equal((await call('/api/reservations', { method: 'POST', device, body: draft })).status, 404);
  }
  const current = await call('/api/reservations', { method: 'POST', device: reader.device,
    body: { ...draft, startAt: new Date(NOW).toISOString(), endAt: new Date(NOW + 30_000).toISOString() } });
  assert.equal(current.status, 409); assert.equal(current.body.error.code, 'GPU_BUSY');
  const revoked = await call(`/api/servers/${server.id}/grants`, { method: 'PUT', browser: admin, body: { version: 1, memberIds: [] } });
  assert.equal(revoked.status, 200, revoked.text);
  assert.deepEqual((await call('/api/resources', { device: reader.device })).body.resources, []);
  assert.deepEqual((await call('/api/reservations', { device: reader.device })).body.reservations, []);
  assert.equal((await call('/api/reservations?mine=true', { device: reader.device })).body.reservations[0].id, reservation.id);
  assert.equal((await call(`/api/reservations/${reservation.id}`, { device: reader.device })).status, 200);
  assert.equal((await call(`/api/reservations/${reservation.id}`, { method: 'PATCH', device: reader.device,
    body: { version: 1, inventoryVersion: 1, endAt: new Date(NOW + 7_200_000).toISOString() } })).status, 404);
  assert.equal((await call(`/api/reservations/${reservation.id}/cancel`, { method: 'POST', device: reader.device, body: { version: 1 } })).status, 200);
});

test('directory identity changes atomically detach only that hardware binding; metadata and password edits preserve it', async t => {
  const { call, admin, adminDevice, add, create, dbPath } = await fixture(t, { serverCredentialKey: Buffer.alloc(32, 23).toString('base64') });
  const reader = await add('binding-reader');
  let server = await create({ memberIds: [reader.member.id] });
  const alias = await create({ name: 'Other login', username: 'other-fixture-user', memberIds: [reader.member.id] });
  const sync = async (entry, observedAt = NOW) => {
    const result = await call(`/api/servers/${entry.id}/telemetry`, { method: 'POST', device: adminDevice, body: body({ serverVersion: entry.version, observedAt }) });
    assert.equal(result.status, 200, result.text); return result.body.resource;
  };
  const resource = await sync(server); assert.equal((await sync(alias)).id, resource.id);
  const db = new DatabaseSync(dbPath);
  try {
    const inventoryBefore = db.prepare('SELECT * FROM resource_inventory WHERE resource_id=?').get(resource.id);
    const patch = async value => {
      const result = await call(`/api/servers/${server.id}`, { method: 'PATCH', browser: admin, body: { version: server.version, ...value } });
      assert.equal(result.status, 200, result.text); server = result.body.server;
    };
    for (const change of [{ name: 'Renamed safely' }, { password: 'synthetic rotated password' }]) {
      await patch(change);
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM managed_resource_bindings').get().n, 2);
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM resource_usage').get().n, 2);
    }
    const grants = await call(`/api/servers/${server.id}/grants`, { method: 'PUT', browser: admin, body: { version: server.version, memberIds: [] } });
    assert.equal(grants.status, 200, grants.text); server = grants.body.server;
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM managed_resource_bindings').get().n, 2);
    assert.equal((await call('/api/resources', { device: reader.device })).body.resources.length, 1, 'the separately authorized alias remains');
    let observation = NOW;
    for (const change of [{ host: 'new-fixture.example.test' }, { port: 2222 }, { username: 'new-fixture-user' },
      { jump: { host: 'jump.example.test', port: 22, username: 'bridge' } },
      { jump: { host: 'jump.example.test', port: 2222, username: 'bridge' } },
      { jump: { host: 'jump.example.test', port: 2222, username: 'new-bridge' } }, { jump: null }]) {
      await patch(change);
      assert.equal(db.prepare('SELECT 1 FROM managed_resource_bindings WHERE managed_server_id=?').get(server.id), undefined);
      assert.equal(db.prepare('SELECT 1 FROM resource_usage WHERE managed_server_id=?').get(server.id), undefined);
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM managed_resource_bindings WHERE managed_server_id=?').get(alias.id).n, 1);
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM resources').get().n, 1);
      assert.equal((await sync(server, ++observation)).id, resource.id, 'same complete hardware can be verified anew');
    }
    assert.equal(db.prepare('SELECT gpus FROM resource_inventory WHERE resource_id=?').get(resource.id).gpus, inventoryBefore.gpus);
    const beforeBindings = db.prepare('SELECT * FROM managed_resource_bindings ORDER BY managed_server_id').all();
    const beforeUsage = db.prepare('SELECT * FROM resource_usage ORDER BY managed_server_id').all();
    db.exec("CREATE TRIGGER fail_endpoint_audit BEFORE INSERT ON managed_server_audit BEGIN SELECT RAISE(ABORT,'synthetic rollback'); END");
    const failed = await call(`/api/servers/${server.id}`, { method: 'PATCH', browser: admin, body: { version: server.version, port: 2022 } });
    assert.equal(failed.status, 500);
    assert.deepEqual(db.prepare('SELECT * FROM managed_resource_bindings ORDER BY managed_server_id').all(), beforeBindings);
    assert.deepEqual(db.prepare('SELECT * FROM resource_usage ORDER BY managed_server_id').all(), beforeUsage);
    assert.equal(db.prepare('SELECT version FROM managed_servers WHERE id=?').get(server.id).version, server.version);
  } finally { db.close(); }
});
