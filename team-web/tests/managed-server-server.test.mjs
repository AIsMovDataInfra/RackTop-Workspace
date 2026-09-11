import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTeamServer } from '../server/server.mjs';
import { createAccountAuth } from '../server/account-auth.mjs';
import { createManagedServerStore } from '../server/managed-server-store.mjs';
import { backupTeamDatabase } from '../../scripts/team-backup.mjs';

const PUBLIC = 'https://server-catalog.example.test';
const NOW = Date.parse('2026-09-11T12:00:00Z');
const companyQuery = company => `?company=${encodeURIComponent(company)}`;
const draft = (extra = {}) => ({ company: 'A公司', name: '训练节点', host: 'gpu.internal.example', port: 22, username: 'researcher', ...extra });

async function fixture(t, prepare) {
  const directory = mkdtempSync(join(tmpdir(), 'racktop-managed-servers-'));
  const dbPath = join(directory, 'team.sqlite'), distPath = join(directory, 'dist');
  mkdirSync(distPath); writeFileSync(join(distPath, 'index.html'), '<!doctype html><title>Server catalog fixture</title>');
  if (prepare) await prepare(dbPath, directory);
  const bootstrapToken = randomBytes(32).toString('base64url'), password = randomBytes(24).toString('base64url');
  const app = createTeamServer({ mode: 'account', host: '127.0.0.1', port: 0, publicUrl: PUBLIC, dbPath, distPath,
    nodeEnv: 'production', bootstrapToken, now: () => NOW });
  await app.auth.provisionSuperAdmin({ mode: 'create', password });
  const { port } = await app.start();
  t.after(async () => { await app.close(); rmSync(directory, { recursive: true, force: true }); });
  const call = (path, { method = 'GET', body, session, token, headers = {}, legacy = false } = {}) => new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const req = request({ host: '127.0.0.1', port, path, method, agent: false, headers: {
      host: new URL(PUBLIC).host, origin: PUBLIC,
      ...(data === undefined ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) }),
      ...(session ? { cookie: session.cookie, 'x-csrf-token': session.csrfToken,
        ...(legacy ? {} : { 'x-racktop-company': encodeURIComponent(session.user?.company ?? '') }) } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers,
    } }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString();
        resolve({ status: res.statusCode, headers: res.headers, text, body: JSON.parse(text) });
      });
    });
    req.on('error', reject); req.end(data);
  });
  const sessionOf = response => ({ cookie: response.headers['set-cookie']?.[0]?.split(';')[0], csrfToken: response.body.csrfToken, user: response.body.user });
  const anonymous = async () => sessionOf(await call('/api/session'));
  const login = async (name, supplied = '密') => {
    const result = await call('/api/auth/login', { method: 'POST', session: await anonymous(), body: { username: name, password: supplied } });
    assert.equal(result.status, 200, result.text); return sessionOf(result);
  };
  const admin = await login('admin', password);
  const add = async (name, companies = ['A公司']) => {
    const result = await call('/api/admin/members', { method: 'POST', session: admin, body: { name, password: '密', companies } });
    assert.equal(result.status, 201, result.text);
    return { member: result.body.member, session: await login(name) };
  };
  const localAdmin = async (name = '组织管理员', companies = ['A公司']) => {
    const registered = await call('/api/auth/register', { method: 'POST', session: await anonymous(), body: { name, password: '密', bootstrapToken } });
    assert.equal(registered.status, 201, registered.text);
    const assigned = await call(`/api/admin/members/${registered.body.user.id}`, { method: 'PATCH', session: admin, body: { version: 1, companies } });
    assert.equal(assigned.status, 200, assigned.text);
    const session = await login(name);
    assert.equal(session.user.role, 'admin'); assert.equal(session.user.isSuperAdmin, false);
    return { member: assigned.body.member, session };
  };
  return { app, call, admin, add, localAdmin, login, anonymous, dbPath, directory };
}

test('server catalog administrators create, update and explicitly grant metadata with optimistic version checks', async t => {
  const { call, admin, add, localAdmin } = await fixture(t);
  const maintainer = await localAdmin(), reader = await add('授权成员');
  const created = await call('/api/servers', { method: 'POST', session: maintainer.session, body: draft({ memberIds: [reader.member.id] }) });
  assert.equal(created.status, 201, created.text);
  let server = created.body.server;
  assert.deepEqual(Object.keys(server).sort(), ['id', 'company', 'name', 'host', 'port', 'username', 'jump', 'enabled', 'version', 'updatedAt', 'memberIds'].sort());
  assert.equal(server.version, 1); assert.equal(server.enabled, true); assert.equal(server.jump, null);
  assert.deepEqual(server.memberIds, [reader.member.id]);
  const snapshot = await call('/api/servers', { session: reader.session });
  assert.equal(snapshot.status, 200, snapshot.text); assert.equal(snapshot.headers['cache-control'], 'no-store');
  assert.equal(snapshot.body.schemaVersion, 1); assert.match(snapshot.body.revision, /^[a-f0-9]{64}$/);
  assert.equal(snapshot.body.servers.length, 1); assert.equal(Object.hasOwn(snapshot.body.servers[0], 'memberIds'), false);
  assert.equal((await call('/api/servers', { session: reader.session })).body.revision, snapshot.body.revision);
  const updated = await call(`/api/servers/${server.id}`, { method: 'PATCH', session: maintainer.session, body: { version: 1, host: 'gpu-next.internal.example', port: 2222 } });
  assert.equal(updated.status, 200, updated.text); server = updated.body.server;
  assert.equal(server.version, 2); assert.equal(server.port, 2222);
  assert.notEqual((await call('/api/servers', { session: reader.session })).body.revision, snapshot.body.revision);
  for (const [suffix, method, body] of [['', 'PATCH', { version: 1, name: '过期写入' }], ['/grants', 'PUT', { version: 1, memberIds: [] }]]) {
    const stale = await call(`/api/servers/${server.id}${suffix}`, { method, session: admin, body });
    assert.equal(stale.status, 409, stale.text); assert.equal(stale.body.error.code, 'VERSION_CONFLICT');
  }
  const revoked = await call(`/api/servers/${server.id}/grants`, { method: 'PUT', session: maintainer.session, body: { version: 2, memberIds: [] } });
  assert.equal(revoked.status, 200, revoked.text); assert.equal(revoked.body.server.version, 3);
  assert.deepEqual((await call('/api/servers', { session: reader.session })).body.servers, []);
  assert.equal((await call(`/api/servers/${server.id}`, { session: reader.session })).status, 404);
  assert.equal((await call(`/api/servers/${server.id}`, { session: admin })).body.server.host, 'gpu-next.internal.example');
});

test('ungranted and cross-company members see no server metadata while ordinary admins remain in their active organization', async t => {
  const { call, admin, add, localAdmin, anonymous } = await fixture(t);
  const maintainer = await localAdmin(), reader = await add('读者'), peer = await add('同组织未授权'), outsider = await add('另一组织', ['B公司']);
  const pending = await add('待分配', []);
  const first = await call('/api/servers', { method: 'POST', session: admin, body: draft({ name: '未公开训练节点', host: 'secret-a.internal', memberIds: [reader.member.id] }) });
  const second = await call('/api/servers', { method: 'POST', session: admin, body: draft({ company: 'B公司', host: 'secret-b.internal', memberIds: [outsider.member.id] }) });
  assert.equal(first.status, 201, first.text); assert.equal(second.status, 201, second.text);
  const id = first.body.server.id;
  assert.equal((await call('/api/servers', { session: await anonymous() })).status, 401);
  assert.equal((await call('/api/servers', { session: pending.session })).status, 403);
  assert.deepEqual((await call('/api/servers', { session: peer.session })).body.servers, []);
  for (const session of [peer.session, outsider.session]) {
    const hidden = await call(`/api/servers/${id}`, { session });
    assert.equal(hidden.status, 404, hidden.text); assert.equal(hidden.text.includes('secret-a'), false); assert.equal(hidden.text.includes('未公开训练节点'), false);
  }
  for (const [path, method, body] of [
    [`/api/servers/${id}`, 'PATCH', { version: 1, host: 'forged.internal' }],
    [`/api/servers/${id}/grants`, 'PUT', { version: 1, memberIds: [reader.member.id] }],
    ['/api/servers', 'POST', draft()],
    ['/api/servers/members', 'GET', undefined],
  ]) {
    const denied = await call(path, { method, body, session: reader.session });
    assert.equal(denied.status, 403, denied.text); assert.equal(denied.body.error.code, 'ADMIN_REQUIRED');
  }
  for (const [path, method, body] of [
    [`/api/servers/${second.body.server.id}`, 'GET', undefined],
    [`/api/servers/${second.body.server.id}`, 'PATCH', { version: 1, name: '跨组织修改' }],
    [`/api/servers/${second.body.server.id}/grants`, 'PUT', { version: 1, memberIds: [] }],
    ['/api/servers', 'POST', draft({ company: 'B公司' })],
    [`/api/servers${companyQuery('B公司')}`, 'GET', undefined],
    [`/api/servers/members${companyQuery('B公司')}`, 'GET', undefined],
  ]) assert.equal((await call(path, { method, body, session: maintainer.session })).status, 404, path);
  assert.equal((await call('/api/admin/members', { session: maintainer.session })).status, 403, 'resource admin is not a superadmin');
  const roster = await call('/api/servers/members', { session: maintainer.session });
  assert.equal(roster.status, 200, roster.text);
  assert.deepEqual(new Set(roster.body.members.map(row => row.id)), new Set([maintainer.member.id, reader.member.id, peer.member.id]));
  for (const member of roster.body.members) assert.deepEqual(Object.keys(member).sort(), ['id', 'name', 'username']);
  assert.equal((await call('/api/servers', { session: maintainer.session })).body.servers.length, 1);
  assert.equal((await call('/api/servers', { session: admin })).body.servers.length, 2);
  assert.equal((await call(`/api/servers${companyQuery('B公司')}`, { session: admin })).body.servers[0].id, second.body.server.id);
  const forgedScope = await call('/api/servers', { session: maintainer.session, headers: { 'x-racktop-company': encodeURIComponent('B公司') } });
  assert.equal(forgedScope.status, 409); assert.equal(forgedScope.body.error.code, 'COMPANY_CHANGED');
});

test('disabled servers and removed memberships disappear immediately; rejoining does not restore explicit grants', async t => {
  const { call, admin, add, dbPath } = await fixture(t);
  const reader = await add('多组织目录成员', ['A公司', '西浦']);
  const session = reader.session;
  const switched = await call('/api/auth/company', { method: 'POST', session, body: { company: '西浦' } });
  assert.equal(switched.status, 200, switched.text); session.user = switched.body.user;
  const device = await call('/api/auth/device-login', { method: 'POST', body: { username: reader.member.name, password: '密', deviceName: '目录客户端' } });
  assert.equal(device.status, 200, device.text);
  assert.equal((await call('/api/auth/company', { method: 'POST', token: device.body.token, body: { company: '西浦' } })).status, 200);
  const native = { token: device.body.token, headers: { 'x-racktop-company': encodeURIComponent('西浦') } };
  let server = (await call('/api/servers', { method: 'POST', session: admin, body: draft({ company: '西浦', memberIds: [reader.member.id] }) })).body.server;
  const path = `/api/servers/${server.id}`;
  assert.equal((await call('/api/servers', native)).body.servers.length, 1);
  server = (await call(path, { method: 'PATCH', session: admin, body: { version: server.version, enabled: false } })).body.server;
  for (const auth of [{ session }, native]) {
    assert.deepEqual((await call('/api/servers', auth)).body.servers, []);
    assert.equal((await call(path, auth)).status, 404);
  }
  assert.equal((await call(path, { session: admin })).body.server.enabled, false);
  server = (await call(path, { method: 'PATCH', session: admin, body: { version: server.version, enabled: true } })).body.server;
  assert.equal((await call('/api/servers', native)).body.servers.length, 1);
  let member = (await call(`/api/admin/members/${reader.member.id}`, { method: 'PATCH', session: admin, body: { version: reader.member.version, companies: ['A公司'] } })).body.member;
  for (const auth of [{ session }, native]) assert.equal((await call('/api/servers', auth)).status, 409);
  const db = new DatabaseSync(dbPath); t.after(() => db.close());
  assert.equal(db.prepare('SELECT COUNT(*) n FROM managed_server_grants WHERE user_id=?').get(member.id).n, 0);
  member = (await call(`/api/admin/members/${member.id}`, { method: 'PATCH', session: admin, body: { version: member.version, companies: ['A公司', '西浦'] } })).body.member;
  const rejoined = await call('/api/auth/company', { method: 'POST', session, body: { company: '西浦' } });
  assert.equal(rejoined.status, 200, rejoined.text); session.user = rejoined.body.user;
  assert.deepEqual((await call('/api/servers', { session })).body.servers, []);
  assert.equal((await call(path, { session })).status, 404);
  assert.equal((await call(`${path}/grants`, { method: 'PUT', session: admin, body: { version: server.version, memberIds: [member.id] } })).status, 200);
  assert.equal((await call('/api/servers', { session })).body.servers.length, 1);
  assert.equal((await call(`/api/admin/members/${member.id}`, { method: 'DELETE', session: admin, body: { version: member.version } })).status, 200);
  assert.equal((await call('/api/servers', { session })).status, 401);
  assert.equal((await call('/api/servers', native)).status, 401);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM managed_server_grants WHERE user_id=?').get(member.id).n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM managed_servers').get().n, 1, 'deleting a member preserves server records and audit');
});

test('SSH configuration accepts only structured destinations and rejects credentials, local paths and option injection', async t => {
  const { call, admin } = await fixture(t);
  const created = await call('/api/servers', { method: 'POST', session: admin, body: draft({ host: '2001:db8::8', username: 'build.user',
    jump: { host: 'bastion.internal.example', port: 2200, username: 'jump_user' } }) });
  assert.equal(created.status, 201, created.text);
  const server = created.body.server, path = `/api/servers/${server.id}`;
  assert.deepEqual(server.jump, { host: 'bastion.internal.example', port: 2200, username: 'jump_user' });
  const invalidFields = [
    { password: 'synthetic-rejected-password' }, { privateKey: 'synthetic-rejected-key' }, { private_key_path: '/tmp/key' },
    { privateKeyPath: '/tmp/key' }, { identityFile: '/tmp/key' }, { ssh_config_path: '/tmp/config' },
    { proxyCommand: 'sh -c unwanted' }, { options: ['-oProxyCommand=unwanted'] }, { proxy_jump: 'user@host -oX=y' },
    { host: '-oProxyCommand=unwanted' }, { host: 'user@host' }, { host: 'host;command' }, { host: 'host\nProxyCommand=unwanted' },
    { host: '/tmp/socket' }, { host: 'https://host' }, { host: 'host:22' }, { host: '' },
    { username: '-oOption' }, { username: 'user name' }, { username: 'user;command' }, { username: 'user\n' },
    { port: 0 }, { port: 65536 }, { port: 22.5 }, { port: '22' }, { enabled: 'true' },
    { jump: 'user@host' }, { jump: { host: 'jump', port: 22, username: 'user', password: 'secret' } },
    { jump: { host: 'jump', port: 22, username: 'user', privateKeyPath: '/tmp/key' } },
    { jump: { host: 'jump -oProxyCommand=x', port: 22, username: 'user' } },
    { jump: { host: 'jump', port: 22, username: '-oOption' } },
    { company: '' }, { company: null }, { company: 'other' }, { memberIds: null },
  ];
  for (const bad of invalidFields) {
    const rejected = await call('/api/servers', { method: 'POST', session: admin, body: draft(bad) });
    assert.equal(rejected.status, 422, JSON.stringify(bad));
  }
  for (const bad of [{ password: 'secret' }, { company: 'B公司' }, { memberIds: [] }, { jump: { host: 'jump', port: 22, username: 'user', options: '-J x' } }]) {
    assert.equal((await call(path, { method: 'PATCH', session: admin, body: { version: 1, ...bad } })).status, 422);
  }
  const cleared = await call(path, { method: 'PATCH', session: admin, body: { version: 1, jump: null } });
  assert.equal(cleared.status, 200, cleared.text); assert.equal(cleared.body.server.jump, null);
  const catalog = await call('/api/servers', { session: admin });
  assert.equal(catalog.body.servers.length, 1);
  assert.equal(catalog.text.includes('synthetic-rejected'), false);
});

test('server grants require current same-company members and failed writes roll back versions, grants and audit together', async t => {
  const { call, admin, add, dbPath } = await fixture(t);
  const reader = await add('保留授权'), outsider = await add('跨组织授权', ['B公司']), pending = await add('未分配授权', []);
  const server = (await call('/api/servers', { method: 'POST', session: admin, body: draft({ memberIds: [reader.member.id] }) })).body.server;
  const path = `/api/servers/${server.id}`;
  for (const ids of [[reader.member.id, reader.member.id], [outsider.member.id], [pending.member.id], [admin.user.id], [randomUUID()], ['bad'], null, {}]) {
    const rejected = await call(`${path}/grants`, { method: 'PUT', session: admin, body: { version: 1, memberIds: ids } });
    assert.equal(rejected.status, 422, rejected.text);
  }
  const db = new DatabaseSync(dbPath); t.after(() => db.close());
  const before = db.prepare('SELECT * FROM managed_server_audit ORDER BY id').all();
  db.exec("CREATE TRIGGER reject_catalog_audit BEFORE INSERT ON managed_server_audit BEGIN SELECT RAISE(ABORT,'fixture write failure'); END");
  const rejected = await call(`${path}/grants`, { method: 'PUT', session: admin, body: { version: 1, memberIds: [] } });
  assert.equal(rejected.status, 500); assert.equal(rejected.text.includes('fixture write failure'), false);
  const retained = (await call(path, { session: admin })).body.server;
  assert.equal(retained.version, 1); assert.deepEqual(retained.memberIds, [reader.member.id]);
  assert.deepEqual(db.prepare('SELECT * FROM managed_server_audit ORDER BY id').all(), before);
  db.exec('DROP TRIGGER reject_catalog_audit');
  const racing = await Promise.all([
    call(path, { method: 'PATCH', session: admin, body: { version: 1, name: '并发更新' } }),
    call(`${path}/grants`, { method: 'PUT', session: admin, body: { version: 1, memberIds: [] } }),
  ]);
  assert.deepEqual(racing.map(result => result.status).sort(), [200, 409]);
  assert.equal((await call(path, { session: admin })).body.server.version, 2);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM managed_server_audit').get().n, 2);
});

test('server routes reject unsupported query and method combinations and retain CSRF and origin protections', async t => {
  const { call, admin } = await fixture(t);
  const server = (await call('/api/servers', { method: 'POST', session: admin, body: draft() })).body.server;
  for (const query of ['?unknown=x', '?company=', '?company=other', `?company=${encodeURIComponent('A公司')}&company=${encodeURIComponent('B公司')}`]) {
    assert.equal((await call(`/api/servers${query}`, { session: admin })).status, 422, query);
  }
  for (const [path, method, body] of [
    [`/api/servers/${server.id}${companyQuery('A公司')}`, 'GET', undefined],
    [`/api/servers${companyQuery('A公司')}`, 'POST', draft()],
    [`/api/servers/${server.id}${companyQuery('A公司')}`, 'PATCH', { version: 1, name: 'ignored scope' }],
    [`/api/servers/${server.id}/grants${companyQuery('A公司')}`, 'PUT', { version: 1, memberIds: [] }],
  ]) assert.equal((await call(path, { method, session: admin, body })).status, 422, path);
  for (const [path, method] of [['/api/servers', 'DELETE'], [`/api/servers/${server.id}`, 'DELETE'], [`/api/servers/${server.id}/grants`, 'POST']]) {
    assert.equal((await call(path, { method, session: admin, body: {} })).status, 405);
  }
  for (const headers of [{ 'x-csrf-token': 'bad' }, { origin: 'https://evil.example' }]) {
    const result = await call(`/api/servers/${server.id}`, { method: 'PATCH', session: admin, headers, body: { version: 1, name: 'forbidden' } });
    assert.equal(result.status, 403, result.text);
  }
  assert.equal((await call(`/api/servers/${server.id}`, { session: admin })).body.server.version, 1);
});

test('an old account database migrates without identity loss and online backup restores every new catalog row and grant', async t => {
  let original, beforePath;
  const legacyId = randomUUID();
  const { call, admin, app, dbPath, directory } = await fixture(t, async (path, root) => {
    const db = new DatabaseSync(path);
    db.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE account_users(id TEXT PRIMARY KEY,username TEXT NOT NULL UNIQUE,name TEXT NOT NULL,name_key TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,role TEXT NOT NULL,created_at INTEGER NOT NULL,company TEXT);
      CREATE TABLE retained_assets(id TEXT PRIMARY KEY,name TEXT NOT NULL,serial TEXT NOT NULL);
      INSERT INTO retained_assets VALUES('asset-1','旧设备记录','00001234');`);
    db.prepare('INSERT INTO account_users VALUES(?,?,?,?,?,?,?,?)').run(legacyId, 'legacy-user', '旧组织成员', '旧组织成员', 'preserved-synthetic-hash', 'member', NOW - 86_400_000, 'A公司');
    original = { ...db.prepare('SELECT * FROM account_users').get() };
    beforePath = join(root, 'before-migration.sqlite');
    await backupTeamDatabase(path, beforePath); db.close();
  });
  assert.deepEqual(app.auth.getMemberIdentity(legacyId).companies, ['A公司']);
  const server = await call('/api/servers', { method: 'POST', session: admin, body: draft({ memberIds: [legacyId], jump: { host: 'bastion.internal', port: 22, username: 'bridge' } }) });
  assert.equal(server.status, 201, server.text);
  assert.equal((await call(`/api/servers/${server.body.server.id}`, { method: 'PATCH', session: admin, body: { version: 1, port: 2222 } })).status, 200);
  const live = new DatabaseSync(dbPath); t.after(() => live.close());
  const preserved = live.prepare('SELECT * FROM account_users WHERE id=?').get(legacyId);
  for (const [key, value] of Object.entries(original)) assert.equal(preserved[key], value, key);
  const before = new DatabaseSync(beforePath, { readOnly: true });
  try {
    assert.deepEqual({ ...before.prepare('SELECT * FROM account_users').get() }, original);
    assert.equal(before.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name='managed_servers'").get().n, 0);
  } finally { before.close(); }
  const backupPath = join(directory, 'after-migration.sqlite');
  await backupTeamDatabase(dbPath, backupPath);
  const restored = new DatabaseSync(backupPath, { readOnly: true });
  try {
    for (const table of ['account_users', 'account_user_companies', 'managed_servers', 'managed_server_grants', 'managed_server_audit', 'retained_assets']) {
      assert.deepEqual(restored.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(), live.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(), table);
    }
    assert.equal(restored.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    assert.deepEqual(restored.prepare('PRAGMA foreign_key_check').all(), []);
  } finally { restored.close(); }
  const restoredAuth = createAccountAuth({ publicUrl: PUBLIC, host: '127.0.0.1', dbPath: backupPath, nodeEnv: 'production', now: () => NOW });
  const restoredStore = createManagedServerStore({ dbPath: backupPath, now: () => NOW });
  try {
    const identity = restoredAuth.getMemberIdentity(legacyId);
    const catalog = restoredStore.list(identity);
    assert.equal(catalog.servers.length, 1); assert.equal(catalog.servers[0].port, 2222);
    assert.deepEqual(catalog.servers[0].jump, { host: 'bastion.internal', port: 22, username: 'bridge' });
  } finally { restoredStore.close(); restoredAuth.close(); }
});

test('fresh account permissions reject forged superadmin and stale administrator claims in the store', async t => {
  const { call, admin, add, localAdmin, dbPath } = await fixture(t);
  const maintainer = await localAdmin(), reader = await add('不能提升的成员');
  const id = (await call('/api/servers', { method: 'POST', session: admin, body: draft() })).body.server.id;
  const store = createManagedServerStore({ dbPath, now: () => NOW }); t.after(() => store.close());
  for (const claim of [{ ...reader.session.user, role: 'admin' }, { ...reader.session.user, role: 'admin', isSuperAdmin: true }]) {
    assert.throws(() => store.list(claim), { code: 'ACCOUNT_CHANGED' });
    assert.throws(() => store.get(id, claim), { code: 'ACCOUNT_CHANGED' });
  }
  const db = new DatabaseSync(dbPath); t.after(() => db.close());
  db.prepare("UPDATE account_users SET role='member',version=version+1 WHERE id=?").run(maintainer.member.id);
  assert.throws(() => store.list(maintainer.session.user), { code: 'ACCOUNT_CHANGED' });
  assert.throws(() => store.update(id, { version: 1, name: 'stale admin' }, maintainer.session.user), { code: 'ACCOUNT_CHANGED' });
  assert.deepEqual((await call('/api/servers', { session: maintainer.session })).body.servers, []);
  db.prepare("UPDATE account_users SET role='member',version=version+1 WHERE id=?").run(admin.user.id);
  assert.throws(() => store.list(admin.user), { code: 'ACCOUNT_CHANGED' }, 'the cross-company superadmin list also rechecks the current role');
});
