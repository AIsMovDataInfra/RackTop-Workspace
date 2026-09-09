import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';
import { isIP } from 'node:net';

const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const SESSION_MS = 8 * 60 * 60_000;
const REMEMBERED_SESSION_MS = 360 * 24 * 60 * 60_000;
const ANONYMOUS_MS = 10 * 60_000;
const DEVICE_MS = 30 * 24 * 60 * 60_000;
export const ACCOUNT_COMPANIES = Object.freeze(['A公司', 'B公司', 'C公司', '西浦']);
const LEGACY_AVATARS = Object.freeze(['user', 'cat', 'dog', 'rocket', 'robot', 'flower', 'star']);
export const ACCOUNT_AVATARS = Object.freeze([...LEGACY_AVATARS, 'engineer', 'explorer', 'rabbit', 'bird', 'fish', 'turtle', 'squirrel', 'bug', 'satellite', 'planet', 'moon', 'sun', 'computer', 'circuit', 'headphones', 'sprout', 'gem']);
// OWASP Password Storage Cheat Sheet: equivalent 32 MiB scrypt configuration.
// https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html#scrypt
const SCRYPT = Object.freeze({ N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 });
const PASSWORD_FORMAT = 'scrypt-32768-8-3';
const LOOPBACKS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
const LOCAL_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const randomToken = () => randomBytes(32).toString('base64url');
const digest = value => createHash('sha256').update(value).digest('base64url');
const csrfFor = token => digest(`racktop-team-csrf:${token}`);
const fail = (status, code, message) => Object.assign(new Error(message), { status, code });
function equal(left, right) {
  return typeof left === 'string' && typeof right === 'string' && TOKEN.test(left) && TOKEN.test(right)
    && timingSafeEqual(Buffer.from(left), Buffer.from(right));
}
function fields(body, allowed) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !allowed.includes(key))) {
    throw fail(422, 'INVALID_INPUT', '请求字段无效。');
  }
}
function username(value) {
  if (typeof value !== 'string') throw fail(422, 'INVALID_USERNAME', '请输入用户名。');
  const normalized = value.trim().toLowerCase();
  if (!normalized) throw fail(422, 'INVALID_USERNAME', '请输入用户名。');
  return normalized;
}
function accountIdentity(body) {
  const displayName = memberName(body.name);
  // New clients use one visible identity; old clients retain their two fields.
  return { username: body.username === undefined ? displayName : username(body.username), name: displayName };
}
function memberName(value) {
  if (typeof value !== 'string' || !value.trim()) throw fail(422, 'INVALID_NAME', '请输入成员名称。');
  // Preserve the same characters used at login; do not normalize the identity.
  return value.trim();
}
function remember(value) {
  if (value === undefined) return false;
  if (typeof value !== 'boolean') throw fail(422, 'INVALID_INPUT', '记住登录选项必须为布尔值。');
  return value;
}
function name(value, label = '名字') {
  if (typeof value !== 'string') throw fail(422, 'INVALID_NAME', `请输入${label}。`);
  const normalized = value.trim().normalize('NFC');
  if (!normalized || [...normalized].length > 60 || /[\p{Cc}\p{Cf}]/u.test(normalized)) throw fail(422, 'INVALID_NAME', `${label}须为 1–60 个可见字符。`);
  return normalized;
}
function password(value, { existing = false } = {}) {
  // Old accounts could use only spaces. Preserve their login and old-password
  // checks while requiring newly chosen passwords to contain a non-space value.
  if (typeof value !== 'string' || !value || (!existing && !value.trim())) {
    throw fail(422, 'INVALID_PASSWORD', '请输入密码。');
  }
  return value;
}
function company(value) {
  if (!ACCOUNT_COMPANIES.includes(value)) throw fail(422, 'INVALID_COMPANY', '请选择 A公司、B公司、C公司或西浦。');
  return value;
}
function version(value) {
  if (!Number.isSafeInteger(value) || value < 1) throw fail(422, 'INVALID_VERSION', '请刷新成员信息后重试。');
  return value;
}
function json(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}

export function createAccountAuth(config) {
  let publicUrl;
  try { publicUrl = new URL(config?.publicUrl); } catch { throw new Error('账号认证需要有效的 PUBLIC_URL'); }
  const production = (config.nodeEnv ?? process.env.NODE_ENV) === 'production';
  if (!['http:', 'https:'].includes(publicUrl.protocol) || publicUrl.username || publicUrl.password || publicUrl.search
    || publicUrl.hash || publicUrl.pathname !== '/' || (publicUrl.protocol !== 'https:' && (production || !LOOPBACKS.has(publicUrl.hostname) || !LOOPBACKS.has(config.host)))) {
    throw new Error('账号认证必须使用 HTTPS；仅非生产本机开发允许 HTTP');
  }
  if (typeof config.dbPath !== 'string' || !config.dbPath) throw new Error('账号认证需要 TEAM_DB_PATH');
  const bootstrap = config.bootstrapToken || '';
  if (bootstrap && (typeof bootstrap !== 'string' || !/^[A-Za-z0-9_-]{32,128}$/.test(bootstrap))) throw new Error('管理员认领码必须为至少 32 位随机 URL-safe 字符');
  const adminUsername = config.adminUsername ? username(config.adminUsername) : '';
  const bootstrapHash = bootstrap ? digest(bootstrap) : null;
  const now = config.now ?? Date.now;
  const secure = publicUrl.protocol === 'https:';
  const cookieName = `${secure ? '__Host-' : ''}racktop_team_account_session`;
  if (config.dbPath !== ':memory:') mkdirSync(dirname(resolvePath(config.dbPath)), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(config.dbPath);
  if (config.dbPath !== ':memory:') chmodSync(config.dbPath, 0o600);
  db.exec(`
    PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON; PRAGMA synchronous = FULL;
    CREATE TABLE IF NOT EXISTS account_users (
      id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, name TEXT NOT NULL, name_key TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('admin','member')), created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS account_sessions (
      token_hash TEXT PRIMARY KEY, user_id TEXT REFERENCES account_users(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK(kind IN ('browser','device')), device_name TEXT,
      remember_me INTEGER NOT NULL DEFAULT 0 CHECK(remember_me IN (0,1)),
      expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS account_sessions_expiry ON account_sessions(expires_at);
    CREATE INDEX IF NOT EXISTS account_sessions_user ON account_sessions(user_id,kind);
    CREATE TABLE IF NOT EXISTS account_auth_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `);
  // Additive, transactional migration preserves every existing identity and grant.
  db.exec('BEGIN IMMEDIATE');
  try {
    const columns = new Set(db.prepare('PRAGMA table_info(account_users)').all().map(column => column.name));
    for (const [column, definition] of Object.entries({
      username_key: 'TEXT',
      is_super_admin: 'INTEGER NOT NULL DEFAULT 0 CHECK(is_super_admin IN (0,1))',
      company: "TEXT CHECK(company IS NULL OR company IN ('A公司','B公司','C公司','西浦'))",
      version: 'INTEGER NOT NULL DEFAULT 1 CHECK(version > 0)',
      recovery_requested_at: 'INTEGER', deleted_at: 'INTEGER',
      avatar: "TEXT NOT NULL DEFAULT 'user' CHECK(avatar IN ('user','cat','dog','rocket','robot','flower','star'))",
      // Preserve the old CHECK and its values so upgrades never rebuild account identities.
      avatar_choice: `TEXT CHECK(avatar_choice IS NULL OR avatar_choice IN (${ACCOUNT_AVATARS.map(value => `'${value}'`).join(',')}))`,
    })) if (!columns.has(column)) db.exec(`ALTER TABLE account_users ADD COLUMN ${column} ${definition}`);
    for (const row of db.prepare('SELECT id,username FROM account_users WHERE username_key IS NULL').all()) {
      db.prepare('UPDATE account_users SET username_key = ? WHERE id = ?').run(username(row.username), row.id);
    }
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS account_unique_username_key ON account_users(username_key);
      CREATE UNIQUE INDEX IF NOT EXISTS account_unique_super_admin ON account_users(is_super_admin) WHERE is_super_admin = 1;
      CREATE TABLE IF NOT EXISTS account_admin_audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT, actor_id TEXT, target_id TEXT NOT NULL,
        action TEXT NOT NULL, old_version INTEGER, new_version INTEGER NOT NULL,
        old_company TEXT, new_company TEXT, created_at INTEGER NOT NULL
      );`);
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); db.close(); throw error; }
  const rates = new Map();
  let hashing = 0, closed = false;
  const dummySalt = randomBytes(16).toString('base64url');

  function purge() {
    db.prepare('DELETE FROM account_sessions WHERE expires_at <= ?').run(now());
    for (const [key, item] of rates) if (item.until <= now()) rates.delete(key);
  }
  function validateRequest(req) {
    if (closed) throw fail(503, 'AUTH_CLOSED', '认证服务暂不可用。');
    if (typeof req.headers?.host !== 'string' || req.headers.host.toLowerCase() !== publicUrl.host.toLowerCase()) throw fail(403, 'HOST_REJECTED', '请求站点与服务配置不一致。');
  }
  function verifyOrigin(req) {
    validateRequest(req);
    if (req.headers?.origin !== publicUrl.origin || req.headers?.['sec-fetch-site'] === 'cross-site') throw fail(403, 'ORIGIN_REJECTED', '写入请求必须来自当前站点。');
  }
  function address(req) {
    const peer = req.socket?.remoteAddress ?? 'unknown';
    // Trust only an explicit loopback reverse proxy, which must replace this header.
    const forwarded = req.headers?.['x-real-ip'];
    if (config.trustProxy === true && LOCAL_ADDRESSES.has(peer) && typeof forwarded === 'string' && isIP(forwarded)) return forwarded;
    return peer;
  }
  function rate(key, limit, duration) {
    purge();
    let item = rates.get(key);
    if (!item) {
      if (rates.size >= 4096) throw fail(429, 'RATE_LIMITED', '请求过于频繁，请稍后重试。');
      item = { count: 0, until: now() + duration };
      rates.set(key, item);
    }
    if (++item.count > limit) throw fail(429, 'RATE_LIMITED', '请求过于频繁，请稍后重试。');
  }
  function credentialRate(req, normalizedUsername) {
    rate(`login-ip:${address(req)}`, 30, 15 * 60_000);
    rate(`login-username:${digest(normalizedUsername)}`, 12, 15 * 60_000);
  }
  async function derive(value, salt) {
    if (closed || hashing >= 2) throw fail(503, 'AUTH_BUSY', '登录请求较多，请稍后重试。');
    hashing++;
    try {
      return await new Promise((resolve, reject) => scrypt(value, salt, 32, SCRYPT, (error, result) => error ? reject(fail(503, 'AUTH_BUSY', '认证服务暂不可用。')) : resolve(result.toString('base64url'))));
    } finally { hashing--; }
  }
  async function hashPassword(value) {
    const salt = randomBytes(16).toString('base64url');
    return `${PASSWORD_FORMAT}$${salt}$${await derive(value, salt)}`;
  }
  async function verifyPassword(value, stored) {
    const parts = typeof stored === 'string' ? stored.split('$') : [];
    const valid = parts.length === 3 && parts[0] === PASSWORD_FORMAT && /^[A-Za-z0-9_-]{22}$/.test(parts[1]) && TOKEN.test(parts[2]);
    const result = await derive(value, valid ? parts[1] : dummySalt);
    return valid && equal(result, parts[2]);
  }
  function browserToken(req) {
    const raw = req.headers?.cookie;
    if (typeof raw !== 'string' || raw.length > 8192) return null;
    const values = raw.split(';').map(part => part.trim()).filter(part => part.startsWith(`${cookieName}=`));
    if (values.length !== 1) return null;
    const token = values[0].slice(cookieName.length + 1);
    return TOKEN.test(token) ? token : null;
  }
  function bearerToken(req) {
    const raw = req.headers?.authorization;
    return typeof raw === 'string' ? /^Bearer ([A-Za-z0-9_-]{43})$/.exec(raw)?.[1] ?? null : null;
  }
  function userView(row) {
    return row?.id && row.deleted_at == null ? { id: row.id, name: row.name, role: row.role, username: row.username,
      isSuperAdmin: Boolean(row.is_super_admin), company: row.is_super_admin ? null : row.company ?? null, version: row.version ?? 1, avatar: row.avatar_choice ?? row.avatar ?? 'user' } : null;
  }
  function recordFor(req, browserOnly = false) {
    purge();
    const hasBearer = !browserOnly && req.headers?.authorization !== undefined;
    const token = hasBearer ? bearerToken(req) : browserToken(req);
    if (!token) return null;
    const row = db.prepare(`SELECT s.token_hash, s.kind, s.expires_at, s.remember_me, a.id, a.name, a.username, a.role, a.is_super_admin, a.company, a.version, a.deleted_at, a.avatar, a.avatar_choice
      FROM account_sessions s LEFT JOIN account_users a ON a.id = s.user_id
      WHERE s.token_hash = ? AND s.kind = ? AND s.expires_at > ?`).get(digest(token), hasBearer ? 'device' : 'browser', now());
    return row ? { user: userView(row), csrfToken: row.kind === 'browser' ? csrfFor(token) : null,
      kind: row.kind, rememberMe: Boolean(row.remember_me), tokenHash: row.token_hash, expiresAt: row.expires_at } : null;
  }
  function payload(record) {
    return { user: record?.user ?? null, csrfToken: record?.csrfToken ?? null, authMode: 'account',
      feishuConfigured: false, accountRegistration: true, rememberMe: record?.rememberMe ?? false,
      notifications: { configured: Boolean(config.notificationsConfigured) }, timezone: 'Asia/Shanghai' };
  }
  function createSession(req, res, account, rememberMe = false) {
    purge();
    const previous = browserToken(req);
    if (previous) db.prepare("DELETE FROM account_sessions WHERE token_hash = ? AND kind = 'browser'").run(digest(previous));
    if (!account && db.prepare('SELECT COUNT(*) AS n FROM account_sessions WHERE user_id IS NULL').get().n >= 500) throw fail(503, 'SESSION_LIMIT', '当前访客较多，请稍后重试。');
    if (db.prepare('SELECT COUNT(*) AS n FROM account_sessions').get().n >= 2500) throw fail(503, 'SESSION_LIMIT', '当前登录请求较多，请稍后重试。');
    // Keep at most eight browser sessions per member, replacing their oldest session.
    if (account) db.prepare(`DELETE FROM account_sessions WHERE token_hash IN (
      SELECT token_hash FROM account_sessions WHERE user_id = ? AND kind = 'browser' ORDER BY created_at DESC LIMIT -1 OFFSET 7
    )`).run(account.id);
    const token = randomToken(), ttl = account ? (rememberMe ? REMEMBERED_SESSION_MS : SESSION_MS) : ANONYMOUS_MS;
    db.prepare("INSERT INTO account_sessions(token_hash,user_id,kind,remember_me,expires_at,created_at) VALUES(?,?,'browser',?,?,?)").run(digest(token), account?.id ?? null, account && rememberMe ? 1 : 0, now() + ttl, now());
    const current = res.getHeader('Set-Cookie');
    res.setHeader('Set-Cookie', [...(Array.isArray(current) ? current : current ? [current] : []),
      `${cookieName}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${ttl / 1000}${secure ? '; Secure' : ''}`]);
    return { user: userView(account), csrfToken: csrfFor(token), kind: 'browser', rememberMe: Boolean(account && rememberMe), expiresAt: now() + ttl };
  }
  function verifyCsrf(req) {
    verifyOrigin(req);
    const record = recordFor(req, true);
    if (!record || !equal(req.headers?.['x-csrf-token'], record.csrfToken)) throw fail(403, 'CSRF_REJECTED', '页面凭据已过期，请刷新页面后重试。');
    return record;
  }
  function resolve(req) {
    validateRequest(req);
    const record = recordFor(req);
    return record?.user ? { user: { ...record.user }, csrfToken: record.csrfToken, kind: record.kind, expiresAt: new Date(record.expiresAt).toISOString() } : null;
  }
  function verifyWrite(req, session) {
    verifyOrigin(req);
    const record = recordFor(req);
    if (record?.kind !== 'device') verifyCsrf(req);
    if (!record?.user || !session?.user || record.user.id !== session.user.id || record.user.role !== session.user.role
      || record.user.isSuperAdmin !== session.user.isSuperAdmin || record.user.company !== session.user.company || record.user.version !== session.user.version
      || record.kind !== session.kind || (record.kind === 'browser' && !equal(record.csrfToken, session.csrfToken))) throw fail(401, 'AUTH_REQUIRED', '请先登录。');
  }
  async function authenticate(req, body) {
    const normalizedUsername = username(body.username);
    const supplied = password(body.password, { existing: true });
    credentialRate(req, normalizedUsername);
    const account = db.prepare('SELECT * FROM account_users WHERE username_key = ? AND deleted_at IS NULL').get(normalizedUsername);
    const matched = await verifyPassword(supplied, account?.password_hash);
    // Another request may change the password while scrypt runs. Never issue a stale grant.
    const fresh = !closed && account ? db.prepare('SELECT * FROM account_users WHERE id = ? AND deleted_at IS NULL').get(account.id) : null;
    if (!matched || !fresh || fresh.password_hash !== account.password_hash) {
      throw fail(401, 'INVALID_CREDENTIALS', '用户名或密码不正确。');
    }
    return fresh;
  }
  function bootstrapAllowed(body, normalizedUsername) {
    const provided = body.bootstrapToken;
    if (provided !== undefined && (typeof provided !== 'string' || provided.length > 128)) throw fail(403, 'BOOTSTRAP_REJECTED', '管理员认领码无效或已使用。');
    if (provided) {
      if (!bootstrapHash || !equal(digest(provided), bootstrapHash) || (adminUsername && normalizedUsername !== adminUsername)
        || db.prepare("SELECT value FROM account_auth_meta WHERE key = 'admin_claimed'").get()) throw fail(403, 'BOOTSTRAP_REJECTED', '管理员认领码无效或已使用。');
      return true;
    }
    // A public registrant must not squat the configured administrator username.
    if (adminUsername && normalizedUsername === adminUsername) throw fail(403, 'BOOTSTRAP_REQUIRED', '此用户名须使用管理员认领码注册。');
    return false;
  }
  function memberView(row) {
    return { ...userView(row), createdAt: new Date(row.created_at).toISOString(),
      recoveryRequestedAt: row.recovery_requested_at == null ? null : new Date(row.recovery_requested_at).toISOString() };
  }
  function requireSuperAdmin(req, write = false) {
    const session = resolve(req);
    if (!session?.user) throw fail(401, 'AUTH_REQUIRED', '请先登录。');
    if (!session.user.isSuperAdmin) throw fail(403, 'SUPERADMIN_REQUIRED', '仅超级管理员可管理成员。');
    if (write) verifyWrite(req, session);
    return session;
  }
  function activeMember(id) {
    const row = db.prepare('SELECT * FROM account_users WHERE id = ? AND deleted_at IS NULL').get(id);
    if (!row) throw fail(404, 'MEMBER_NOT_FOUND', '成员不存在或已删除。');
    return row;
  }
  function editableMember(id, expectedVersion, actorId, allowSuperAdmin = false) {
    const row = activeMember(id);
    if (!allowSuperAdmin && (row.is_super_admin || row.id === actorId)) throw fail(403, 'SUPER_ADMIN_PROTECTED', '此操作不能修改超级管理员或当前账号。');
    if (row.version !== expectedVersion) throw fail(409, 'VERSION_CONFLICT', '成员信息已变化，请刷新后重试。');
    return row;
  }
  function audit(actorId, row, action, nextVersion, nextCompany = row.company ?? null) {
    db.prepare(`INSERT INTO account_admin_audit(actor_id,target_id,action,old_version,new_version,old_company,new_company,created_at)
      VALUES(?,?,?,?,?,?,?,?)`).run(actorId, row.id, action, row.version ?? null, nextVersion, row.company ?? null, nextCompany, now());
  }
  function transaction(fn) {
    db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); db.exec('COMMIT'); return result; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  function insertMember(normalizedUsername, displayName, passwordHash, selectedCompany, actorId, superAdmin = false) {
    const nameKey = displayName.normalize('NFKC').toLowerCase();
    if (db.prepare('SELECT COUNT(*) AS n FROM account_users WHERE deleted_at IS NULL').get().n >= 500) throw fail(403, 'ACCOUNT_LIMIT', '本站成员数量已达上限，请联系管理员。');
    if (db.prepare('SELECT id FROM account_users WHERE username_key = ? OR name_key = ?').get(username(normalizedUsername), nameKey)) throw fail(409, 'ACCOUNT_EXISTS', '用户名或名字已被使用。');
    const id = randomUUID();
    db.prepare(`INSERT INTO account_users(id,username,name,name_key,password_hash,role,created_at,is_super_admin,company,username_key)
      VALUES(?,?,?,?,?,?,?,?,?,?)`).run(id, normalizedUsername, displayName, nameKey, passwordHash, superAdmin ? 'admin' : 'member', now(), superAdmin ? 1 : 0, selectedCompany, username(normalizedUsername));
    const row = activeMember(id);
    audit(actorId, { ...row, version: null, company: null }, superAdmin ? 'super-admin-created' : 'member-created', row.version, selectedCompany);
    return row;
  }
  async function handleMembers(req, res, path, body) {
    const actor = requireSuperAdmin(req, req.method !== 'GET');
    if (path === '/api/admin/members' && req.method === 'GET') {
      json(res, 200, { members: db.prepare('SELECT * FROM account_users WHERE deleted_at IS NULL ORDER BY created_at,id').all().map(memberView) });
      return true;
    }
    if (path === '/api/admin/members' && req.method === 'POST') {
      fields(body, ['username', 'name', 'password', 'company']);
      const { username: normalizedUsername, name: displayName } = accountIdentity(body), supplied = password(body.password), selectedCompany = company(body.company);
      rate(`admin-write:${actor.user.id}`, 60, 15 * 60_000);
      const passwordHash = await hashPassword(supplied);
      const fresh = requireSuperAdmin(req, true);
      if (fresh.user.id !== actor.user.id) throw fail(401, 'AUTH_REQUIRED', '登录状态已变化，请重新登录。');
      const row = transaction(() => insertMember(normalizedUsername, displayName, passwordHash, selectedCompany, fresh.user.id));
      json(res, 201, { member: memberView(row) });
      return true;
    }
    const match = /^\/api\/admin\/members\/([0-9a-f-]{36})(\/reset-password)?$/.exec(path);
    if (!match) throw fail(404, 'NOT_FOUND', '没有此成员管理接口。');
    const [, id, reset] = match;
    if (reset && req.method === 'POST') {
      fields(body, ['version', 'newPassword']);
      const expectedVersion = version(body.version), supplied = password(body.newPassword);
      editableMember(id, expectedVersion, actor.user.id);
      rate(`admin-reset:${actor.user.id}`, 30, 15 * 60_000);
      const passwordHash = await hashPassword(supplied);
      const fresh = requireSuperAdmin(req, true);
      if (fresh.user.id !== actor.user.id) throw fail(401, 'AUTH_REQUIRED', '登录状态已变化，请重新登录。');
      const row = transaction(() => {
        const previous = editableMember(id, expectedVersion, actor.user.id);
        db.prepare('UPDATE account_users SET password_hash = ?, recovery_requested_at = NULL, version = version + 1 WHERE id = ?').run(passwordHash, id);
        db.prepare('DELETE FROM account_sessions WHERE user_id = ?').run(id);
        audit(fresh.user.id, previous, 'password-reset', previous.version + 1);
        return activeMember(id);
      });
      json(res, 200, { member: memberView(row) });
      return true;
    }
    if (!reset && req.method === 'PATCH') {
      fields(body, ['version', 'company']);
      const expectedVersion = version(body.version), selectedCompany = company(body.company);
      const row = transaction(() => {
        const previous = editableMember(id, expectedVersion, actor.user.id, true);
        if (previous.is_super_admin) throw fail(403, 'SUPERADMIN_COMPANY_NOT_REQUIRED', '超级管理员无需分配公司。');
        if (previous.company !== selectedCompany) {
          db.prepare('UPDATE account_users SET company = ?, version = version + 1 WHERE id = ?').run(selectedCompany, id);
          audit(actor.user.id, previous, 'company-changed', previous.version + 1, selectedCompany);
        }
        return activeMember(id);
      });
      json(res, 200, { member: memberView(row) });
      return true;
    }
    if (!reset && req.method === 'DELETE') {
      fields(body, ['version']);
      const expectedVersion = version(body.version);
      transaction(() => {
        const previous = editableMember(id, expectedVersion, actor.user.id);
        db.prepare(`UPDATE account_users SET username = ?, username_key = ?, name = '已删除成员', name_key = ?, password_hash = '!deleted',
          company = NULL, recovery_requested_at = NULL, deleted_at = ?, version = version + 1 WHERE id = ?`)
          .run(`deleted-${randomUUID()}`, `deleted-${randomUUID()}`, `deleted:${randomUUID()}`, now(), id);
        db.prepare('DELETE FROM account_sessions WHERE user_id = ?').run(id);
        audit(actor.user.id, previous, 'member-deleted', previous.version + 1, null);
      });
      json(res, 200, { ok: true });
      return true;
    }
    throw fail(404, 'NOT_FOUND', '没有此成员管理接口。');
  }
  // Explicit deployment operation; never called on server startup or via HTTP.
  async function provisionSuperAdmin(options) {
    fields(options, ['mode', 'username', 'name', 'password']);
    if (!['create', 'reset'].includes(options.mode)) throw fail(422, 'INVALID_INPUT', '必须明确指定 create 或 reset 模式。');
    const normalizedUsername = username(options.username ?? 'admin');
    const displayName = memberName(options.name ?? '超级管理员');
    const supplied = password(options.password);
    function check() {
      const superAdmin = db.prepare('SELECT * FROM account_users WHERE is_super_admin = 1').get();
      const existing = db.prepare('SELECT * FROM account_users WHERE username_key = ?').get(normalizedUsername);
      if (existing && !existing.is_super_admin) throw fail(409, 'ADMIN_NAME_IN_USE', '同名普通账号已存在；拒绝抢占或提升权限。请先核实并处理该账号。');
      if (superAdmin && superAdmin.username !== normalizedUsername) throw fail(409, 'SUPER_ADMIN_EXISTS', '超级管理员已存在。');
      if (options.mode === 'reset' && !superAdmin) throw fail(404, 'SUPER_ADMIN_NOT_FOUND', '超级管理员不存在，请先执行 create。');
      return superAdmin;
    }
    const existing = check();
    if (existing && options.mode === 'create') return { created: false, reset: false, member: memberView(existing) };
    const passwordHash = await hashPassword(supplied);
    if (closed) throw fail(503, 'AUTH_CLOSED', '认证服务暂不可用。');
    return transaction(() => {
      const fresh = check();
      if (fresh && options.mode === 'create') return { created: false, reset: false, member: memberView(fresh) };
      if (options.mode === 'reset') {
        if (fresh.version !== existing.version || fresh.password_hash !== existing.password_hash) throw fail(409, 'VERSION_CONFLICT', '超级管理员账号已变化，请检查后重试。');
        db.prepare('UPDATE account_users SET password_hash = ?, recovery_requested_at = NULL, version = version + 1 WHERE id = ?').run(passwordHash, fresh.id);
        db.prepare('DELETE FROM account_sessions WHERE user_id = ?').run(fresh.id);
        audit(null, fresh, 'super-admin-password-reset', fresh.version + 1);
        return { created: false, reset: true, member: memberView(activeMember(fresh.id)) };
      }
      return { created: true, reset: false, member: memberView(insertMember(normalizedUsername, displayName, passwordHash, null, null, true)) };
    });
  }
  async function handle(req, res, url, body) {
    const path = url.pathname;
    if (path !== '/api/session' && !path.startsWith('/api/auth/') && !path.startsWith('/api/admin/members')) return false;
    validateRequest(req);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    if (path === '/api/session' && req.method === 'GET') {
      const existing = recordFor(req);
      if (req.headers?.authorization !== undefined) {
        if (!existing?.user) throw fail(401, 'AUTH_REQUIRED', '设备登录已过期，请重新登录。');
        json(res, 200, payload(existing));
      } else {
        if (!existing) rate(`session:${address(req)}`, 30, 10 * 60_000);
        json(res, 200, payload(existing ?? createSession(req, res, null)));
      }
      return true;
    }
    if (path.startsWith('/api/admin/members')) {
      if (url.search) throw fail(422, 'INVALID_INPUT', '此接口不接受查询参数。');
      return handleMembers(req, res, path, body);
    }
    if (req.method !== 'POST') throw fail(404, 'NOT_FOUND', '没有此认证接口。');
    if (path === '/api/auth/register') {
      verifyCsrf(req);
      fields(body, ['username', 'name', 'password', 'bootstrapToken', 'rememberMe']);
      const rememberMe = remember(body.rememberMe);
      const { username: normalizedUsername, name: displayName } = accountIdentity(body), supplied = password(body.password);
      const nameKey = displayName.normalize('NFKC').toLowerCase();
      rate(`register:${address(req)}`, 10, 60 * 60_000);
      const admin = bootstrapAllowed(body, username(normalizedUsername));
      const passwordHash = await hashPassword(supplied);
      verifyCsrf(req);
      db.exec('BEGIN IMMEDIATE');
      let account;
      try {
        // Recheck after the asynchronous password hash and within the transaction.
        if (admin) bootstrapAllowed(body, username(normalizedUsername));
        if (db.prepare('SELECT COUNT(*) AS n FROM account_users WHERE deleted_at IS NULL').get().n >= 500) throw fail(403, 'ACCOUNT_LIMIT', '本站成员数量已达上限，请联系管理员。');
        if (db.prepare('SELECT id FROM account_users WHERE username_key = ? OR name_key = ?').get(username(normalizedUsername), nameKey)) throw fail(409, 'ACCOUNT_EXISTS', '用户名或名字已被使用，请登录或使用其他名字。');
        account = { id: randomUUID(), username: normalizedUsername, name: displayName, role: admin ? 'admin' : 'member' };
        db.prepare('INSERT INTO account_users(id,username,name,name_key,password_hash,role,created_at,username_key) VALUES(?,?,?,?,?,?,?,?)').run(account.id, normalizedUsername, displayName, nameKey, passwordHash, account.role, now(), username(normalizedUsername));
        if (admin) db.prepare("INSERT INTO account_auth_meta(key,value) VALUES('admin_claimed',?)").run(account.id);
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
      account = db.prepare('SELECT * FROM account_users WHERE id = ?').get(account.id);
      json(res, 201, payload(createSession(req, res, account, rememberMe)));
      return true;
    }
    if (path === '/api/auth/login') {
      verifyCsrf(req);
      fields(body, ['username', 'password', 'rememberMe']);
      const rememberMe = remember(body.rememberMe);
      const account = await authenticate(req, body);
      verifyCsrf(req);
      json(res, 200, payload(createSession(req, res, account, rememberMe)));
      return true;
    }
    if (path === '/api/auth/logout') {
      verifyCsrf(req);
      fields(body ?? {}, []);
      json(res, 200, payload(createSession(req, res, null)));
      return true;
    }
    if (path === '/api/auth/device-login') {
      verifyOrigin(req);
      // Browser callers carrying our cookie also retain the CSRF boundary.
      if (browserToken(req)) verifyCsrf(req);
      fields(body, ['username', 'password', 'deviceName']);
      const deviceName = name(body.deviceName, '设备名称');
      const account = await authenticate(req, body);
      verifyOrigin(req);
      if (browserToken(req)) verifyCsrf(req);
      purge();
      if (db.prepare("SELECT COUNT(*) AS n FROM account_sessions WHERE user_id = ? AND kind = 'device'").get(account.id).n >= 8) throw fail(409, 'DEVICE_LIMIT', '最多登录 8 台设备，请先退出其他设备，或修改密码撤销所有设备。');
      if (db.prepare('SELECT COUNT(*) AS n FROM account_sessions').get().n >= 2500) throw fail(503, 'SESSION_LIMIT', '当前登录请求较多，请稍后重试。');
      const token = randomToken(), expiresAt = now() + DEVICE_MS;
      db.prepare("INSERT INTO account_sessions(token_hash,user_id,kind,device_name,expires_at,created_at) VALUES(?,?,'device',?,?,?)").run(digest(token), account.id, deviceName, expiresAt, now());
      json(res, 200, { token, expiresAt: new Date(expiresAt).toISOString(), user: userView(account) });
      return true;
    }
    if (path === '/api/auth/device-logout') {
      verifyOrigin(req);
      fields(body ?? {}, []);
      const record = recordFor(req);
      if (record?.kind !== 'device' || !record.user) throw fail(401, 'AUTH_REQUIRED', '设备登录已过期，请重新登录。');
      db.prepare('DELETE FROM account_sessions WHERE token_hash = ?').run(record.tokenHash);
      json(res, 200, { ok: true });
      return true;
    }
    if (path === '/api/auth/profile') {
      const current = resolve(req);
      if (!current?.user) throw fail(401, 'AUTH_REQUIRED', '请先登录。');
      verifyWrite(req, current);
      fields(body, ['version', 'avatar']);
      const expectedVersion = version(body.version);
      if (typeof body.avatar !== 'string' || !ACCOUNT_AVATARS.includes(body.avatar)) throw fail(422, 'INVALID_AVATAR', '请选择列表中的头像。');
      transaction(() => {
        const previous = activeMember(current.user.id);
        if (previous.version !== expectedVersion) throw fail(409, 'VERSION_CONFLICT', '账号信息已变化，请刷新后重试。');
        if ((previous.avatar_choice ?? previous.avatar) !== body.avatar) {
          const legacyAvatar = LEGACY_AVATARS.includes(body.avatar) ? body.avatar : previous.avatar;
          db.prepare('UPDATE account_users SET avatar_choice = ?, avatar = ?, version = version + 1 WHERE id = ?').run(body.avatar, legacyAvatar, previous.id);
          audit(previous.id, previous, 'avatar-changed', previous.version + 1);
        }
      });
      json(res, 200, payload(recordFor(req)));
      return true;
    }
    if (path === '/api/auth/recovery-request') {
      verifyCsrf(req);
      fields(body, ['username']);
      const normalizedUsername = username(body.username);
      rate(`recovery-ip:${address(req)}`, 10, 15 * 60_000);
      rate(`recovery-user:${digest(normalizedUsername)}`, 3, 60 * 60_000);
      db.prepare(`UPDATE account_users SET recovery_requested_at = ?, version = version + 1
        WHERE username_key = ? AND deleted_at IS NULL AND recovery_requested_at IS NULL`).run(now(), normalizedUsername);
      json(res, 200, { ok: true });
      return true;
    }
    if (path === '/api/auth/change-password') {
      const current = verifyCsrf(req);
      if (!current.user) throw fail(401, 'AUTH_REQUIRED', '请先登录。');
      fields(body, ['oldPassword', 'newPassword']);
      const oldPassword = password(body.oldPassword, { existing: true }), newPassword = password(body.newPassword);
      credentialRate(req, current.user.username);
      const account = db.prepare('SELECT * FROM account_users WHERE id = ?').get(current.user.id);
      if (!await verifyPassword(oldPassword, account?.password_hash)) throw fail(401, 'INVALID_CREDENTIALS', '当前密码不正确。');
      const passwordHash = await hashPassword(newPassword);
      const fresh = recordFor(req, true);
      if (!fresh?.user || fresh.user.id !== current.user.id || !equal(fresh.csrfToken, current.csrfToken)) throw fail(401, 'AUTH_REQUIRED', '登录状态已变化，请重新登录。');
      db.exec('BEGIN IMMEDIATE');
      try {
        const changed = db.prepare('UPDATE account_users SET password_hash = ?, recovery_requested_at = NULL, version = version + 1 WHERE id = ? AND password_hash = ? AND deleted_at IS NULL').run(passwordHash, account.id, account.password_hash);
        if (changed.changes !== 1) throw fail(401, 'AUTH_REQUIRED', '密码已变化，请重新登录。');
        db.prepare('DELETE FROM account_sessions WHERE user_id = ?').run(account.id);
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
      json(res, 200, payload(createSession(req, res, db.prepare('SELECT * FROM account_users WHERE id = ?').get(account.id), current.rememberMe)));
      return true;
    }
    throw fail(404, 'NOT_FOUND', '没有此认证接口。');
  }
  return { handle, resolve, verifyWrite, provisionSuperAdmin,
    getMemberIdentity(id) { if (typeof id !== 'string') return null; return userView(db.prepare('SELECT * FROM account_users WHERE id = ? AND deleted_at IS NULL').get(id)); },
    sessionPayload(req) { validateRequest(req); return payload(recordFor(req)); },
    close() { if (!closed) { closed = true; rates.clear(); db.close(); } } };
}
