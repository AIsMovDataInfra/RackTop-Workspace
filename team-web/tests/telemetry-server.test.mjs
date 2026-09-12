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
async function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'racktop-telemetry-http-')), dbPath = join(directory, 'team.sqlite'), distPath = join(directory, 'dist');
  mkdirSync(distPath); writeFileSync(join(distPath, 'index.html'), '<!doctype html><title>Synthetic telemetry</title>');
  const app = createTeamServer({ mode: 'account', host: '127.0.0.1', port: 0, publicUrl: PUBLIC, dbPath, distPath, nodeEnv: 'production', now: () => NOW });
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
  assert.equal((await call('/api/resources', { device: adminDevice })).body.resources[0].usage.state, 'unknown');
  const stale = await call(path, { method: 'POST', device: adminDevice, body: body() });
  assert.equal(stale.status, 409); assert.equal(stale.body.error.code, 'VERSION_CONFLICT');
  const fresh = await call(path, { method: 'POST', device: adminDevice, body: body({ serverVersion: 2, observedAt: NOW + 1 }) });
  assert.equal(fresh.status, 200, fresh.text); assert.equal(fresh.body.resource.usage.state, 'busy');
  const disabled = await call(`/api/servers/${server.id}`, { method: 'PATCH', browser: admin, body: { version: 2, enabled: false } });
  assert.equal(disabled.status, 200, disabled.text);
  assert.equal((await call('/api/resources', { device: adminDevice })).body.resources[0].usage.state, 'unknown');
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
