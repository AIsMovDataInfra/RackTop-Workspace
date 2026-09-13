import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { ApiError } from './store.mjs';
import { ACCOUNT_COMPANIES } from './account-auth.mjs';
import { createServerCredentialCipher, credentialsUnavailable } from './server-credentials.mjs';

const invalid = message => { throw new ApiError(422, 'INVALID_INPUT', message); };
const missing = () => { throw new ApiError(404, 'SERVER_NOT_FOUND', '找不到可访问的服务器'); };
function fields(input, allowed) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !allowed.includes(key))) invalid('服务器字段无效');
}
function text(value, max, label) {
  if (typeof value !== 'string' || !value.trim() || [...value.trim()].length > max || /[\u0000-\u001f\u007f]/.test(value)) invalid(`${label}无效`);
  return value.trim();
}
function destination(input) {
  const host = text(input.host, 253, 'SSH 地址');
  if (host.includes('%')) invalid('SSH 地址不支持带 zone 的 IPv6 地址');
  if (!isIP(host) && !host.split('.').every(part => /^[a-zA-Z0-9_](?:[a-zA-Z0-9_-]{0,61}[a-zA-Z0-9_])?$/.test(part))) invalid('SSH 地址只支持主机名或 IP 地址');
  if (!Number.isSafeInteger(input.port) || input.port < 1 || input.port > 65535) invalid('SSH 端口须为 1–65535');
  const username = text(input.username, 64, 'SSH 用户名');
  if (!/^[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,63}$/.test(username)) invalid('SSH 用户名格式无效');
  return { host, port: input.port, username };
}
function definition(input) {
  const name = text(input.name, 24, '服务器名称');
  const target = destination(input);
  let jump = null;
  if (input.jump !== undefined && input.jump !== null) {
    fields(input.jump, ['host', 'port', 'username']);
    jump = destination(input.jump);
  }
  if (typeof input.enabled !== 'boolean') invalid('服务器启用状态无效');
  return { name, ...target, jump, enabled: input.enabled };
}
function connectionKey({ host, port, username, jump }) {
  const target = value => [value.host.trim().toLowerCase(), value.port, value.username];
  return JSON.stringify([target({ host, port, username }), jump ? target(jump) : null]);
}
function version(input, row) {
  if (!Number.isSafeInteger(input.version) || input.version < 1) invalid('请提交服务器当前版本');
  if (input.version !== row.version) throw new ApiError(409, 'VERSION_CONFLICT', '服务器已被更新，请刷新后重试');
}
function password(value) {
  if (value === undefined || value === null) return value;
  if (typeof value !== 'string' || !value || !value.isWellFormed() || Buffer.byteLength(value, 'utf8') > 4096 || /[\u0000\r\n]/.test(value)) invalid('共享密码须为 1–4096 字节，且不含换行或空字符');
  return value; // Spaces and Unicode are significant; never trim credentials.
}
const identityHash = destination => destination ? createHash('sha256').update(JSON.stringify([
  destination.host, destination.port, destination.username,
])).digest('hex') : null;

// Only opt-in schema 2 exposes password availability. Plaintext is returned
// exclusively by the separately authorized credentials operation.
export function createManagedServerStore({ dbPath, now = Date.now, serverCredentialKey }) {
  const cipher = createServerCredentialCipher(serverCredentialKey);
  const db = new DatabaseSync(dbPath);
  try { db.exec(`PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
    BEGIN IMMEDIATE;
    CREATE TABLE IF NOT EXISTS managed_servers (
      id TEXT PRIMARY KEY, company TEXT NOT NULL, name TEXT NOT NULL,
      host TEXT NOT NULL, port INTEGER NOT NULL, username TEXT NOT NULL, jump_json TEXT,
      enabled INTEGER NOT NULL, version INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS managed_servers_company ON managed_servers(company,name,id);
    CREATE TABLE IF NOT EXISTS managed_server_grants (
      server_id TEXT NOT NULL REFERENCES managed_servers(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES account_users(id), PRIMARY KEY(server_id,user_id)
    );
    CREATE TABLE IF NOT EXISTS managed_server_audit (
      id INTEGER PRIMARY KEY, server_id TEXT NOT NULL, company TEXT NOT NULL,
      actor_id TEXT NOT NULL, action TEXT NOT NULL, version INTEGER NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS managed_server_credentials (
      server_id TEXT NOT NULL REFERENCES managed_servers(id) ON DELETE CASCADE,
      slot TEXT NOT NULL CHECK(slot IN ('target','jump')), format_version INTEGER NOT NULL,
      key_id TEXT NOT NULL, identity_hash TEXT NOT NULL, nonce BLOB NOT NULL,
      ciphertext BLOB NOT NULL, auth_tag BLOB NOT NULL, PRIMARY KEY(server_id,slot)
    );`);
    if (!db.prepare('PRAGMA table_info(managed_servers)').all().some(column => column.name === 'credential_revision')) {
      db.exec('ALTER TABLE managed_servers ADD COLUMN credential_revision INTEGER NOT NULL DEFAULT 0');
    }
    db.exec('COMMIT'); }
  catch (error) { try { db.exec('ROLLBACK'); } catch {} db.close(); throw error; }
  const transaction = (action, write = true) => {
    db.exec(write ? 'BEGIN IMMEDIATE' : 'BEGIN');
    try { const result = action(); db.exec('COMMIT'); return result; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  };
  function actor(user, company, admin = false, superAdmin = false) {
    if (!user?.id) throw new ApiError(401, 'UNAUTHENTICATED', '请先登录');
    const live = db.prepare('SELECT role,is_super_admin,deleted_at FROM account_users WHERE id=?').get(user.id);
    if (!live || live.deleted_at !== null || live.role !== user.role || Boolean(live.is_super_admin) !== Boolean(user.isSuperAdmin)) throw new ApiError(403, 'ACCOUNT_CHANGED', '账号权限已变化，请刷新');
    if (superAdmin && !live.is_super_admin) throw new ApiError(403, 'SUPERADMIN_REQUIRED', '仅超级管理员可批量导入服务器');
    if (live.is_super_admin && company === undefined && !admin) return;
    if (!ACCOUNT_COMPANIES.includes(company)) invalid('请选择服务器所属组织');
    if (!live.is_super_admin && (company !== user.company || !db.prepare('SELECT 1 FROM account_user_companies WHERE user_id=? AND company=?').get(user.id, company))) missing();
    if (admin && live.role !== 'admin') throw new ApiError(403, 'ADMIN_REQUIRED', '仅管理员可维护服务器与授权');
  }
  function rowFor(id, user, admin = false) {
    const row = db.prepare('SELECT * FROM managed_servers WHERE id=?').get(id);
    if (!row) missing();
    actor(user, row.company, admin);
    if (user.role !== 'admin' && (!row.enabled || !db.prepare('SELECT 1 FROM managed_server_grants WHERE server_id=? AND user_id=?').get(id, user.id))) missing();
    return row;
  }
  function grants(id) {
    return db.prepare(`SELECT g.user_id FROM managed_server_grants g
      JOIN managed_servers s ON s.id=g.server_id
      JOIN account_users u ON u.id=g.user_id AND u.deleted_at IS NULL
      JOIN account_user_companies m ON m.user_id=g.user_id AND m.company=s.company
      WHERE g.server_id=? ORDER BY g.user_id`).all(id).map(row => row.user_id);
  }
  function view(row, user, schema = 1) {
    const slots = schema === 2 ? db.prepare('SELECT slot FROM managed_server_credentials WHERE server_id=?').all(row.id).map(item => item.slot) : [];
    return { id: row.id, company: row.company, name: row.name, host: row.host, port: row.port,
      username: row.username, jump: row.jump_json ? JSON.parse(row.jump_json) : null,
      enabled: Boolean(row.enabled), version: row.version, updatedAt: row.updated_at,
      ...(user.role === 'admin' ? { memberIds: grants(row.id) } : {}),
      ...(schema === 2 ? { hasPassword: slots.includes('target'), hasJumpPassword: slots.includes('jump'), credentialRevision: row.credential_revision } : {}) };
  }
  function validateGrants(memberIds, company) {
    if (!Array.isArray(memberIds) || memberIds.length > 128 || new Set(memberIds).size !== memberIds.length || memberIds.some(id => typeof id !== 'string' || !/^[a-f0-9-]{36}$/i.test(id))) invalid('请选择最多 128 名成员，且不得重复');
    for (const id of memberIds) {
      if (!db.prepare(`SELECT 1 FROM account_users u JOIN account_user_companies m ON m.user_id=u.id
        WHERE u.id=? AND m.company=? AND u.deleted_at IS NULL AND u.is_super_admin=0`).get(id, company)) invalid('授权成员必须仍属于服务器所在组织');
    }
    return memberIds;
  }
  function setGrants(id, memberIds) {
    db.prepare('DELETE FROM managed_server_grants WHERE server_id=?').run(id);
    const insert = db.prepare('INSERT INTO managed_server_grants(server_id,user_id) VALUES(?,?)');
    for (const memberId of memberIds) insert.run(id, memberId);
  }
  function audit(id, company, user, action, nextVersion, at) {
    // No addresses, credentials, or member lists in the audit payload.
    db.prepare('INSERT INTO managed_server_audit(server_id,company,actor_id,action,version,created_at) VALUES(?,?,?,?,?,?)').run(id, company, user.id, action, nextVersion, at);
  }
  function updateCredentials(previous, data, input) {
    let changed = false;
    const oldJump = previous.jump_json ? JSON.parse(previous.jump_json) : null;
    const targetPassword = password(input.password), jumpPassword = password(input.jumpPassword);
    if (targetPassword != null || jumpPassword != null) {
      if (!cipher) throw credentialsUnavailable();
      // Check before deleting either slot: an accidental deployment-key change
      // must never overwrite recoverable secrets, including during address edits.
      if (db.prepare('SELECT 1 FROM managed_server_credentials WHERE key_id<>? LIMIT 1').get(cipher.keyId)) throw credentialsUnavailable();
    }
    for (const [slot, supplied, before, after] of [['target', targetPassword, previous, data], ['jump', jumpPassword, oldJump, data.jump]]) {
      if (slot === 'jump' && supplied != null && !after) invalid('设置跳板密码前请先配置跳板服务器');
      const old = db.prepare('SELECT 1 FROM managed_server_credentials WHERE server_id=? AND slot=?').get(previous.id, slot);
      if (supplied === null || identityHash(before) !== identityHash(after)) {
        db.prepare('DELETE FROM managed_server_credentials WHERE server_id=? AND slot=?').run(previous.id, slot);
        if (old) changed = true;
      }
      if (supplied !== undefined && supplied !== null) {
        const encrypted = cipher.encrypt(supplied, { serverId: previous.id, company: previous.company, slot, identityHash: identityHash(after) });
        db.prepare(`INSERT OR REPLACE INTO managed_server_credentials
          (server_id,slot,format_version,key_id,identity_hash,nonce,ciphertext,auth_tag) VALUES(?,?,?,?,?,?,?,?)`)
          .run(previous.id, slot, encrypted.format_version, encrypted.key_id, encrypted.identity_hash, encrypted.nonce, encrypted.ciphertext, encrypted.auth_tag);
        changed = true;
      }
    }
    if (changed) db.prepare('UPDATE managed_servers SET credential_revision=credential_revision+1 WHERE id=?').run(previous.id);
    return changed;
  }
  function insert(data, company, memberIds, user, input = {}, schema = 1) {
    const id = randomUUID(), at = new Date(now()).toISOString();
    db.prepare(`INSERT INTO managed_servers (id,company,name,host,port,username,jump_json,enabled,version,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,1,?,?)`).run(id, company, data.name, data.host, data.port, data.username, data.jump ? JSON.stringify(data.jump) : null, data.enabled ? 1 : 0, at, at);
    const changed = updateCredentials(rowFor(id, user, true), data, input);
    setGrants(id, memberIds); audit(id, company, user, 'created', 1, at);
    if (changed) audit(id, company, user, 'credentials_updated', 1, at);
    return view(rowFor(id, user, true), user, schema);
  }
  return {
    close() { db.close(); },
    authorizeTelemetry(id, user, serverVersion) {
      return transaction(() => {
        const row = rowFor(id, user, true);
        version({ version: serverVersion }, row);
        if (!row.enabled) throw new ApiError(409, 'SERVER_DISABLED', '服务器已停用，不能上报遥测');
        return { id: row.id, company: row.company, name: row.name, version: row.version, enabled: true };
      }, false);
    },
    list(user, company, schema = 1) {
      return transaction(() => {
        actor(user, company ?? (user?.isSuperAdmin ? undefined : user?.company));
        const rows = db.prepare(`SELECT s.* FROM managed_servers s WHERE
          (? IS NULL OR s.company=?) AND (?=1 OR s.company=?) AND
          (?=1 OR (s.enabled=1 AND EXISTS(SELECT 1 FROM managed_server_grants g WHERE g.server_id=s.id AND g.user_id=?)))
          ORDER BY s.company,s.name,s.id`).all(company || null, company || null, user.isSuperAdmin ? 1 : 0, user.company ?? '', user.role === 'admin' ? 1 : 0, user.id);
        const servers = rows.map(row => view(row, user, schema));
        return { schemaVersion: schema, revision: createHash('sha256').update(JSON.stringify(servers)).digest('hex'), servers };
      }, false);
    },
    members(user, company) {
      return transaction(() => {
        actor(user, company ?? user.company, true);
        return db.prepare(`SELECT u.id,u.name,u.username FROM account_users u
          JOIN account_user_companies m ON m.user_id=u.id WHERE m.company=? AND u.deleted_at IS NULL AND u.is_super_admin=0 ORDER BY u.name,u.id`).all(company || user.company);
      }, false);
    },
    get(id, user, schema = 1) { return transaction(() => view(rowFor(id, user), user, schema), false); },
    create(input, user, schema = 1) {
      fields(input, ['company','name','host','port','username','jump','enabled','memberIds','password','jumpPassword']);
      const company = input.company === undefined ? user.company : input.company;
      const data = definition({ enabled: true, ...input });
      return transaction(() => {
        actor(user, company, true);
        if (db.prepare('SELECT COUNT(*) AS n FROM managed_servers WHERE company=?').get(company).n >= 500) throw new ApiError(409, 'SERVER_LIMIT', '每个组织最多维护 500 台服务器');
        const memberIds = validateGrants(input.memberIds === undefined ? [] : input.memberIds, company);
        return insert(data, company, memberIds, user, input, schema);
      });
    },
    importServers(input, user, schema = 1) {
      return transaction(() => {
        // Validate all metadata and grants before creating any rows. The write
        // transaction also serializes retries and the per-company capacity check.
        actor(user, input?.company, true, true);
        fields(input, ['company', 'memberIds', 'servers']);
        if (!Array.isArray(input.servers) || input.servers.length < 1 || input.servers.length > 50) invalid('每次请选择 1–50 台服务器');
        const memberIds = validateGrants(input.memberIds, input.company);
        const definitions = input.servers.map(server => {
          fields(server, ['name', 'host', 'port', 'username', 'jump', 'enabled']);
          return definition({ enabled: true, ...server });
        });
        const existing = db.prepare('SELECT host,port,username,jump_json FROM managed_servers WHERE company=?').all(input.company);
        const seen = new Set(existing.map(row => connectionKey({ ...row, jump: row.jump_json ? JSON.parse(row.jump_json) : null })));
        const fresh = [];
        let skipped = 0;
        for (const server of definitions) {
          const key = connectionKey(server);
          if (seen.has(key)) { skipped++; continue; }
          seen.add(key); fresh.push(server);
        }
        if (existing.length + fresh.length > 500) throw new ApiError(409, 'SERVER_LIMIT', '每个组织最多维护 500 台服务器');
        return { servers: fresh.map(server => insert(server, input.company, memberIds, user, {}, schema)), skipped };
      });
    },
    update(id, input, user, schema = 1) {
      fields(input, ['version','name','host','port','username','jump','enabled','password','jumpPassword']);
      if (Object.keys(input).length < 2) invalid('请至少修改一个服务器字段');
      return transaction(() => {
        const previous = rowFor(id, user, true); version(input, previous);
        const data = definition({ ...view(previous, user), ...input });
        const at = new Date(now()).toISOString();
        const changed = updateCredentials(previous, data, input);
        const previousConnection = { ...previous, jump: previous.jump_json ? JSON.parse(previous.jump_json) : null };
        if (connectionKey(previousConnection) !== connectionKey(data)) {
          // A reused directory id must not grant the new target access to the
          // old target's GPUs. Preserve resources and all historical bookings.
          for (const table of ['managed_resource_bindings', 'resource_usage']) {
            if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) {
              db.prepare(`DELETE FROM ${table} WHERE managed_server_id=?`).run(id);
            }
          }
        }
        db.prepare('UPDATE managed_servers SET name=?,host=?,port=?,username=?,jump_json=?,enabled=?,version=version+1,updated_at=? WHERE id=?')
          .run(data.name, data.host, data.port, data.username, data.jump ? JSON.stringify(data.jump) : null, data.enabled ? 1 : 0, at, id);
        audit(id, previous.company, user, 'updated', previous.version + 1, at);
        if (changed) audit(id, previous.company, user, 'credentials_updated', previous.version + 1, at);
        return view(rowFor(id, user, true), user, schema);
      });
    },
    grant(id, input, user, schema = 1) {
      fields(input, ['version','memberIds']);
      return transaction(() => {
        const previous = rowFor(id, user, true); version(input, previous);
        const memberIds = validateGrants(input.memberIds, previous.company), at = new Date(now()).toISOString();
        setGrants(id, memberIds);
        db.prepare('UPDATE managed_servers SET version=version+1,updated_at=? WHERE id=?').run(at, id);
        audit(id, previous.company, user, 'permissions_updated', previous.version + 1, at);
        return view(rowFor(id, user, true), user, schema);
      });
    },
    credentials(id, input, user) {
      fields(input, ['version', 'credentialRevision']);
      return transaction(() => {
        const row = rowFor(id, user);
        if (!row.enabled) missing();
        version(input, row);
        if (!Number.isSafeInteger(input.credentialRevision) || input.credentialRevision < 0) invalid('请提交共享密码当前版本');
        if (input.credentialRevision !== row.credential_revision) throw new ApiError(409, 'VERSION_CONFLICT', '服务器已被更新，请刷新后重试');
        if (!cipher) throw credentialsUnavailable();
        const result = { serverId: id, company: row.company, version: row.version, credentialRevision: row.credential_revision, password: null, jumpPassword: null };
        for (const encrypted of db.prepare('SELECT * FROM managed_server_credentials WHERE server_id=?').all(id)) {
          const destination = encrypted.slot === 'target' ? row : row.jump_json ? JSON.parse(row.jump_json) : null;
          const value = cipher.decrypt(encrypted, { serverId: id, company: row.company, slot: encrypted.slot, identityHash: identityHash(destination) });
          result[encrypted.slot === 'target' ? 'password' : 'jumpPassword'] = value;
        }
        return result;
      }, false);
    },
  };
}
