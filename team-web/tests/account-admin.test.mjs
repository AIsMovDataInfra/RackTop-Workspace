import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { createAccountAuth, ACCOUNT_COMPANIES } from '../server/account-auth.mjs';

const BASE = { publicUrl: 'https://team.example.test', host: '127.0.0.1', dbPath: ':memory:', nodeEnv: 'test' };
const SECRET = randomBytes(24).toString('base64url');
function browser(auth) {
  let cookie = '', csrfToken;
  return {
    request(method = 'GET', headers = {}) { return { method, socket: { remoteAddress: '127.0.0.1' },
      headers: { host: 'team.example.test', cookie, ...(method === 'GET' ? {} : { origin: BASE.publicUrl, 'x-csrf-token': csrfToken }), ...headers } }; },
    async call(path, method = 'GET', body, headers = {}) {
      const responseHeaders = new Map(), req = this.request(method, headers);
      const res = { statusCode: 200, getHeader(key) { return responseHeaders.get(key.toLowerCase()); },
        setHeader(key, value) { responseHeaders.set(key.toLowerCase(), value); }, end(value) { this.text = value; } };
      assert.equal(await auth.handle(req, res, new URL(path, BASE.publicUrl), body), true);
      const setCookie = res.getHeader('Set-Cookie');
      if (setCookie) cookie = setCookie.at(-1).split(';')[0];
      const payload = JSON.parse(res.text);
      if (payload.csrfToken) csrfToken = payload.csrfToken;
      return { status: res.statusCode, payload, req };
    },
    async login(username = 'admin', password = SECRET) { await this.call('/api/session'); return this.call('/api/auth/login', 'POST', { username, password }); },
    async register(username = '员工', extra = {}) { await this.call('/api/session'); return this.call('/api/auth/register', 'POST', { username, name: username, password: '密', ...extra }); },
  };
}
async function setup(t, config = {}) {
  const auth = createAccountAuth({ ...BASE, ...config }); t.after(() => auth.close());
  const seeded = await auth.provisionSuperAdmin({ mode: 'create', password: SECRET });
  const admin = browser(auth); await admin.login();
  return { auth, admin, seeded: seeded.member };
}
async function employee(admin, username = '员工') {
  return (await admin.call('/api/admin/members', 'POST', { username, name: username, password: '密', company: '西浦' })).payload.member;
}
function temporary(t) {
  const directory = mkdtempSync(join(tmpdir(), 'racktop-members-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return join(directory, 'team.sqlite');
}

test('only the single super administrator sees member profiles; ordinary admin cannot forge authority', async t => {
  const token = randomBytes(32).toString('base64url');
  const { auth, admin, seeded } = await setup(t, { bootstrapToken: token });
  const member = browser(auth), legacyAdmin = browser(auth), anonymous = browser(auth);
  await member.register();
  await legacyAdmin.register('旧管理员', { bootstrapToken: token });
  for (const client of [member, legacyAdmin]) {
    await assert.rejects(client.call('/api/admin/members'), { status: 403, code: 'SUPERADMIN_REQUIRED' });
    await assert.rejects(client.call('/api/admin/members', 'POST', { username: '冒充', name: '冒充', password: '密', company: '西浦', isSuperAdmin: true }), { status: 403 });
  }
  await assert.rejects(anonymous.call('/api/admin/members'), { status: 401 });
  const listed = (await admin.call('/api/admin/members')).payload.members;
  assert.equal(listed.length, 3); assert.equal(listed.filter(row => row.isSuperAdmin).length, 1);
  assert.equal(listed.find(row => row.id === seeded.id).isSuperAdmin, true);
  assert.equal(listed.find(row => row.username === '员工').company, null);
  const keys = ['id', 'username', 'name', 'role', 'isSuperAdmin', 'company', 'version', 'createdAt', 'recoveryRequestedAt'].sort();
  for (const row of listed) assert.deepEqual(Object.keys(row).sort(), keys);
  await assert.rejects(admin.call('/api/admin/members?all=true'), { status: 422 });
  await assert.rejects(admin.call('/api/admin/members', 'POST', { username: '伪造', name: '伪造', password: '密', company: '西浦', role: 'admin' }), { status: 422 });
});

test('company choices, own-company updates, CAS, CSRF, and permanent super-admin protection', async t => {
  const { admin, seeded } = await setup(t);
  const row = await employee(admin);
  for (const invalid of [null, '', '上海', 'D公司']) await assert.rejects(admin.call(`/api/admin/members/${row.id}`, 'PATCH', { version: row.version, company: invalid }), { code: 'INVALID_COMPANY' });
  for (const headers of [{ origin: 'https://evil.test' }, { 'x-csrf-token': undefined }]) {
    await assert.rejects(admin.call(`/api/admin/members/${row.id}`, 'DELETE', { version: row.version }, headers), { status: 403 });
  }
  const updated = (await admin.call(`/api/admin/members/${row.id}`, 'PATCH', { version: row.version, company: ACCOUNT_COMPANIES[0] })).payload.member;
  assert.equal(updated.company, 'A公司'); assert.equal(updated.version, row.version + 1);
  await assert.rejects(admin.call(`/api/admin/members/${row.id}`, 'DELETE', { version: row.version }), { status: 409 });
  const own = (await admin.call(`/api/admin/members/${seeded.id}`, 'PATCH', { version: seeded.version, company: '西浦' })).payload.member;
  assert.equal(own.company, '西浦');
  await assert.rejects(admin.call(`/api/admin/members/${seeded.id}`, 'DELETE', { version: own.version }), { code: 'SUPER_ADMIN_PROTECTED' });
  await assert.rejects(admin.call(`/api/admin/members/${seeded.id}/reset-password`, 'POST', { version: own.version, newPassword: '新' }), { code: 'SUPER_ADMIN_PROTECTED' });
});

test('reset revokes all browser/device sessions; deletion preserves a UUID tombstone and permits fresh identity reuse', async t => {
  const dbPath = temporary(t), { auth, admin } = await setup(t, { dbPath });
  const row = await employee(admin), a = browser(auth), b = browser(auth);
  await a.login('员工', '密'); await b.login('员工', '密');
  const oldA = a.request(), oldB = b.request();
  const grant = (await a.call('/api/auth/device-login', 'POST', { username: '员工', password: '密', deviceName: '测试设备' })).payload;
  const deviceReq = a.request('GET', { authorization: `Bearer ${grant.token}` });
  const reset = (await admin.call(`/api/admin/members/${row.id}/reset-password`, 'POST', { version: row.version, newPassword: '新' })).payload.member;
  for (const req of [oldA, oldB, deviceReq]) assert.equal(auth.resolve(req), null);
  await assert.rejects(a.login('员工', '密'), { code: 'INVALID_CREDENTIALS' });
  await a.login('员工', '新');
  const nextA = a.request();
  await admin.call(`/api/admin/members/${row.id}`, 'DELETE', { version: reset.version });
  assert.equal(auth.resolve(nextA), null);
  await assert.rejects(a.login('员工', '新'), { code: 'INVALID_CREDENTIALS' });
  const replacement = await employee(admin);
  assert.notEqual(replacement.id, row.id);
  const db = new DatabaseSync(dbPath); t.after(() => db.close());
  const tombstone = db.prepare('SELECT * FROM account_users WHERE id = ?').get(row.id);
  assert.ok(tombstone.deleted_at); assert.equal(tombstone.password_hash, '!deleted');
  assert.notEqual(tombstone.username, '员工'); assert.equal(tombstone.company, null);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM account_sessions WHERE user_id = ?').get(row.id).n, 0);
  assert.deepEqual(db.prepare('SELECT action FROM account_admin_audit WHERE target_id = ? ORDER BY id').all(row.id).map(x => x.action), ['member-created', 'password-reset', 'member-deleted']);
  assert.equal((await admin.call('/api/admin/members')).payload.members.some(x => x.id === row.id), false);
});

test('recovery requests are anonymous-CSRF protected, non-enumerating, rate limited and never change passwords', async t => {
  let now = Date.now();
  const { auth, admin } = await setup(t, { now: () => now });
  const row = await employee(admin), visitor = browser(auth);
  await visitor.call('/api/session');
  await assert.rejects(visitor.call('/api/auth/recovery-request', 'POST', { username: '员工' }, { 'x-csrf-token': undefined }), { code: 'CSRF_REJECTED' });
  await assert.rejects(visitor.call('/api/auth/recovery-request', 'POST', { username: '员工' }, { origin: 'https://evil.test' }), { code: 'ORIGIN_REJECTED' });
  const known = await visitor.call('/api/auth/recovery-request', 'POST', { username: '员工' });
  const absent = await visitor.call('/api/auth/recovery-request', 'POST', { username: '不存在' });
  assert.deepEqual({ status: known.status, payload: known.payload }, { status: absent.status, payload: absent.payload });
  assert.deepEqual(known.payload, { ok: true });
  const pending = (await admin.call('/api/admin/members')).payload.members.find(x => x.id === row.id);
  assert.equal(pending.recoveryRequestedAt, new Date(now).toISOString()); assert.equal(pending.version, row.version + 1);
  await browser(auth).login('员工', '密');
  for (let i = 0; i < 2; i++) await visitor.call('/api/auth/recovery-request', 'POST', { username: '员工' });
  await assert.rejects(visitor.call('/api/auth/recovery-request', 'POST', { username: '员工' }), { status: 429 });
  const unchanged = (await admin.call('/api/admin/members')).payload.members.find(x => x.id === row.id);
  assert.equal(unchanged.version, pending.version);
  const reset = (await admin.call(`/api/admin/members/${row.id}/reset-password`, 'POST', { version: pending.version, newPassword: '新' })).payload.member;
  assert.equal(reset.recoveryRequestedAt, null);
});

test('asynchronous reset and create recheck target deletion, version and administrator permissions', async t => {
  const dbPath = temporary(t), { auth, admin, seeded } = await setup(t, { dbPath });
  const row = await employee(admin);
  const resetting = admin.call(`/api/admin/members/${row.id}/reset-password`, 'POST', { version: row.version, newPassword: '新' });
  const rejectedReset = assert.rejects(resetting, { code: 'MEMBER_NOT_FOUND' });
  await admin.call(`/api/admin/members/${row.id}`, 'DELETE', { version: row.version });
  await rejectedReset;
  const another = await employee(admin, '另一成员');
  const results = await Promise.allSettled([
    admin.call(`/api/admin/members/${another.id}/reset-password`, 'POST', { version: another.version, newPassword: '甲' }),
    admin.call(`/api/admin/members/${another.id}/reset-password`, 'POST', { version: another.version, newPassword: '乙' }),
  ]);
  assert.equal(results.filter(x => x.status === 'fulfilled').length, 1);
  assert.equal(results.find(x => x.status === 'rejected').reason.code, 'VERSION_CONFLICT');
  const changing = await employee(admin, '登录中');
  const loggingIn = browser(auth).login('登录中', '密');
  await admin.call(`/api/admin/members/${changing.id}`, 'PATCH', { version: changing.version, company: 'B公司' });
  assert.equal((await loggingIn).payload.user.company, 'B公司');
  const deletedDuringLogin = browser(auth).login('登录中', '密');
  const rejectedLogin = assert.rejects(deletedDuringLogin, { code: 'INVALID_CREDENTIALS' });
  // Wait until the login has its anonymous session and starts password derivation.
  await new Promise(resolve => setImmediate(resolve));
  await admin.call(`/api/admin/members/${changing.id}`, 'DELETE', { version: changing.version + 1 });
  await rejectedLogin;
  const creating = employee(admin, '不可创建');
  const rejectedCreate = assert.rejects(creating, { code: 'SUPERADMIN_REQUIRED' });
  const db = new DatabaseSync(dbPath); t.after(() => db.close());
  db.prepare('UPDATE account_users SET is_super_admin = 0, version = version + 1 WHERE id = ?').run(seeded.id);
  await rejectedCreate;
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM account_users WHERE username = '不可创建'").get().n, 0);
});

test('old database migration preserves identity, password hash and existing grants; bootstrap never upgrades a member', async t => {
  const dbPath = temporary(t), token = randomBytes(32).toString('base64url');
  const db = new DatabaseSync(dbPath);
  db.exec(`CREATE TABLE account_users (id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
    name_key TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('admin','member')), created_at INTEGER NOT NULL);
    CREATE TABLE account_sessions (token_hash TEXT PRIMARY KEY, user_id TEXT REFERENCES account_users(id) ON DELETE CASCADE,
      kind TEXT NOT NULL, device_name TEXT, remember_me INTEGER NOT NULL DEFAULT 0, expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL);`);
  db.prepare('INSERT INTO account_users VALUES(?,?,?,?,?,?,?)').run('retained-id', 'admin', '原成员', '原成员', 'preserved-hash', 'member', 1000);
  db.prepare('INSERT INTO account_sessions VALUES(?,?,?,NULL,0,?,?)').run(createHash('sha256').update(token).digest('base64url'), 'retained-id', 'browser', Date.now() + 60_000, 1000);
  db.close();
  const auth = createAccountAuth({ ...BASE, dbPath }); t.after(() => auth.close());
  const view = auth.resolve({ method: 'GET', headers: { host: 'team.example.test', cookie: `__Host-racktop_team_account_session=${token}` } });
  assert.equal(view.user.id, 'retained-id'); assert.equal(view.user.company, null); assert.equal(view.user.version, 1); assert.equal(view.user.isSuperAdmin, false);
  await assert.rejects(auth.provisionSuperAdmin({ mode: 'create', password: SECRET }), { code: 'ADMIN_NAME_IN_USE' });
  const reopened = new DatabaseSync(dbPath); t.after(() => reopened.close());
  assert.equal(reopened.prepare('SELECT password_hash FROM account_users').get().password_hash, 'preserved-hash');
  assert.equal(statSync(dbPath).mode & 0o777, 0o600);
});

function cli(args, input) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [resolve('scripts/team-admin.mjs'), ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = ''; child.stdout.on('data', chunk => out += chunk); child.stderr.on('data', chunk => err += chunk);
    child.once('error', reject); child.once('exit', code => resolvePromise({ code, out, err })); child.stdin.end(input);
  });
}
test('deployment CLI creates once, explicit reset revokes sessions, and no password is echoed or defaulted', async t => {
  const dbPath = temporary(t), args = ['--db', dbPath, '--public-url', BASE.publicUrl];
  const original = `  ${SECRET}  `;
  const created = await cli(['create', ...args], `${original}\n`);
  assert.equal(created.code, 0, created.err); assert.equal(JSON.parse(created.out).created, true);
  assert.equal(created.out.includes(SECRET), false); assert.equal(created.err.includes(SECRET), false);
  const second = await cli(['create', ...args], 'different fixture password\n');
  assert.equal(second.code, 0); assert.equal(JSON.parse(second.out).created, false);
  const auth = createAccountAuth({ ...BASE, dbPath }); t.after(() => auth.close());
  const admin = browser(auth); await admin.login('admin', original); const prior = admin.request();
  const reset = await cli(['reset', ...args], '新\n');
  assert.equal(reset.code, 0, reset.err); assert.equal(JSON.parse(reset.out).reset, true);
  assert.equal(auth.resolve(prior), null); await admin.login('admin', '新');
  const empty = await cli(['create', ...args], '\n'); assert.equal(empty.code, 1);
  const duplicate = await cli(['create', ...args, '--username', 'another-admin'], SECRET); assert.equal(duplicate.code, 1); assert.match(duplicate.err, /SUPER_ADMIN_EXISTS/);
});
