import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTeamServer, readConfig } from '../server/server.mjs';

const base = Date.parse('2026-09-08T04:00:00Z');
const publicUrl = 'http://127.0.0.1:4318';
const iso = minutes => new Date(base + minutes * 60_000).toISOString();

async function fixture(t, overrides = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'racktop-team-http-'));
  const distPath = join(directory, 'dist'); mkdirSync(distPath);
  writeFileSync(join(distPath, 'index.html'), '<!doctype html><title>RackTop team test</title>');
  writeFileSync(join(distPath, 'app.js'), 'console.log("test")');
  writeFileSync(join(directory, 'secret.txt'), 'must never be served');
  symlinkSync(join(directory, 'secret.txt'), join(distPath, 'escape.txt'));
  let clock = base;
  const app = createTeamServer({ mode: 'demo', host: '127.0.0.1', port: 0, publicUrl, dbPath: join(directory, 'test.sqlite'), distPath, seedDemo: false, now: () => clock, nodeEnv: 'test', ...overrides });
  const address = await app.start();
  t.after(async () => { await app.close(); rmSync(directory, { recursive: true, force: true }); });
  async function call(path, { method = 'GET', body, raw, headers = {}, session } = {}) {
    const data = raw ?? (body !== undefined ? JSON.stringify(body) : undefined);
    return new Promise((resolveResponse, reject) => {
      const req = request({ host: '127.0.0.1', port: address.port, path, method, headers: {
        Host: '127.0.0.1:4318',
        ...(data === undefined ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }),
        ...(['POST', 'PATCH', 'DELETE', 'PUT'].includes(method) ? { Origin: publicUrl } : {}),
        ...(session ? { Cookie: session.cookie, 'X-CSRF-Token': session.csrfToken } : {}), ...headers,
      } }, res => {
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8'); let payload;
          try { payload = JSON.parse(text); } catch { payload = text; }
          resolveResponse({ status: res.statusCode, headers: res.headers, body: payload });
        });
      });
      req.on('error', reject); req.end(data);
    });
  }
  async function login(userId = 'demo-admin') {
    const anonymous = await call('/api/session');
    assert.equal(anonymous.status, 200);
    const cookie = anonymous.headers['set-cookie'][0].split(';')[0];
    const response = await call('/api/auth/demo', { method: 'POST', body: { userId }, session: { cookie, csrfToken: anonymous.body.csrfToken } });
    assert.equal(response.status, 200);
    return { cookie: response.headers['set-cookie'][0].split(';')[0], csrfToken: response.body.csrfToken, user: response.body.user };
  }
  return { app, call, login, setClock: value => { clock = value; } };
}

test('session/login, CSRF, role enforcement, host and origin checks integrate on actual HTTP', async t => {
  const { call, login } = await fixture(t);
  assert.deepEqual((await call('/api/health')).body, { ok: true });
  assert.equal((await call('/api/resources')).status, 401);
  assert.equal((await call('/api/session', { headers: { Host: 'evil.example:4318' } })).status, 403);
  assert.equal((await call('/api/session', { headers: { Origin: 'https://evil.example' } })).status, 403);
  const admin = await login();
  assert.equal(admin.user.role, 'admin');
  const payload = { cluster: '训练集群', name: 'Atlas', gpuModel: 'A100', gpuCount: 4 };
  assert.equal((await call('/api/resources', { method: 'POST', body: payload, session: admin, headers: { 'X-CSRF-Token': 'wrong' } })).status, 403);
  assert.equal((await call('/api/resources', { method: 'POST', body: payload, session: admin, headers: { Origin: 'null' } })).status, 403);
  const member = await login('demo-lin');
  assert.equal((await call('/api/resources', { method: 'POST', body: payload, session: member })).status, 403);
  const created = await call('/api/resources', { method: 'POST', body: payload, session: admin });
  assert.equal(created.status, 201);
  assert.equal((await call('/api/resources', { session: member })).body.resources.length, 1);
  const loggedOut = await call('/api/auth/logout', { method: 'POST', body: {}, session: admin });
  assert.equal(loggedOut.status, 200);
  assert.equal((await call('/api/resources', { session: admin })).status, 401);
});

test('HTTP reservation create, competing request, details, CAS and cancel preserve ownership', async t => {
  const { call, login } = await fixture(t);
  const admin = await login(), lin = await login('demo-lin'), zhou = await login('demo-zhou');
  const resource = (await call('/api/resources', { method: 'POST', body: { cluster: 'c', name: 'n', gpuModel: 'A100', gpuCount: 2 }, session: admin })).body.resource;
  const booking = { resourceId: resource.id, scope: 'gpus', gpuIndices: [0], startAt: iso(10), endAt: iso(70), purpose: '集成测试' };
  const results = await Promise.all([call('/api/reservations', { method: 'POST', body: booking, session: lin }), call('/api/reservations', { method: 'POST', body: booking, session: zhou })]);
  assert.deepEqual(results.map(result => result.status).sort(), [201, 409]);
  const reservation = results.find(result => result.status === 201).body.reservation;
  const owner = reservation.ownerId === lin.user.id ? lin : zhou;
  const other = owner === lin ? zhou : lin;
  assert.equal(results.find(result => result.status === 409).body.error.conflicts[0].id, reservation.id);
  assert.equal((await call(`/api/reservations/${reservation.id}`, { session: other })).body.reservation.id, reservation.id);
  assert.equal((await call(`/api/reservations/${reservation.id}`, { method: 'PATCH', body: { version: 1, purpose: '越权' }, session: other })).status, 403);
  const changed = await call(`/api/reservations/${reservation.id}`, { method: 'PATCH', body: { version: 1, endAt: iso(80) }, session: owner });
  assert.equal(changed.body.reservation.version, 2);
  assert.equal((await call(`/api/reservations/${reservation.id}/cancel`, { method: 'POST', body: { version: 1 }, session: owner })).status, 409);
  assert.equal((await call(`/api/reservations/${reservation.id}/cancel`, { method: 'POST', body: { version: 2 }, session: owner })).body.reservation.status, 'cancelled');
  assert.equal((await call('/api/reservations', { method: 'POST', body: booking, session: other })).status, 201);
  assert.equal((await call('/api/reservations?mine=true', { session: owner })).body.reservations.length, 1);
  assert.equal((await call('/api/reservations?mine=true&mine=false', { session: owner })).status, 422);
});

test('static app supports routes and blocks traversal, symlink escape, bad bodies and hidden files', async t => {
  const { call, login } = await fixture(t);
  const index = await call('/');
  assert.equal(index.status, 200);
  assert.match(index.body, /RackTop team test/);
  assert.equal(index.headers['x-content-type-options'], 'nosniff');
  assert.equal((await call('/reservations')).status, 200);
  assert.equal((await call('/app.js')).headers['content-type'], 'text/javascript; charset=utf-8');
  assert.equal((await call('/%2e%2e/secret.txt')).status, 400);
  assert.equal((await call('/escape.txt')).status, 403);
  assert.equal((await call('/.env')).status, 400);
  assert.equal((await call('/missing.js')).status, 404);
  assert.equal((await call('/bad%00path')).status, 400);
  const session = await login();
  assert.equal((await call('/api/resources', { method: 'POST', raw: '{broken', session })).status, 400);
  assert.equal((await call('/api/resources', { method: 'POST', raw: 'x'.repeat(70 * 1024), session })).status, 413);
  assert.equal((await call('/api/resources', { method: 'POST', body: {}, session, headers: { 'Content-Type': 'text/plain' } })).status, 415);
  assert.equal((await call('/api/resources', { method: 'POST', body: {}, session, headers: { 'Content-Type': 'application/json-trick' } })).status, 415);
});

test('notification failure leaves booking committed and retries through mock only', async t => {
  const sent = []; let failing = true;
  const { call, login, app, setClock } = await fixture(t, { notificationsConfigured: true, notifier: { send: async event => { if (failing) throw new Error('mock network failure'); sent.push(event); return true; } } });
  const admin = await login();
  const resource = (await call('/api/resources', { method: 'POST', body: { cluster: 'c', name: 'n', gpuModel: '', gpuCount: 0 }, session: admin })).body.resource;
  const response = await call('/api/reservations', { method: 'POST', body: { resourceId: resource.id, scope: 'machine', gpuIndices: [], startAt: iso(10), endAt: iso(60), purpose: '通知测试' }, session: admin });
  assert.equal(response.status, 201);
  await app.processNotifications();
  assert.equal(sent.length, 0);
  assert.equal((await call(`/api/reservations/${response.body.reservation.id}`, { session: admin })).status, 200);
  failing = false; setClock(base + 11_000);
  await app.processNotifications();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, 'created');
  await app.processNotifications();
  assert.equal(sent.length, 1);
});

test('unsafe startup config fails before opening database; demo and production use different defaults', () => {
  const config = { dbPath: ':memory:', seedDemo: false, nodeEnv: 'test' };
  assert.throws(() => createTeamServer({ ...config, mode: 'demo', host: '0.0.0.0', publicUrl }), /loopback/);
  assert.throws(() => createTeamServer({ ...config, mode: 'demo', host: '127.0.0.1', publicUrl: 'https://team.example' }), /loopback/);
  assert.throws(() => createTeamServer({ ...config, mode: 'feishu', publicUrl: 'http://team.example' }), /HTTPS/);
  assert.throws(() => createTeamServer({ ...config, mode: 'feishu', publicUrl: 'https://team.example' }), /飞书/);
  assert.notEqual(readConfig({ TEAM_AUTH_MODE: 'demo' }).dbPath, readConfig({ TEAM_AUTH_MODE: 'feishu' }).dbPath);
});
