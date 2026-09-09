import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, scryptSync } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createAccountAuth, ACCOUNT_AVATARS } from '../server/account-auth.mjs';

const BASE = { mode: 'account', publicUrl: 'https://team.example.test', host: '127.0.0.1', dbPath: ':memory:', nodeEnv: 'test' };
const PASSWORD = 'a sufficiently long passphrase';
const BOOTSTRAP = randomBytes(32).toString('base64url');
function browser(auth, overrides = {}) {
  const cookies = new Map();
  let csrfToken;
  return {
    auth,
    get cookie() { return [...cookies].map(([key, value]) => `${key}=${value}`).join('; '); },
    get csrfToken() { return csrfToken; },
    request(method = 'POST', headers = {}) {
      return { method, socket: { remoteAddress: '127.0.0.1' }, headers: { host: 'team.example.test', cookie: this.cookie,
        ...(method !== 'GET' ? { origin: BASE.publicUrl, 'x-csrf-token': csrfToken } : {}), ...overrides, ...headers } };
    },
    async call(path, { method = 'GET', body, headers = {} } = {}) {
      const req = this.request(method, headers), responseHeaders = new Map();
      const res = { statusCode: 200, getHeader(key) { return responseHeaders.get(key.toLowerCase()); },
        setHeader(key, value) { responseHeaders.set(key.toLowerCase(), value); }, end(value) { this.text = value; } };
      await this.auth.handle(req, res, new URL(path, BASE.publicUrl), body);
      for (const item of res.getHeader('Set-Cookie') ?? []) {
        const [key, value] = item.split(';')[0].split('='); cookies.set(key, value);
      }
      const payload = res.text ? JSON.parse(res.text) : null;
      if (payload?.csrfToken) csrfToken = payload.csrfToken;
      return { req, res, payload };
    },
    async register(body = {}) {
      await this.call('/api/session');
      return this.call('/api/auth/register', { method: 'POST', body: { username: 'member', name: '成员', password: PASSWORD, ...body } });
    },
  };
}
function native(auth, headers = {}) {
  return browser(auth, { cookie: undefined, 'x-csrf-token': undefined, ...headers });
}
async function device(client, extra = {}) {
  return client.call('/api/auth/device-login', { method: 'POST', body: { username: 'member', password: PASSWORD, deviceName: 'Linux 工作站', ...extra } });
}

test('account configuration enforces production HTTPS and strong bootstrap token', () => {
  for (const config of [{ publicUrl: 'http://team.example.test' }, { publicUrl: 'https://team.example.test/subpath' }, { bootstrapToken: 'short' }]) {
    assert.throws(() => createAccountAuth({ ...BASE, ...config }));
  }
  assert.throws(() => createAccountAuth({ ...BASE, publicUrl: 'http://127.0.0.1', nodeEnv: 'production' }), /HTTPS/);
  const local = createAccountAuth({ ...BASE, publicUrl: 'http://127.0.0.1' }); local.close();
});

test('registration yields a stable member UUID, normalized unique identity and no email requirement', async t => {
  const auth = createAccountAuth(BASE); t.after(() => auth.close());
  const client = browser(auth);
  const { payload, res } = await client.register({ username: ' Member ', name: '  小林  ' });
  assert.equal(res.statusCode, 201);
  assert.match(payload.user.id, /^[0-9a-f-]{36}$/);
  assert.deepEqual({ ...payload.user, id: undefined }, { id: undefined, name: '小林', username: 'member', role: 'member', isSuperAdmin: false, company: null, version: 1, avatar: 'user' });
  assert.equal(payload.authMode, 'account');
  assert.equal(Object.hasOwn(payload.user, 'email'), false);
  assert.equal(payload.accountRegistration, true);
  assert.equal(payload.feishuConfigured, false);
  assert.equal(payload.demoUsers, undefined);
  assert.match(res.getHeader('Set-Cookie')[0], /^__Host-racktop_team_account_session=.*; Path=\/; HttpOnly; SameSite=Lax; Max-Age=28800; Secure$/);
  assert.equal(auth.resolve(client.request()).user.id, payload.user.id);
  await assert.rejects(browser(auth).register({ username: 'MEMBER', name: '小周' }), { code: 'ACCOUNT_EXISTS' });
  await assert.rejects(browser(auth).register({ username: 'other', name: '小林' }), { code: 'ACCOUNT_EXISTS' });
  await assert.rejects(browser(auth).register({ username: 'other', role: 'admin' }), { code: 'INVALID_INPUT' });
});

test('only a matching one-use bootstrap token creates admin; configured admin username cannot be squatted', async t => {
  const auth = createAccountAuth({ ...BASE, adminUsername: 'owner', bootstrapToken: BOOTSTRAP }); t.after(() => auth.close());
  await assert.rejects(browser(auth).register({ username: 'owner' }), { code: 'BOOTSTRAP_REQUIRED' });
  await assert.rejects(browser(auth).register({ username: 'owner', bootstrapToken: randomBytes(32).toString('base64url') }), { code: 'BOOTSTRAP_REJECTED' });
  await assert.rejects(browser(auth).register({ username: 'attacker', bootstrapToken: BOOTSTRAP }), { code: 'BOOTSTRAP_REJECTED' });
  assert.equal((await browser(auth).register()).payload.user.role, 'member');
  const owner = await browser(auth).register({ username: 'OWNER', name: '站点管理员', bootstrapToken: BOOTSTRAP });
  assert.equal(owner.payload.user.role, 'admin');
  await assert.rejects(browser(auth).register({ username: 'owner', name: '另一个管理员', bootstrapToken: BOOTSTRAP }), { code: 'BOOTSTRAP_REJECTED' });
});

test('concurrent bootstrap claims are atomic and never create two administrators', async t => {
  const auth = createAccountAuth({ ...BASE, bootstrapToken: BOOTSTRAP }); t.after(() => auth.close());
  const a = browser(auth), b = browser(auth);
  const result = await Promise.allSettled([
    a.register({ username: 'alice', name: 'A', bootstrapToken: BOOTSTRAP }),
    b.register({ username: 'bobby', name: 'B', bootstrapToken: BOOTSTRAP }),
  ]);
  assert.equal(result.filter(item => item.status === 'fulfilled').length, 1);
  assert.equal(result.find(item => item.status === 'fulfilled').value.payload.user.role, 'admin');
  assert.equal(result.find(item => item.status === 'rejected').reason.code, 'BOOTSTRAP_REJECTED');
});

test('browser CSRF, origin, host, duplicate cookies and privilege checks fail closed', async t => {
  const auth = createAccountAuth(BASE); t.after(() => auth.close());
  const client = browser(auth);
  await client.call('/api/session');
  const body = { username: 'member', name: '成员', password: PASSWORD };
  for (const headers of [{ 'x-csrf-token': undefined }, { 'x-csrf-token': 'x'.repeat(43) }, { cookie: `${client.cookie}; ${client.cookie}` }]) {
    await assert.rejects(client.call('/api/auth/register', { method: 'POST', body, headers }), { code: 'CSRF_REJECTED' });
  }
  for (const headers of [{ origin: undefined }, { origin: 'https://evil.test' }, { 'sec-fetch-site': 'cross-site' }]) {
    await assert.rejects(client.call('/api/auth/register', { method: 'POST', body, headers }), { code: 'ORIGIN_REJECTED' });
  }
  await assert.rejects(client.call('/api/session', { headers: { host: 'evil.test' } }), { code: 'HOST_REJECTED' });
  await client.register();
  const req = client.request(), session = auth.resolve(req);
  assert.doesNotThrow(() => auth.verifyWrite(req, session));
  assert.throws(() => auth.verifyWrite(req, { ...session, user: { ...session.user, role: 'admin' } }), { code: 'AUTH_REQUIRED' });
  assert.throws(() => auth.verifyWrite(client.request('POST', { 'x-csrf-token': undefined }), session), { code: 'CSRF_REJECTED' });
});

test('login rotates session and CSRF, preserves identity, and logout invalidates the previous session', async t => {
  const auth = createAccountAuth(BASE); t.after(() => auth.close());
  const client = browser(auth), registered = await client.register(), old = client.request();
  await client.call('/api/auth/logout', { method: 'POST', body: {} });
  assert.equal(auth.resolve(old), null);
  const anonymousCookie = client.cookie, anonymousCsrf = client.csrfToken;
  await assert.rejects(client.call('/api/auth/login', { method: 'POST', body: { username: 'member', password: 'a wrong password value' } }), { code: 'INVALID_CREDENTIALS' });
  const login = await client.call('/api/auth/login', { method: 'POST', body: { username: 'Member', password: PASSWORD } });
  assert.equal(login.payload.user.id, registered.payload.user.id);
  assert.notEqual(client.cookie, anonymousCookie); assert.notEqual(client.csrfToken, anonymousCsrf);
  await assert.rejects(client.call('/api/auth/logout', { method: 'POST', body: {}, headers: { 'x-csrf-token': anonymousCsrf } }), { code: 'CSRF_REJECTED' });
});

test('new passwords reject only empty or whitespace-only input and preserve surrounding spaces', async t => {
  const auth = createAccountAuth(BASE); t.after(() => auth.close());
  const client = browser(auth);
  await client.call('/api/session');
  for (const value of ['', '   ', '\t\n', null, 123]) await assert.rejects(client.register({ password: value }), { code: 'INVALID_PASSWORD' });
  const spaced = '  preserve these spaces  ';
  await client.register({ password: spaced });
  await client.call('/api/auth/logout', { method: 'POST', body: {} });
  await assert.rejects(client.call('/api/auth/login', { method: 'POST', body: { username: 'member', password: spaced.trim() } }), { code: 'INVALID_CREDENTIALS' });
  assert.equal((await client.call('/api/auth/login', { method: 'POST', body: { username: 'member', password: spaced } })).payload.user.role, 'member');
});

test('single member name rejects only a non-string or blank value and preserves embedded characters', async t => {
  const auth = createAccountAuth(BASE); t.after(() => auth.close());
  const client = browser(auth); await client.call('/api/session');
  for (const value of ['', '   ', '\t\n', null, 123]) {
    await assert.rejects(client.call('/api/auth/register', { method: 'POST', body: { name: value, password: '密' } }), { code: 'INVALID_NAME' });
  }
  const name = 'Member\u200b中文\u0001';
  const registered = await client.call('/api/auth/register', { method: 'POST', body: { name: `  ${name}  `, password: '密' } });
  assert.equal(registered.payload.user.name, name); assert.equal(registered.payload.user.username, name);
  await client.call('/api/auth/logout', { method: 'POST', body: {} });
  const login = await client.call('/api/auth/login', { method: 'POST', body: { username: name, password: '密' } });
  assert.equal(login.payload.user.id, registered.payload.user.id);
});

test('device grants require origin, contain no cookie, validate bearer and revoke independently', async t => {
  const auth = createAccountAuth(BASE); t.after(() => auth.close());
  const owner = browser(auth); await owner.register();
  const client = native(auth);
  await assert.rejects(device(native(auth, { origin: undefined })), { code: 'ORIGIN_REJECTED' });
  const grant = await device(client), token = grant.payload.token;
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(grant.res.getHeader('Set-Cookie'), undefined);
  const req = client.request('POST', { authorization: `Bearer ${token}` }), session = auth.resolve(req);
  assert.equal(session.kind, 'device'); assert.equal(session.csrfToken, null);
  assert.doesNotThrow(() => auth.verifyWrite(req, session));
  assert.throws(() => auth.verifyWrite({ ...req, headers: { ...req.headers, origin: undefined } }, session), { code: 'ORIGIN_REJECTED' });
  assert.equal(auth.resolve(client.request('GET', { authorization: 'Bearer invalid' })), null);
  // Invalid bearer must not fall through to a logged-in browser cookie.
  assert.equal(auth.resolve(owner.request('GET', { authorization: 'Bearer invalid' })), null);
  await client.call('/api/auth/device-logout', { method: 'POST', body: {}, headers: { authorization: `Bearer ${token}` } });
  assert.equal(auth.resolve(req), null);
  assert.ok(auth.resolve(owner.request()));
  await assert.rejects(client.call('/api/session', { headers: { authorization: `Bearer ${token}` } }), { code: 'AUTH_REQUIRED' });
});

test('browser caller cannot bypass CSRF through device login', async t => {
  const auth = createAccountAuth(BASE); t.after(() => auth.close());
  const client = browser(auth); await client.register();
  await assert.rejects(client.call('/api/auth/device-login', { method: 'POST', headers: { 'x-csrf-token': undefined }, body: { username: 'member', password: PASSWORD, deviceName: 'Browser' } }), { code: 'CSRF_REJECTED' });
});

test('password change rotates current browser and revokes all other browser and device grants', async t => {
  const auth = createAccountAuth(BASE); t.after(() => auth.close());
  const owner = browser(auth); await owner.register();
  const other = browser(auth); await other.call('/api/session');
  await other.call('/api/auth/login', { method: 'POST', body: { username: 'member', password: PASSWORD } });
  const ownerBefore = owner.request(), otherBefore = other.request();
  const client = native(auth), grant = await device(client), deviceReq = client.request('GET', { authorization: `Bearer ${grant.payload.token}` });
  await assert.rejects(owner.call('/api/auth/change-password', { method: 'POST', body: { oldPassword: 'wrong previous password', newPassword: 'a new password for account' } }), { code: 'INVALID_CREDENTIALS' });
  const changed = await owner.call('/api/auth/change-password', { method: 'POST', body: { oldPassword: PASSWORD, newPassword: 'a new password for account' } });
  assert.ok(changed.payload.user);
  assert.equal(auth.resolve(ownerBefore), null); assert.equal(auth.resolve(otherBefore), null); assert.equal(auth.resolve(deviceReq), null);
  assert.ok(auth.resolve(owner.request()));
  await assert.rejects(device(client), { code: 'INVALID_CREDENTIALS' });
  assert.ok((await device(client, { password: 'a new password for account' })).payload.token);
});

test('accounts, sessions and one-time admin claim survive restart, storing only token digests and salted hashes', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'racktop-account-auth-')), dbPath = join(directory, 'accounts.sqlite');
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  let auth = createAccountAuth({ ...BASE, dbPath, bootstrapToken: BOOTSTRAP });
  t.after(() => auth.close());
  const client = browser(auth), result = await client.register({ bootstrapToken: BOOTSTRAP, rememberMe: true });
  const bearer = (await device(native(auth))).payload.token;
  const rawCookie = client.cookie.split('=')[1];
  auth.close();
  assert.equal(statSync(dbPath).mode & 0o777, 0o600);
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const account = db.prepare('SELECT * FROM account_users').get();
  assert.match(account.password_hash, /^scrypt-32768-8-3\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{43}$/);
  const rows = db.prepare('SELECT * FROM account_sessions').all(); db.close();
  assert.equal(rows.some(row => row.token_hash === bearer || row.token_hash === rawCookie), false);
  assert.equal(readFileSync(dbPath).includes(Buffer.from(PASSWORD)), false);
  assert.equal(readFileSync(dbPath).includes(Buffer.from(bearer)), false);
  assert.equal(readFileSync(dbPath).includes(Buffer.from(rawCookie)), false);
  assert.equal(readFileSync(dbPath).includes(Buffer.from(BOOTSTRAP)), false);
  auth = createAccountAuth({ ...BASE, dbPath, bootstrapToken: BOOTSTRAP }); client.auth = auth;
  const restored = (await client.call('/api/session')).payload;
  assert.equal(restored.user.id, result.payload.user.id); assert.equal(restored.rememberMe, true);
  assert.equal(auth.resolve(native(auth).request('GET', { authorization: `Bearer ${bearer}` })).user.role, 'admin');
  await assert.rejects(browser(auth).register({ username: 'next', name: 'Next', bootstrapToken: BOOTSTRAP }), { code: 'BOOTSTRAP_REJECTED' });
});

test('anonymous, browser and device sessions expire without changing persisted accounts', async t => {
  let time = Date.now();
  const auth = createAccountAuth({ ...BASE, now: () => time }); t.after(() => auth.close());
  const anonymous = browser(auth); await anonymous.call('/api/session');
  time += 10 * 60_000;
  await assert.rejects(anonymous.call('/api/auth/login', { method: 'POST', body: { username: 'member', password: PASSWORD } }), { code: 'CSRF_REJECTED' });
  const owner = browser(auth); await owner.register();
  const ownerReq = owner.request(), client = native(auth), grant = await device(client), deviceReq = client.request('GET', { authorization: `Bearer ${grant.payload.token}` });
  time += 8 * 60 * 60_000;
  assert.equal(auth.resolve(ownerReq), null); assert.ok(auth.resolve(deviceReq));
  time += 30 * 24 * 60 * 60_000;
  assert.equal(auth.resolve(deviceReq), null);
  assert.ok((await device(client)).payload.token);
});

test('account-based rate limit applies across IPs and expires', async t => {
  let time = Date.now();
  const auth = createAccountAuth({ ...BASE, now: () => time }); t.after(() => auth.close());
  for (let i = 0; i < 12; i++) await assert.rejects(device(native(auth, { 'x-real-ip': `198.51.100.${i + 1}` }), { password: 'incorrect password text' }), { code: 'INVALID_CREDENTIALS' });
  await assert.rejects(device(native(auth), { password: 'incorrect password text' }), { code: 'RATE_LIMITED' });
  time += 15 * 60_000;
  await assert.rejects(device(native(auth), { password: 'incorrect password text' }), { code: 'INVALID_CREDENTIALS' });
});

test('hashing admits at most two concurrent requests without an unbounded queue', async t => {
  const auth = createAccountAuth(BASE); t.after(() => auth.close());
  const clients = [browser(auth), browser(auth), browser(auth)];
  for (const client of clients) await client.call('/api/session');
  const result = await Promise.allSettled(clients.map((client, i) => client.call('/api/auth/register', { method: 'POST', body: { username: `user${i}`, name: `U${i}`, password: PASSWORD } })));
  assert.equal(result.filter(item => item.status === 'fulfilled').length, 2);
  assert.equal(result.find(item => item.status === 'rejected').reason.code, 'AUTH_BUSY');
});

test('device grants are capped at eight and logout makes space for a new device', async t => {
  const auth = createAccountAuth(BASE); t.after(() => auth.close());
  await browser(auth).register();
  const client = native(auth), grants = [];
  for (let i = 0; i < 8; i++) grants.push((await device(client, { deviceName: `Device ${i}` })).payload.token);
  await assert.rejects(device(client, { deviceName: 'Overflow' }), { code: 'DEVICE_LIMIT' });
  await client.call('/api/auth/device-logout', { method: 'POST', body: {}, headers: { authorization: `Bearer ${grants[0]}` } });
  assert.ok((await device(client, { deviceName: 'Replacement' })).payload.token);
});

test('anonymous session rate limiting uses actual peer IP unless an explicit local proxy replaces X-Real-IP', async t => {
  const auth = createAccountAuth(BASE); t.after(() => auth.close());
  for (let i = 0; i < 30; i++) await browser(auth, { 'x-real-ip': `198.51.100.${i + 1}` }).call('/api/session');
  await assert.rejects(browser(auth, { 'x-real-ip': '198.51.100.200' }).call('/api/session'), { code: 'RATE_LIMITED' });
  const proxied = createAccountAuth({ ...BASE, trustProxy: true }); t.after(() => proxied.close());
  for (let i = 0; i < 30; i++) await browser(proxied, { 'x-real-ip': '198.51.100.1' }).call('/api/session');
  await assert.rejects(browser(proxied, { 'x-real-ip': '198.51.100.1' }).call('/api/session'), { code: 'RATE_LIMITED' });
  assert.equal((await browser(proxied, { 'x-real-ip': '198.51.100.2' }).call('/api/session')).payload.user, null);
});

test('remember-me issues a 360-day session, survives the default expiry and stays enabled after a password change', async t => {
  let timestamp = Date.now();
  const auth = createAccountAuth({ ...BASE, now: () => timestamp }); t.after(() => auth.close());
  const client = browser(auth);
  const registered = await client.register({ rememberMe: true });
  assert.equal(registered.payload.rememberMe, true);
  assert.match(registered.res.getHeader('Set-Cookie')[0], /Max-Age=31104000;/);
  timestamp += 8 * 60 * 60_000 + 1;
  assert.ok(auth.resolve(client.request()));
  const changed = await client.call('/api/auth/change-password', { method: 'POST', body: { oldPassword: PASSWORD, newPassword: 'a replacement remembered password' } });
  assert.equal(changed.payload.rememberMe, true);
  assert.match(changed.res.getHeader('Set-Cookie')[0], /Max-Age=31104000;/);
  timestamp += 360 * 24 * 60 * 60_000;
  assert.equal(auth.resolve(client.request()), null);
  await client.call('/api/session');
  const login = await client.call('/api/auth/login', { method: 'POST', body: { username: 'member', password: 'a replacement remembered password', rememberMe: true } });
  assert.equal(login.payload.rememberMe, true);
  assert.match(login.res.getHeader('Set-Cookie')[0], /Max-Age=31104000;/);
  await client.call('/api/auth/logout', { method: 'POST', body: {} });
  const short = await client.call('/api/auth/login', { method: 'POST', body: { username: 'member', password: 'a replacement remembered password', rememberMe: false } });
  assert.equal(short.payload.rememberMe, false);
  assert.match(short.res.getHeader('Set-Cookie')[0], /Max-Age=28800;/);
  timestamp += 8 * 60 * 60_000;
  assert.equal(auth.resolve(client.request()), null);
});

test('empty usernames are rejected while remember-me and legacy payload validation stay strict', async t => {
  const auth = createAccountAuth(BASE); t.after(() => auth.close());
  for (const username of ['', '   ', '\t\n', null, 123]) {
    await assert.rejects(browser(auth).register({ username }), { code: 'INVALID_USERNAME' });
  }
  await assert.rejects(browser(auth).register({ rememberMe: 'true' }), { code: 'INVALID_INPUT' });
  await assert.rejects(browser(auth).register({ email: 'legacy@example.test' }), { code: 'INVALID_INPUT' });
  const client = browser(auth); await client.register({ username: 'Team_Member-1' });
  assert.equal(auth.resolve(client.request()).user.username, 'team_member-1');
  await assert.rejects(client.call('/api/auth/login', { method: 'POST', body: { username: 'team_member-1', password: PASSWORD, rememberMe: 1 } }), { code: 'INVALID_INPUT' });
});

test('short Chinese usernames and passwords register, log in and change password without format or length gates', async t => {
  const auth = createAccountAuth(BASE); t.after(() => auth.close());
  const client = browser(auth);
  const registered = await client.register({ username: ' 中 ', password: '密' });
  assert.equal(registered.payload.user.username, '中');
  await client.call('/api/auth/logout', { method: 'POST', body: {} });
  assert.equal((await client.call('/api/auth/login', { method: 'POST', body: { username: '中', password: '密' } })).payload.user.id, registered.payload.user.id);
  await assert.rejects(client.call('/api/auth/change-password', { method: 'POST', body: { oldPassword: '密', newPassword: ' \t ' } }), { code: 'INVALID_PASSWORD' });
  const newPassword = ` ${'中文 ! @ +'.repeat(80)} `;
  await client.call('/api/auth/change-password', { method: 'POST', body: { oldPassword: '密', newPassword } });
  await assert.rejects(device(native(auth), { username: '中', password: '密' }), { code: 'INVALID_CREDENTIALS' });
  assert.ok((await device(native(auth), { username: '中', password: newPassword })).payload.token);
});

test('ordinary punctuation, spaces, Chinese and long usernames retain trimmed case-insensitive uniqueness', async t => {
  const auth = createAccountAuth(BASE); t.after(() => auth.close());
  for (const [index, input] of ['a', ' A.+ @ 中文 ! ', 'Long 用户 @ +'.repeat(80)].entries()) {
    const client = browser(auth), normalized = input.trim().toLowerCase();
    const result = await client.register({ username: input, name: `成员 ${index}`, password: 'p' });
    assert.equal(result.payload.user.username, normalized);
    assert.ok((await device(native(auth), { username: input.toUpperCase(), password: 'p' })).payload.token);
    await assert.rejects(browser(auth).register({ username: ` ${input.toUpperCase()} `, name: `另一成员 ${index}`, password: 'p' }), { code: 'ACCOUNT_EXISTS' });
  }
});

test('existing all-space password hashes still authenticate and can be changed', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'racktop-legacy-space-password-')), dbPath = join(directory, 'accounts.sqlite');
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const auth = createAccountAuth({ ...BASE, dbPath }); t.after(() => auth.close());
  const client = browser(auth); await client.register();
  const legacyPassword = ' '.repeat(12), salt = randomBytes(16).toString('base64url');
  const hash = scryptSync(legacyPassword, salt, 32, { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 });
  const db = new DatabaseSync(dbPath);
  db.prepare('UPDATE account_users SET password_hash = ? WHERE username = ?')
    .run(`scrypt-32768-8-3$${salt}$${hash.toString('base64url')}`, 'member'); db.close();
  await client.call('/api/auth/logout', { method: 'POST', body: {} });
  assert.ok((await client.call('/api/auth/login', { method: 'POST', body: { username: 'member', password: legacyPassword } })).payload.user);
  assert.ok((await device(native(auth), { password: legacyPassword })).payload.token);
  await client.call('/api/auth/change-password', { method: 'POST', body: { oldPassword: legacyPassword, newPassword: '新' } });
  assert.ok((await device(native(auth), { password: '新' })).payload.token);
});

test('500 anonymous sessions cannot consume the capacity reserved for member and device logins', async t => {
  const auth = createAccountAuth({ ...BASE, trustProxy: true }); t.after(() => auth.close());
  const member = browser(auth); await member.register();
  const waiting = browser(auth, { 'x-real-ip': '203.0.113.1' }); await waiting.call('/api/session');
  for (let i = 0; i < 499; i++) {
    await browser(auth, { 'x-real-ip': `198.51.${Math.floor(i / 250)}.${i % 250 + 1}` }).call('/api/session');
  }
  await assert.rejects(browser(auth, { 'x-real-ip': '203.0.113.2' }).call('/api/session'), { code: 'SESSION_LIMIT' });
  assert.ok(auth.resolve(member.request()));
  assert.ok((await device(native(auth))).payload.token);
  const response = await waiting.call('/api/auth/login', { method: 'POST', body: { username: 'member', password: PASSWORD } });
  assert.equal(response.payload.user.username, 'member');
  assert.equal((await browser(auth, { 'x-real-ip': '203.0.113.2' }).call('/api/session')).payload.user, null);
});

test('one member name preserves display case, supports canonical login and recovery without changing legacy identities', async t => {
  const auth = createAccountAuth(BASE); t.after(() => auth.close());
  const client = browser(auth); await client.call('/api/session');
  const created = await client.call('/api/auth/register', { method: 'POST', body: { name: ' Alice 小林 ', password: '密', rememberMe: true } });
  assert.equal(created.payload.user.name, 'Alice 小林'); assert.equal(created.payload.user.username, 'Alice 小林');
  assert.equal(created.payload.user.avatar, 'user'); assert.equal(created.payload.rememberMe, true);
  await client.call('/api/auth/logout', { method: 'POST', body: {} });
  const signed = await client.call('/api/auth/login', { method: 'POST', body: { username: ' ALICE 小林 ', password: '密' } });
  assert.equal(signed.payload.user.id, created.payload.user.id);
  const rival = browser(auth); await rival.call('/api/session');
  await assert.rejects(rival.call('/api/auth/register', { method: 'POST', body: { name: 'alice 小林', password: '密' } }), { code: 'ACCOUNT_EXISTS' });
  await rival.call('/api/auth/recovery-request', { method: 'POST', body: { username: 'ALICE 小林' } });
  assert.equal(auth.getMemberIdentity(created.payload.user.id).version, 2);
  const legacy = await browser(auth).register({ username: 'old-login', name: '原来的姓名' });
  assert.equal(auth.getMemberIdentity(legacy.payload.user.id).username, 'old-login');
  assert.equal(auth.getMemberIdentity(legacy.payload.user.id).name, '原来的姓名');
  assert.equal(auth.getMemberIdentity('not-found'), null); assert.equal(auth.getMemberIdentity(undefined), null);
});

test('a member can change only their own allowlisted avatar with CAS, including before company assignment', async t => {
  const auth = createAccountAuth(BASE); t.after(() => auth.close());
  const client = browser(auth); const { payload } = await client.register();
  const anonymous = browser(auth); await anonymous.call('/api/session');
  await assert.rejects(anonymous.call('/api/auth/profile', { method: 'POST', body: { version: 1, avatar: 'cat' } }), { status: 401 });
  await assert.rejects(client.call('/api/auth/profile', { method: 'POST', body: { version: 1, avatar: 'cat' }, headers: { 'x-csrf-token': undefined } }), { code: 'CSRF_REJECTED' });
  for (const avatar of ['https://example.test/image.png', '<svg>', '', null, 123, ['cat'], { id: 'cat' }]) {
    const body = { version: 1, avatar };
    await assert.rejects(client.call('/api/auth/profile', { method: 'POST', body }), { code: 'INVALID_AVATAR' });
  }
  for (const body of [{ version: 1, avatar: 'cat', company: '西浦' }, { version: 1, avatar: 'cat', id: 'someone-else' }, { version: 1, avatar: 'cat', name: '改名' }]) {
    await assert.rejects(client.call('/api/auth/profile', { method: 'POST', body }), { code: 'INVALID_INPUT' });
  }
  const updated = await client.call('/api/auth/profile', { method: 'POST', body: { version: 1, avatar: 'robot' } });
  assert.equal(updated.payload.user.avatar, 'robot'); assert.equal(updated.payload.user.company, null); assert.equal(updated.payload.user.version, 2);
  assert.equal(updated.payload.user.id, payload.user.id);
  assert.equal(updated.payload.csrfToken, client.csrfToken);
  await assert.rejects(client.call('/api/auth/profile', { method: 'POST', body: { version: 1, avatar: 'cat' } }), { code: 'VERSION_CONFLICT' });
  const grant = (await device(native(auth))).payload;
  const nativeClient = native(auth, { authorization: `Bearer ${grant.token}` });
  const nativeUpdated = await nativeClient.call('/api/auth/profile', { method: 'POST', body: { version: 2, avatar: 'star' } });
  assert.equal(nativeUpdated.payload.user.avatar, 'star'); assert.equal(nativeUpdated.payload.csrfToken, null);
  const safe = auth.getMemberIdentity(payload.user.id);
  assert.deepEqual(Object.keys(safe).sort(), ['id', 'name', 'role', 'username', 'isSuperAdmin', 'company', 'version', 'avatar'].sort());
  assert.equal(auth.resolve(client.request()).user.avatar, 'star');
});

test('all 24 built-in avatars save through the same profile and session contract', async t => {
  const auth = createAccountAuth(BASE); t.after(() => auth.close());
  const client = browser(auth); const { payload } = await client.register();
  assert.equal(ACCOUNT_AVATARS.length, 24); assert.equal(new Set(ACCOUNT_AVATARS).size, 24);
  let version = payload.user.version;
  for (const avatar of ACCOUNT_AVATARS) {
    const saved = await client.call('/api/auth/profile', { method: 'POST', body: { version, avatar } });
    version = saved.payload.user.version;
    assert.equal(saved.payload.user.avatar, avatar);
    assert.equal(auth.resolve(client.request()).user.avatar, avatar);
    assert.equal(auth.getMemberIdentity(payload.user.id).avatar, avatar);
    assert.equal(Object.hasOwn(saved.payload.user, 'avatar_choice'), false);
  }
});

test('legacy seven-avatar database migrates without changing old fields and retains a new choice across restart', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'racktop-avatar-migration-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const config = { ...BASE, dbPath: join(directory, 'team.sqlite') };
  let auth = createAccountAuth(config); t.after(() => auth.close());
  const client = browser(auth); const registered = await client.register();
  await client.call('/api/auth/profile', { method: 'POST', body: { version: 1, avatar: 'cat' } });
  const grant = (await device(native(auth))).payload;
  auth.close();
  const legacyDb = new DatabaseSync(config.dbPath);
  legacyDb.exec('ALTER TABLE account_users DROP COLUMN avatar_choice');
  const oldUser = { ...legacyDb.prepare('SELECT * FROM account_users').get() };
  const oldSessions = legacyDb.prepare('SELECT * FROM account_sessions ORDER BY token_hash').all().map(row => ({ ...row }));
  assert.match(legacyDb.prepare("SELECT sql FROM sqlite_master WHERE name='account_users'").get().sql, /CHECK\(avatar IN/);
  legacyDb.close();
  auth = createAccountAuth(config); client.auth = auth;
  const migratedDb = new DatabaseSync(config.dbPath);
  const { avatar_choice, ...migratedUser } = migratedDb.prepare('SELECT * FROM account_users').get();
  assert.equal(avatar_choice, null); assert.deepEqual(migratedUser, oldUser);
  assert.deepEqual(migratedDb.prepare('SELECT * FROM account_sessions ORDER BY token_hash').all().map(row => ({ ...row })), oldSessions);
  migratedDb.close();
  assert.equal((await client.call('/api/session')).payload.user.avatar, 'cat');
  const saved = await client.call('/api/auth/profile', { method: 'POST', body: { version: 2, avatar: 'satellite' } });
  assert.equal(saved.payload.user.avatar, 'satellite'); assert.equal(saved.payload.user.version, 3);
  const unchanged = await client.call('/api/auth/profile', { method: 'POST', body: { version: 3, avatar: 'satellite' } });
  assert.equal(unchanged.payload.user.version, 3);
  auth.close(); auth = createAccountAuth(config); client.auth = auth;
  assert.equal((await client.call('/api/session')).payload.user.avatar, 'satellite');
  const deviceClient = native(auth, { authorization: `Bearer ${grant.token}` });
  assert.equal((await deviceClient.call('/api/session')).payload.user.avatar, 'satellite');
  assert.equal(auth.getMemberIdentity(registered.payload.user.id).avatar, 'satellite');
  const preservedDb = new DatabaseSync(config.dbPath);
  assert.deepEqual({ ...preservedDb.prepare('SELECT avatar,avatar_choice FROM account_users').get() }, { avatar: 'cat', avatar_choice: 'satellite' });
  preservedDb.close();
  const legacyChoice = await client.call('/api/auth/profile', { method: 'POST', body: { version: 3, avatar: 'dog' } });
  assert.equal(legacyChoice.payload.user.avatar, 'dog');
  const finalDb = new DatabaseSync(config.dbPath);
  assert.deepEqual({ ...finalDb.prepare('SELECT avatar,avatar_choice FROM account_users').get() }, { avatar: 'dog', avatar_choice: 'dog' });
  finalDb.close();
});

test('remembered browser sessions remain valid after thirty days while desktop device grants still expire', async t => {
  let now = Date.now();
  const auth = createAccountAuth({ ...BASE, now: () => now }); t.after(() => auth.close());
  const client = browser(auth); await client.register({ rememberMe: true });
  const grant = (await device(native(auth))).payload;
  assert.equal(new Date(grant.expiresAt).getTime(), now + 30 * 24 * 60 * 60_000);
  now += 31 * 24 * 60 * 60_000;
  assert.ok(auth.resolve(client.request()));
  assert.equal(auth.resolve(native(auth).request('GET', { authorization: `Bearer ${grant.token}` })), null);
  const prior = client.request();
  await client.call('/api/auth/logout', { method: 'POST', body: {} });
  assert.equal(auth.resolve(prior), null);
});
