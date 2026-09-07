import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

// Feishu's official OAuth/PKCE example:
// https://github.com/larksuite/lark-openapi-mcp/blob/main/src/auth/provider/oauth.ts
// User info: https://open.feishu.cn/document/server-docs/authentication-management/login-state-management/get
const AUTHORIZE_URL = 'https://accounts.feishu.cn/open-apis/authen/v1/authorize';
const TOKEN_URL = 'https://open.feishu.cn/open-apis/authen/v2/oauth/token';
const USER_INFO_URL = 'https://open.feishu.cn/open-apis/authen/v1/user_info';
const SESSION_MS = 8 * 60 * 60 * 1000;
const ANONYMOUS_MS = 10 * 60 * 1000;
const STATE_MS = 5 * 60 * 1000;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const DEMO_USERS = Object.freeze([
  Object.freeze({ id: 'demo-admin', name: '管理员（演示）', role: 'admin' }),
  Object.freeze({ id: 'demo-lin', name: '小林（演示）', role: 'member' }),
  Object.freeze({ id: 'demo-zhou', name: '小周（演示）', role: 'member' }),
]);

function fail(status, code, message) {
  return Object.assign(new Error(message), { status, code });
}

function loopback(host) {
  return ['localhost', '127.0.0.1', '::1', '[::1]'].includes(String(host).toLowerCase());
}

function localAddress(address) {
  return ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address);
}

function randomToken() { return randomBytes(32).toString('base64url'); }
function hash(value) { return createHash('sha256').update(value).digest('base64url'); }
function successCode(value) { return value === 0 || value === '0'; }
function sameToken(left, right) {
  return typeof left === 'string' && typeof right === 'string'
    && TOKEN_PATTERN.test(left) && TOKEN_PATTERN.test(right)
    && timingSafeEqual(Buffer.from(left), Buffer.from(right));
}

function cookie(req, name) {
  const text = req.headers?.cookie;
  if (typeof text !== 'string' || text.length > 8192) return null;
  const values = text.split(';').map((part) => part.trim()).filter((part) => part.startsWith(`${name}=`));
  if (values.length !== 1) return null;
  const value = values[0].slice(name.length + 1);
  return TOKEN_PATTERN.test(value) ? value : null;
}

function appendCookie(res, value) {
  const current = res.getHeader('Set-Cookie');
  res.setHeader('Set-Cookie', [...(Array.isArray(current) ? current : current ? [current] : []), value]);
}

function json(res, status, payload) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.end(JSON.stringify(payload));
}

async function fetchJson(fetchImpl, url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { ...options, redirect: 'error', signal: controller.signal });
    if (!response.ok || response.redirected) throw new Error('Provider failed');
    const reader = response.body?.getReader();
    if (!reader) throw new Error('Provider returned no body');
    const chunks = [];
    let size = 0;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 64 * 1024) { await reader.cancel(); throw new Error('Provider response too large'); }
      chunks.push(Buffer.from(value));
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    // Never expose provider responses or fetch errors: they can contain tokens.
    throw fail(502, 'FEISHU_UNAVAILABLE', '飞书身份验证暂时失败，请重新登录。');
  } finally { clearTimeout(timer); }
}

export function createAuth(config) {
  if (!config || !['demo', 'feishu'].includes(config.mode)) throw new Error('AUTH_MODE 必须为 demo 或 feishu');
  let publicUrl;
  try { publicUrl = new URL(config.publicUrl); } catch { throw new Error('PUBLIC_URL 必须是有效的站点地址'); }
  if (!['http:', 'https:'].includes(publicUrl.protocol) || publicUrl.username || publicUrl.password
    || publicUrl.search || publicUrl.hash || publicUrl.pathname !== '/') throw new Error('PUBLIC_URL 必须只包含站点协议、主机和端口');
  const production = (config.nodeEnv ?? process.env.NODE_ENV) === 'production';
  if (config.mode === 'demo' && (production || !loopback(config.host) || !loopback(publicUrl.hostname))) {
    throw new Error('演示登录仅允许非 production 的本机 loopback 服务');
  }
  if (config.mode === 'feishu' && publicUrl.protocol !== 'https:' && !loopback(publicUrl.hostname)) {
    throw new Error('正式飞书登录的 PUBLIC_URL 必须使用 HTTPS');
  }
  const now = config.now ?? Date.now;
  const fetchImpl = config.fetch ?? globalThis.fetch;
  const timeoutMs = Math.min(30_000, Math.max(100, config.timeoutMs ?? 8_000));
  const tenants = new Set(Array.isArray(config.feishuTenantKeys) ? config.feishuTenantKeys.filter((value) => typeof value === 'string' && value.trim()) : []);
  const admins = new Set(Array.isArray(config.feishuAdminOpenIds) ? config.feishuAdminOpenIds.filter((value) => typeof value === 'string' && value.trim()) : []);
  const configured = typeof config.feishuAppId === 'string' && Boolean(config.feishuAppId.trim())
    && typeof config.feishuAppSecret === 'string' && Boolean(config.feishuAppSecret.trim()) && tenants.size > 0;
  const secure = publicUrl.protocol === 'https:';
  const sessionName = `${secure ? '__Host-' : ''}racktop_team_session`;
  const stateName = `${secure ? '__Host-' : ''}racktop_team_oauth`;
  const redirectUri = new URL('/api/auth/feishu/callback', publicUrl).href;
  const sessions = new Map();
  const states = new Map();

  function validateRequest(req) {
    if (typeof req.headers?.host !== 'string' || req.headers.host.toLowerCase() !== publicUrl.host.toLowerCase()) {
      throw fail(403, 'HOST_REJECTED', '请求站点与服务配置不一致。');
    }
    if (config.mode === 'demo' && !localAddress(req.socket?.remoteAddress)) {
      throw fail(403, 'DEMO_LOCAL_ONLY', '演示登录只能从本机访问。');
    }
  }

  function verifyOrigin(req) {
    validateRequest(req);
    if (req.headers?.origin !== publicUrl.origin || req.headers?.['sec-fetch-site'] === 'cross-site') {
      throw fail(403, 'ORIGIN_REJECTED', '写入请求必须来自当前站点。');
    }
  }

  function purge() {
    const timestamp = now();
    for (const [key, value] of sessions) if (value.expiresAt <= timestamp) sessions.delete(key);
    for (const [key, value] of states) if (value.expiresAt <= timestamp) states.delete(key);
  }

  function recordFor(req) {
    purge();
    const value = cookie(req, sessionName);
    return value ? sessions.get(hash(value)) ?? null : null;
  }

  function setCookie(res, name, value, age) {
    appendCookie(res, `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${age}${secure ? '; Secure' : ''}`);
  }

  function createSession(req, res, user) {
    purge();
    const previous = cookie(req, sessionName);
    if (previous) sessions.delete(hash(previous));
    if (sessions.size >= 2500) throw fail(503, 'SESSION_LIMIT', '当前登录请求较多，请稍后重试。');
    const id = randomToken();
    const ttl = user ? SESSION_MS : ANONYMOUS_MS;
    const record = { user: user ? Object.freeze({ ...user }) : null, csrfToken: randomToken(), expiresAt: now() + ttl };
    sessions.set(hash(id), record);
    setCookie(res, sessionName, id, ttl / 1000);
    return record;
  }

  function payload(record) {
    return {
      user: record?.user ? { ...record.user } : null,
      csrfToken: record?.csrfToken ?? null,
      authMode: config.mode,
      feishuConfigured: configured,
      ...(config.mode === 'demo' ? { demoUsers: DEMO_USERS.map((user) => ({ ...user })) } : {}),
      notifications: { configured: Boolean(config.notificationsConfigured) },
      timezone: 'Asia/Shanghai',
    };
  }

  function resolve(req) {
    validateRequest(req);
    const record = recordFor(req);
    return record?.user ? { user: { ...record.user }, csrfToken: record.csrfToken } : null;
  }

  function verifyCsrf(req, record) {
    verifyOrigin(req);
    if (!record || !sameToken(req.headers?.['x-csrf-token'], record.csrfToken)) {
      throw fail(403, 'CSRF_REJECTED', '页面凭据已过期，请刷新页面后重试。');
    }
  }

  function verifyWrite(req, session) {
    const record = recordFor(req);
    verifyCsrf(req, record);
    if (!record?.user || !session?.user || record.user.id !== session.user.id
      || record.user.role !== session.user.role || !sameToken(record.csrfToken, session.csrfToken)) {
      throw fail(401, 'AUTH_REQUIRED', '请先登录。');
    }
  }

  async function feishuUser(code, verifier) {
    const token = await fetchJson(fetchImpl, TOKEN_URL, {
      method: 'POST', headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ grant_type: 'authorization_code', client_id: config.feishuAppId,
        client_secret: config.feishuAppSecret, code, redirect_uri: redirectUri, code_verifier: verifier }),
    }, timeoutMs);
    if (!token || (token.code !== undefined && !successCode(token.code)) || token.error
      || typeof token.access_token !== 'string' || !token.access_token || token.access_token.length > 16_384
      || typeof token.token_type !== 'string' || token.token_type.toLowerCase() !== 'bearer') {
      throw fail(502, 'FEISHU_TOKEN_INVALID', '飞书未返回有效的登录凭据，请重新登录。');
    }
    const info = await fetchJson(fetchImpl, USER_INFO_URL, {
      method: 'GET', headers: { Authorization: `Bearer ${token.access_token}` },
    }, timeoutMs);
    const user = info?.data;
    if (!successCode(info?.code) || !user || typeof user.open_id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(user.open_id)
      || typeof user.tenant_key !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(user.tenant_key)
      || typeof user.name !== 'string' || !user.name.trim() || user.name.length > 160 || /[\x00-\x1f\x7f]/.test(user.name)) {
      throw fail(502, 'FEISHU_IDENTITY_INVALID', '飞书未返回完整的用户身份，请检查应用权限。');
    }
    if (!tenants.has(user.tenant_key)) throw fail(403, 'TENANT_REJECTED', '此飞书组织未被允许使用团队预约。');
    return { id: `feishu:${user.tenant_key}:${user.open_id}`, name: user.name.trim(), role: admins.has(user.open_id) ? 'admin' : 'member' };
  }

  async function handle(req, res, url, body) {
    const path = url.pathname;
    if (path !== '/api/session' && !path.startsWith('/api/auth/')) return false;
    validateRequest(req);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    if (path === '/api/session' && req.method === 'GET') {
      json(res, 200, payload(recordFor(req) ?? createSession(req, res, null)));
      return true;
    }
    if (path === '/api/auth/demo' && req.method === 'POST') {
      if (config.mode !== 'demo') throw fail(404, 'NOT_FOUND', '没有此登录方式。');
      verifyCsrf(req, recordFor(req));
      const user = DEMO_USERS.find((candidate) => candidate.id === body?.userId);
      if (!user || !body || Object.keys(body).some((key) => key !== 'userId')) throw fail(422, 'INVALID_USER', '请选择预设的演示成员。');
      json(res, 200, payload(createSession(req, res, user)));
      return true;
    }
    if (path === '/api/auth/logout' && req.method === 'POST') {
      verifyCsrf(req, recordFor(req));
      json(res, 200, payload(createSession(req, res, null)));
      return true;
    }
    if (path === '/api/auth/feishu/start' && req.method === 'GET') {
      if (config.mode !== 'feishu' || !configured) throw fail(503, 'FEISHU_NOT_CONFIGURED', '管理员尚未完成飞书登录配置。');
      const reservationIds = url.searchParams.getAll('reservation');
      if ([...url.searchParams.keys()].some((key) => key !== 'reservation') || reservationIds.length > 1
        || (reservationIds.length === 1 && reservationIds[0] !== '' && !/^[a-zA-Z0-9_-]{1,100}$/.test(reservationIds[0]))) {
        throw fail(400, 'OAUTH_TARGET_INVALID', '预约链接参数无效，请从预约页面重新登录。');
      }
      const reservationId = reservationIds[0] || null;
      purge();
      if (states.size >= 500) throw fail(503, 'LOGIN_LIMIT', '当前登录请求较多，请稍后重试。');
      const state = randomToken(), binding = randomToken(), verifier = randomToken();
      states.set(hash(state), { binding: hash(binding), verifier, reservationId, expiresAt: now() + STATE_MS });
      setCookie(res, stateName, binding, STATE_MS / 1000);
      const target = new URL(AUTHORIZE_URL);
      target.search = new URLSearchParams({ client_id: config.feishuAppId, response_type: 'code', redirect_uri: redirectUri,
        state, code_challenge: hash(verifier), code_challenge_method: 'S256' }).toString();
      res.statusCode = 302;
      res.setHeader('Location', target.href);
      res.end();
      return true;
    }
    if (path === '/api/auth/feishu/callback' && req.method === 'GET') {
      if (config.mode !== 'feishu' || !configured) throw fail(503, 'FEISHU_NOT_CONFIGURED', '管理员尚未完成飞书登录配置。');
      const state = url.searchParams.get('state'), binding = cookie(req, stateName);
      const key = typeof state === 'string' && TOKEN_PATTERN.test(state) ? hash(state) : null;
      const record = key ? states.get(key) : null;
      // Consume before any network request. Even failed exchanges cannot replay.
      if (key) states.delete(key);
      setCookie(res, stateName, '', 0);
      if (url.searchParams.getAll('state').length !== 1 || !record || record.expiresAt <= now()
        || !binding || !sameToken(hash(binding), record.binding)) throw fail(403, 'OAUTH_STATE_INVALID', '飞书登录已过期或无法验证，请重新开始登录。');
      const code = url.searchParams.get('code');
      if (url.searchParams.has('error') || url.searchParams.getAll('code').length !== 1
        || typeof code !== 'string' || !code || code.length > 4096 || /[\x00-\x20\x7f]/.test(code)) {
        throw fail(400, 'OAUTH_CODE_INVALID', '飞书登录已取消或未返回有效授权码。');
      }
      const user = await feishuUser(code, record.verifier);
      createSession(req, res, user);
      res.statusCode = 303;
      res.setHeader('Location', record.reservationId ? `/?reservation=${encodeURIComponent(record.reservationId)}` : '/');
      res.end();
      return true;
    }
    throw fail(404, 'NOT_FOUND', '没有此认证接口。');
  }

  return { resolve, handle, verifyWrite, sessionPayload: (req) => { validateRequest(req); return payload(recordFor(req)); },
    close() { sessions.clear(); states.clear(); } };
}
