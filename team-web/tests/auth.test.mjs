import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createAuth } from '../server/auth.mjs';

const DEMO = { mode: 'demo', host: '127.0.0.1', publicUrl: 'http://127.0.0.1:1421', nodeEnv: 'test' };
const FEISHU = { mode: 'feishu', host: '127.0.0.1', publicUrl: 'https://team.example.test',
  feishuAppId: 'cli_example', feishuAppSecret: 'secret-never-in-client',
  feishuTenantKeys: ['tenant_allowed'], feishuAdminOpenIds: ['ou_admin'] };

function browser(auth, base = DEMO.publicUrl) {
  const cookies = new Map();
  let csrfToken;
  return {
    get cookie() { return [...cookies].map(([key, value]) => `${key}=${value}`).join('; '); },
    get csrfToken() { return csrfToken; },
    async call(path, { method = 'GET', body, headers = {}, remoteAddress = '127.0.0.1' } = {}) {
      const req = { method, socket: { remoteAddress }, headers: { host: new URL(base).host,
        cookie: this.cookie, ...(method !== 'GET' ? { origin: new URL(base).origin, 'x-csrf-token': csrfToken } : {}), ...headers } };
      const responseHeaders = new Map();
      const res = { statusCode: 200, getHeader(name) { return responseHeaders.get(name.toLowerCase()); },
        setHeader(name, value) { responseHeaders.set(name.toLowerCase(), value); }, end(value = '') { this.text = value; } };
      try { await auth.handle(req, res, new URL(path, base), body); }
      finally {
        for (const item of res.getHeader('Set-Cookie') ?? []) {
          const [key, value] = item.split(';')[0].split('=');
          if (/Max-Age=0(?:;|$)/.test(item)) cookies.delete(key); else cookies.set(key, value);
        }
      }
      const payload = res.text?.startsWith('{') ? JSON.parse(res.text) : undefined;
      if (payload?.csrfToken) csrfToken = payload.csrfToken;
      return { req, res, payload, headers: responseHeaders };
    },
  };
}

function provider(identity = {}, options = {}) {
  const calls = [];
  return { calls, fetch: async (url, init) => {
    calls.push({ url, ...init });
    return Response.json(url.includes('/oauth/token')
      ? options.token ?? { access_token: 'user-token-never-in-client', token_type: 'Bearer', expires_in: 3600 }
      : options.info ?? { code: 0, data: { open_id: 'ou_member', tenant_key: 'tenant_allowed', name: '真实成员', ...identity } });
  } };
}

async function begin(auth, config = FEISHU, query = '') {
  const client = browser(auth, config.publicUrl);
  const { res } = await client.call(`/api/auth/feishu/start${query}`);
  const target = new URL(res.getHeader('Location'));
  return { client, target, callback: `/api/auth/feishu/callback?state=${target.searchParams.get('state')}&code=single-use-code` };
}

test('demo requires local non-production configuration and rejects nonlocal requests/hosts', async () => {
  for (const override of [{ nodeEnv: 'production' }, { host: '0.0.0.0' }, { publicUrl: 'http://team.example.test' }]) {
    assert.throws(() => createAuth({ ...DEMO, ...override }), /loopback/);
  }
  const auth = createAuth(DEMO), client = browser(auth);
  await assert.rejects(client.call('/api/session', { remoteAddress: '192.168.1.3' }), { code: 'DEMO_LOCAL_ONLY' });
  await assert.rejects(client.call('/api/session', { headers: { host: 'attacker.test' } }), { code: 'HOST_REJECTED' });
  auth.close();
});

test('anonymous CSRF bootstrap, fixed demo identities, login rotation and logout invalidate sessions', async () => {
  const auth = createAuth({ ...DEMO, notificationsConfigured: true }), client = browser(auth);
  const first = await client.call('/api/session');
  assert.equal(first.payload.user, null);
  assert.match(first.payload.csrfToken, /^[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(first.payload.demoUsers.map((user) => user.id), ['demo-admin', 'demo-lin', 'demo-zhou']);
  assert.equal(first.payload.notifications.configured, true);
  const anonymousCookie = client.cookie, anonymousCsrf = client.csrfToken;
  const login = await client.call('/api/auth/demo', { method: 'POST', body: { userId: 'demo-lin' } });
  assert.equal(login.payload.user.role, 'member');
  assert.notEqual(client.cookie, anonymousCookie);
  assert.notEqual(client.csrfToken, anonymousCsrf);
  const oldCookie = client.cookie;
  const current = await client.call('/api/session');
  assert.deepEqual(auth.resolve(current.req).user, login.payload.user);
  const logout = await client.call('/api/auth/logout', { method: 'POST' });
  assert.equal(logout.payload.user, null);
  assert.equal(auth.resolve({ ...current.req, headers: { ...current.req.headers, cookie: oldCookie } }), null);
  assert.equal(auth.resolve({ ...current.req, headers: { ...current.req.headers, cookie: anonymousCookie } }), null);
  auth.close();
});

test('demo login rejects missing/foreign CSRF, foreign Origin, duplicate cookies, and self-reported role', async () => {
  const auth = createAuth(DEMO), client = browser(auth), other = browser(auth);
  await client.call('/api/session'); await other.call('/api/session');
  const post = { method: 'POST', body: { userId: 'demo-admin' } };
  for (const headers of [{ 'x-csrf-token': undefined }, { 'x-csrf-token': other.csrfToken },
    { cookie: `${client.cookie}; ${client.cookie}` }]) {
    await assert.rejects(client.call('/api/auth/demo', { ...post, headers }), { code: 'CSRF_REJECTED' });
  }
  for (const headers of [{ origin: undefined }, { origin: 'https://evil.test' }, { 'sec-fetch-site': 'cross-site' }]) {
    await assert.rejects(client.call('/api/auth/demo', { ...post, headers }), { code: 'ORIGIN_REJECTED' });
  }
  await assert.rejects(client.call('/api/auth/demo', { ...post, body: { userId: 'demo-lin', role: 'admin' } }), { code: 'INVALID_USER' });
  await assert.rejects(client.call('/api/auth/demo', { ...post, body: { userId: 'unknown' } }), { code: 'INVALID_USER' });
  auth.close();
});

test('business writes require actual authenticated session and cannot elevate a resolved copy', async () => {
  const auth = createAuth(DEMO), client = browser(auth);
  const anonymous = await client.call('/api/session');
  const writeReq = (cookie = client.cookie, csrf = client.csrfToken) => ({ ...anonymous.req, method: 'POST',
    headers: { ...anonymous.req.headers, cookie, origin: DEMO.publicUrl, 'x-csrf-token': csrf } });
  assert.throws(() => auth.verifyWrite(writeReq(), { user: { id: 'demo-admin', role: 'admin' }, csrfToken: client.csrfToken }), { code: 'AUTH_REQUIRED' });
  await client.call('/api/auth/demo', { method: 'POST', body: { userId: 'demo-lin' } });
  const req = writeReq(), session = auth.resolve(req);
  assert.doesNotThrow(() => auth.verifyWrite(req, session));
  session.user.role = 'admin';
  assert.throws(() => auth.verifyWrite(req, session), { code: 'AUTH_REQUIRED' });
  assert.equal(auth.resolve(req).user.role, 'member');
  assert.throws(() => auth.verifyWrite({ ...req, headers: { ...req.headers, 'x-csrf-token': 'x'.repeat(43) } }, auth.resolve(req)), { code: 'CSRF_REJECTED' });
  auth.close();
});

test('expired and cleared sessions cannot write or resolve', async () => {
  let timestamp = 1_800_000_000_000;
  const auth = createAuth({ ...DEMO, now: () => timestamp }), client = browser(auth);
  await client.call('/api/session');
  timestamp += 10 * 60_000;
  await assert.rejects(client.call('/api/auth/demo', { method: 'POST', body: { userId: 'demo-admin' } }), { code: 'CSRF_REJECTED' });
  await client.call('/api/session');
  await client.call('/api/auth/demo', { method: 'POST', body: { userId: 'demo-admin' } });
  const { req } = await client.call('/api/session');
  timestamp += 8 * 60 * 60_000;
  assert.equal(auth.resolve(req), null);
  auth.close();
});

test('Feishu missing credentials or tenant allowlist fails closed and never offers demo login', async () => {
  for (const missing of [{ feishuAppSecret: '' }, { feishuTenantKeys: [] }, { feishuAppId: undefined }]) {
    const auth = createAuth({ ...FEISHU, ...missing }), client = browser(auth, FEISHU.publicUrl);
    const { payload } = await client.call('/api/session');
    assert.equal(payload.feishuConfigured, false);
    assert.equal(payload.demoUsers, undefined);
    await assert.rejects(client.call('/api/auth/feishu/start'), { code: 'FEISHU_NOT_CONFIGURED' });
    await assert.rejects(client.call('/api/auth/demo', { method: 'POST', body: { userId: 'demo-admin' } }), { code: 'NOT_FOUND' });
    auth.close();
  }
  assert.throws(() => createAuth({ ...FEISHU, publicUrl: 'http://team.example.test' }), /HTTPS/);
});

test('Feishu OAuth uses PKCE, verified tenant identity, secure opaque cookies and single-use state', async () => {
  const mock = provider(), auth = createAuth({ ...FEISHU, fetch: mock.fetch });
  const { client, target, callback } = await begin(auth);
  assert.equal(target.origin, 'https://accounts.feishu.cn');
  assert.equal(target.pathname, '/open-apis/authen/v1/authorize');
  assert.equal(target.searchParams.get('redirect_uri'), `${FEISHU.publicUrl}/api/auth/feishu/callback`);
  assert.equal(target.searchParams.get('code_challenge_method'), 'S256');
  const result = await client.call(callback);
  assert.equal(result.res.statusCode, 303);
  assert.equal(result.res.getHeader('Location'), '/');
  const sessionCookie = result.res.getHeader('Set-Cookie').find((value) => value.startsWith('__Host-racktop_team_session='));
  for (const flag of ['HttpOnly', 'SameSite=Lax', 'Secure', 'Path=/']) assert.ok(sessionCookie.includes(flag));
  assert.ok(!sessionCookie.includes('Domain='));
  const tokenRequest = JSON.parse(mock.calls[0].body);
  assert.equal(tokenRequest.grant_type, 'authorization_code');
  assert.equal(tokenRequest.client_secret, FEISHU.feishuAppSecret);
  assert.equal(createHash('sha256').update(tokenRequest.code_verifier).digest('base64url'), target.searchParams.get('code_challenge'));
  assert.equal(mock.calls[0].redirect, 'error');
  assert.equal(mock.calls[1].headers.Authorization, 'Bearer user-token-never-in-client');
  const { payload } = await client.call('/api/session');
  assert.deepEqual(payload.user, { id: 'feishu:tenant_allowed:ou_member', name: '真实成员', role: 'member' });
  assert.ok(!JSON.stringify(payload).includes('never-in-client'));
  assert.ok(!client.cookie.includes('ou_member'));
  await assert.rejects(client.call(callback), { code: 'OAUTH_STATE_INVALID' });
  assert.equal(mock.calls.length, 2);
  auth.close();
});

test('Feishu role comes from server allowlist and tenant restrictions precede administrator rights', async () => {
  for (const [identity, expectedRole, rejected] of [
    [{ open_id: 'ou_admin', role: 'member' }, 'admin', false],
    [{ open_id: 'ou_member', role: 'admin' }, 'member', false],
    [{ open_id: 'ou_admin', tenant_key: 'tenant_outsider' }, null, true],
  ]) {
    const mock = provider(identity), auth = createAuth({ ...FEISHU, fetch: mock.fetch });
    const { client, callback } = await begin(auth);
    if (rejected) {
      await assert.rejects(client.call(callback), { code: 'TENANT_REJECTED' });
      assert.equal((await client.call('/api/session')).payload.user, null);
    } else {
      await client.call(callback);
      assert.equal((await client.call('/api/session')).payload.user.role, expectedRole);
    }
    auth.close();
  }
});

test('OAuth preserves only a validated reservation ID through its single-use state', async () => {
  for (const [query, expected] of [['?reservation=res-123_ABC', '/?reservation=res-123_ABC'], ['?reservation=', '/']]) {
    const mock = provider(), auth = createAuth({ ...FEISHU, fetch: mock.fetch });
    const { client, callback, target } = await begin(auth, FEISHU, query);
    // The target stays on the fixed callback; only server-owned state remembers the reservation.
    assert.equal(target.searchParams.get('redirect_uri'), `${FEISHU.publicUrl}/api/auth/feishu/callback`);
    assert.equal(target.searchParams.has('reservation'), false);
    const { res } = await client.call(`${callback}&reservation=attacker-controlled`);
    assert.equal(res.getHeader('Location'), expected);
    await assert.rejects(client.call(callback), { code: 'OAUTH_STATE_INVALID' });
    auth.close();
  }
});

test('OAuth start rejects duplicate, malformed and arbitrary redirect parameters before creating a login', async () => {
  const mock = provider(), auth = createAuth({ ...FEISHU, fetch: mock.fetch });
  const client = browser(auth, FEISHU.publicUrl);
  for (const query of ['?reservation=a&reservation=b', '?reservation=&reservation=',
    '?reservation=https%3A%2F%2Fevil.test', '?reservation=%2F%2Fevil.test', '?reservation=with%20space',
    `?reservation=${'a'.repeat(101)}`, '?returnUrl=https%3A%2F%2Fevil.test', '?reservation=a&returnUrl=%2Fevil']) {
    await assert.rejects(client.call(`/api/auth/feishu/start${query}`), { status: 400, code: 'OAUTH_TARGET_INVALID' });
  }
  assert.equal(client.cookie, '');
  assert.equal(mock.calls.length, 0);
  auth.close();
});

test('OAuth rejects cross-browser binding, duplicate state and expired state before network', async () => {
  for (const mode of ['cross-browser', 'duplicate', 'expired']) {
    let timestamp = 1_800_000_000_000;
    const mock = provider(), auth = createAuth({ ...FEISHU, now: () => timestamp, fetch: mock.fetch });
    const { client, callback, target } = await begin(auth);
    if (mode === 'expired') timestamp += 5 * 60_000;
    const caller = mode === 'cross-browser' ? browser(auth, FEISHU.publicUrl) : client;
    const path = mode === 'duplicate' ? `${callback}&state=${target.searchParams.get('state')}` : callback;
    await assert.rejects(caller.call(path), { code: 'OAUTH_STATE_INVALID' });
    await assert.rejects(client.call(callback), { code: 'OAUTH_STATE_INVALID' });
    assert.equal(mock.calls.length, 0);
    auth.close();
  }
});

test('OAuth cancellation and failed exchanges consume state without leaking provider secrets', async () => {
  const auth = createAuth({ ...FEISHU, fetch: async () => { throw new Error('secret-never-in-client'); } });
  let attempt = await begin(auth);
  await assert.rejects(attempt.client.call(`${attempt.callback}&error=access_denied`), { code: 'OAUTH_CODE_INVALID' });
  await assert.rejects(attempt.client.call(attempt.callback), { code: 'OAUTH_STATE_INVALID' });
  attempt = await begin(auth);
  await assert.rejects(attempt.client.call(attempt.callback), (error) => error.code === 'FEISHU_UNAVAILABLE' && !error.message.includes('secret-never-in-client'));
  await assert.rejects(attempt.client.call(attempt.callback), { code: 'OAUTH_STATE_INVALID' });
  auth.close();
});

test('provider status and identity envelopes must be explicit successes and complete', async () => {
  const cases = [
    [{ token: { code: 1, access_token: 'x', token_type: 'Bearer' } }, 'FEISHU_TOKEN_INVALID'],
    [{ token: { access_token: 'x', token_type: 'other' } }, 'FEISHU_TOKEN_INVALID'],
    [{ info: { code: null, data: { open_id: 'ou_admin', tenant_key: 'tenant_allowed', name: 'Name' } } }, 'FEISHU_IDENTITY_INVALID'],
    [{ info: { code: 0, data: { open_id: 'ou_admin', name: 'Name' } } }, 'FEISHU_IDENTITY_INVALID'],
  ];
  for (const [options, code] of cases) {
    const mock = provider({}, options), auth = createAuth({ ...FEISHU, fetch: mock.fetch });
    const { client, callback } = await begin(auth);
    await assert.rejects(client.call(callback), { code });
    auth.close();
  }
});

test('OAuth provider requests time out and reject oversized responses', async () => {
  for (const fetchImpl of [
    async (_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })),
    async () => new Response('x'.repeat(65 * 1024)),
  ]) {
    const auth = createAuth({ ...FEISHU, timeoutMs: 100, fetch: fetchImpl });
    const { client, callback } = await begin(auth);
    await assert.rejects(client.call(callback), { code: 'FEISHU_UNAVAILABLE' });
    auth.close();
  }
});
