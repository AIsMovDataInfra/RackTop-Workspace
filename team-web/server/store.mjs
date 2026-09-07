import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const DAY = 86_400_000;
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

export class ApiError extends Error {
  constructor(status, code, message, conflicts) {
    super(message);
    this.status = status;
    this.code = code;
    if (conflicts) this.conflicts = conflicts;
  }
}

function invalid(message) { throw new ApiError(422, 'INVALID_INPUT', message); }
function missing(kind) { throw new ApiError(404, 'NOT_FOUND', `找不到${kind}`); }
function object(value, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('请求内容必须是 JSON 对象');
  for (const key of Object.keys(value)) if (!allowed.includes(key)) invalid(`不支持的字段：${key}`);
  return value;
}
function text(value, name, max, optional = false) {
  if (optional && value === undefined) return '';
  if (typeof value !== 'string') invalid(`${name}必须是文本`);
  const result = value.trim();
  if ((!optional && !result) || result.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(result)) invalid(`${name}长度或格式无效（最多 ${max} 字符）`);
  return result;
}
function integer(value, name, min, max) {
  if (!Number.isSafeInteger(value) || value < min || value > max) invalid(`${name}必须是 ${min}–${max} 之间的整数`);
  return value;
}
function boolean(value, name) { if (typeof value !== 'boolean') invalid(`${name}必须为布尔值`); return value; }
export function parseDate(value, name = '时间') {
  if (typeof value !== 'string') invalid(`${name}必须是带时区的 ISO 8601 时间`);
  const parts = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|([+-])(\d{2}):(\d{2}))$/.exec(value);
  if (!parts) invalid(`${name}必须是带时区的 ISO 8601 时间`);
  const [, y, mo, d, h, mi, s = '0', , zone, , zh = '0', zm = '0'] = parts;
  const year = Number(y), month = Number(mo), day = Number(d);
  const days = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (year < 1970 || month < 1 || month > 12 || day < 1 || day > days || Number(h) > 23 || Number(mi) > 59 || Number(s) > 59 || Number(zh) > 14 || Number(zm) > 59 || (Number(zh) === 14 && Number(zm) !== 0)) invalid(`${name}不是有效日期`);
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || (!zone && !value.endsWith('Z'))) invalid(`${name}不是有效日期`);
  return timestamp;
}
function identifier(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(value)) invalid('标识符格式无效');
  return value;
}
function userIdentity(user) {
  if (!user || typeof user.id !== 'string' || !user.id || typeof user.name !== 'string' || !['admin', 'member'].includes(user.role)) throw new ApiError(401, 'UNAUTHENTICATED', '请先登录');
  return user;
}
function requireAdmin(user) {
  userIdentity(user);
  if (user.role !== 'admin') throw new ApiError(403, 'FORBIDDEN', '只有管理员可以管理资源');
}
function resourceView(row) {
  return { id: row.id, cluster: row.cluster, name: row.name, gpuModel: row.gpu_model, gpuCount: row.gpu_count, notes: row.notes, enabled: Boolean(row.enabled) };
}
function reservationView(row) {
  return {
    id: row.id, resourceId: row.resource_id, resourceName: row.resource_name, cluster: row.cluster,
    ownerId: row.owner_id, ownerName: row.owner_name, scope: row.scope, gpuIndices: JSON.parse(row.gpu_indices),
    startAt: new Date(row.start_at).toISOString(), endAt: new Date(row.end_at).toISOString(),
    purpose: row.purpose, status: row.status, createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(), version: row.version,
    plannedEndAt: row.planned_end_at == null ? null : new Date(row.planned_end_at).toISOString(),
  };
}

export function createStore({ dbPath, now = Date.now, notificationsConfigured = false }) {
  if (!dbPath || typeof dbPath !== 'string') throw new Error('TEAM_DB_PATH is required');
  if (dbPath !== ':memory:') mkdirSync(dirname(resolve(dbPath)), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON; PRAGMA synchronous = FULL;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS resources (
      id TEXT PRIMARY KEY, cluster TEXT NOT NULL, name TEXT NOT NULL, gpu_model TEXT NOT NULL,
      gpu_count INTEGER NOT NULL CHECK(gpu_count BETWEEN 0 AND 64), notes TEXT NOT NULL DEFAULT '',
      enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)), created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS reservations (
      id TEXT PRIMARY KEY, resource_id TEXT NOT NULL REFERENCES resources(id),
      owner_id TEXT NOT NULL, owner_name TEXT NOT NULL, scope TEXT NOT NULL CHECK(scope IN ('machine','gpus')),
      gpu_indices TEXT NOT NULL, start_at INTEGER NOT NULL, end_at INTEGER NOT NULL CHECK(end_at > start_at),
      purpose TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('confirmed','cancelled','completed')),
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, version INTEGER NOT NULL DEFAULT 1,
      planned_end_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS reservations_overlap ON reservations(resource_id,status,start_at,end_at);
    CREATE INDEX IF NOT EXISTS reservations_owner ON reservations(owner_id,start_at);
    CREATE TABLE IF NOT EXISTS notification_outbox (
      id INTEGER PRIMARY KEY AUTOINCREMENT, reservation_id TEXT NOT NULL REFERENCES reservations(id),
      version INTEGER NOT NULL, event_type TEXT NOT NULL, payload TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
      available_at INTEGER NOT NULL, created_at INTEGER NOT NULL, sent_at INTEGER,
      last_error TEXT, UNIQUE(reservation_id,version,event_type)
    );
    CREATE INDEX IF NOT EXISTS outbox_pending ON notification_outbox(status,available_at);
    CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY,value TEXT NOT NULL);
  `);
  try {
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS resources_unique_name ON resources(cluster COLLATE NOCASE,name COLLATE NOCASE)');
  } catch {
    db.close();
    throw new Error('无法建立资源名称唯一约束；若已有同集群重名资源，请先备份并修复重复记录。未删除或合并任何原数据。');
  }
  const selectReservation = 'SELECT r.*, s.name AS resource_name, s.cluster FROM reservations r JOIN resources s ON s.id=r.resource_id';
  function transaction(fn) {
    let started = false;
    try {
      db.exec('BEGIN IMMEDIATE'); started = true;
      const result = fn(); db.exec('COMMIT'); return result;
    } catch (error) {
      if (started) { try { db.exec('ROLLBACK'); } catch { /* retain original failure */ } }
      if (error?.errcode === 5 || error?.code === 'SQLITE_BUSY') throw new ApiError(503, 'DATABASE_BUSY', '预约服务繁忙，请稍后重试');
      throw error;
    }
  }
  function getResource(id) {
    const row = db.prepare('SELECT * FROM resources WHERE id=?').get(identifier(id));
    if (!row) missing('资源');
    return resourceView(row);
  }
  function getReservation(id) {
    const row = db.prepare(`${selectReservation} WHERE r.id=?`).get(identifier(id));
    if (!row) missing('预约');
    return reservationView(row);
  }
  function checkResourceName(cluster, name, excludedId = '') {
    if (db.prepare('SELECT 1 FROM resources WHERE cluster=? COLLATE NOCASE AND name=? COLLATE NOCASE AND id != ? LIMIT 1').get(cluster, name, excludedId)) {
      throw new ApiError(409, 'RESOURCE_DUPLICATE', '这个集群已有同名资源，请使用现有资源或检查资源名称');
    }
  }
  function checkPermission(reservation, user, version) {
    userIdentity(user);
    if (user.role !== 'admin' && reservation.ownerId !== user.id) throw new ApiError(403, 'FORBIDDEN', '只能修改自己的预约');
    integer(version, '预约版本', 1, Number.MAX_SAFE_INTEGER);
    if (reservation.version !== version) throw new ApiError(409, 'VERSION_CONFLICT', '预约已被其他操作更新，请刷新后重试');
    if (reservation.status !== 'confirmed') throw new ApiError(409, 'RESERVATION_CLOSED', '此预约已取消或结束');
  }
  function bookingFields(input, resource, timestamp, original) {
    const scope = input.scope;
    if (!['machine', 'gpus'].includes(scope)) invalid('请选择整机或指定 GPU');
    if (!Array.isArray(input.gpuIndices) || input.gpuIndices.length > 64) invalid('GPU 编号必须是数组');
    const gpuIndices = input.gpuIndices.map(value => integer(value, 'GPU 编号', 0, Math.max(0, resource.gpuCount - 1))).sort((a, b) => a - b);
    if (new Set(gpuIndices).size !== gpuIndices.length) invalid('GPU 编号不能重复');
    if (scope === 'machine' && gpuIndices.length) invalid('整机预约不应指定 GPU 编号');
    if (scope === 'gpus' && (!resource.gpuCount || !gpuIndices.length)) invalid('此资源需要选择至少一张有效 GPU；CPU 资源只能预约整机');
    const start = parseDate(input.startAt, '开始时间'), end = parseDate(input.endAt, '结束时间');
    const oldStart = original ? Date.parse(original.startAt) : null;
    if (original && oldStart <= timestamp && start !== oldStart) invalid('已经开始的预约不能修改开始时间');
    if ((!original || oldStart > timestamp) && start < timestamp - 60_000) invalid('开始时间不能早于当前时间');
    if (end <= start || end <= timestamp) invalid('结束时间必须晚于开始时间及当前时间');
    if (end - start > 7 * DAY) invalid('单次预约最长 7 天');
    if (start > timestamp + 90 * DAY || end > timestamp + 90 * DAY) invalid('只能预约未来 90 天内的时间');
    return { scope, gpuIndices, start, end, purpose: text(input.purpose, '用途', 500) };
  }
  function checkConflicts(resourceId, booking, excludedId = '') {
    const existing = db.prepare(`${selectReservation} WHERE r.resource_id=? AND r.status='confirmed' AND r.start_at < ? AND r.end_at > ? AND r.id != ? ORDER BY r.start_at`).all(resourceId, booking.end, booking.start, excludedId);
    const conflicts = existing.filter(row => booking.scope === 'machine' || row.scope === 'machine' || JSON.parse(row.gpu_indices).some(gpu => booking.gpuIndices.includes(gpu))).map(reservationView);
    if (conflicts.length) throw new ApiError(409, 'RESERVATION_CONFLICT', '所选资源在这个时间段已有预约，请调整时间或 GPU', conflicts.slice(0, 50));
  }
  function enqueue(type, reservation, timestamp) {
    const event = { type, reservation, resource: getResource(reservation.resourceId) };
    db.prepare('INSERT OR IGNORE INTO notification_outbox(reservation_id,version,event_type,payload,status,available_at,created_at) VALUES (?,?,?,?,?,?,?)')
      .run(reservation.id, reservation.version, type, JSON.stringify(event), notificationsConfigured ? 'pending' : 'disabled', timestamp, timestamp);
  }
  function createResource(input, user) {
    requireAdmin(user);
    object(input, ['cluster', 'name', 'gpuModel', 'gpuCount', 'notes']);
    const id = randomUUID(), timestamp = now();
    const cluster = text(input.cluster, '集群名称', 100), name = text(input.name, '资源名称', 100);
    const gpuCount = integer(input.gpuCount, 'GPU 数量', 0, 64);
    const gpuModel = text(input.gpuModel ?? '', 'GPU 型号', 100, gpuCount === 0), notes = text(input.notes, '备注', 1000, true);
    return transaction(() => {
      checkResourceName(cluster, name);
      db.prepare('INSERT INTO resources(id,cluster,name,gpu_model,gpu_count,notes,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)').run(id, cluster, name, gpuModel, gpuCount, notes, timestamp, timestamp);
      return getResource(id);
    });
  }
  function updateResource(id, input, user) {
    requireAdmin(user);
    object(input, ['cluster', 'name', 'gpuModel', 'gpuCount', 'notes', 'enabled']);
    if (!Object.keys(input).length) invalid('请提供要修改的资源字段');
    return transaction(() => {
      const original = getResource(id), merged = { ...original, ...input }, timestamp = now();
      const gpuCount = integer(merged.gpuCount, 'GPU 数量', 0, 64);
      const cluster = text(merged.cluster, '集群名称', 100), name = text(merged.name, '资源名称', 100);
      checkResourceName(cluster, name, id);
      if (gpuCount !== original.gpuCount && db.prepare("SELECT 1 FROM reservations WHERE resource_id=? AND status='confirmed' AND end_at > ? LIMIT 1").get(id, timestamp)) throw new ApiError(409, 'RESOURCE_HAS_RESERVATIONS', '资源存在尚未结束的预约，不能修改 GPU 数量');
      db.prepare('UPDATE resources SET cluster=?,name=?,gpu_model=?,gpu_count=?,notes=?,enabled=?,updated_at=? WHERE id=?').run(
        cluster, name, text(merged.gpuModel, 'GPU 型号', 100, gpuCount === 0), gpuCount,
        text(merged.notes, '备注', 1000, true), boolean(merged.enabled, '启用状态') ? 1 : 0, timestamp, id);
      return getResource(id);
    });
  }
  function createReservation(input, user) {
    userIdentity(user);
    object(input, ['resourceId', 'scope', 'gpuIndices', 'startAt', 'endAt', 'purpose']);
    return transaction(() => {
      const resource = getResource(input.resourceId), timestamp = now();
      if (!resource.enabled) invalid('此资源已停用，不能新建预约');
      const booking = bookingFields(input, resource, timestamp);
      checkConflicts(resource.id, booking);
      const id = randomUUID();
      db.prepare("INSERT INTO reservations(id,resource_id,owner_id,owner_name,scope,gpu_indices,start_at,end_at,purpose,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,'confirmed',?,?)")
        .run(id, resource.id, user.id, user.name, booking.scope, JSON.stringify(booking.gpuIndices), booking.start, booking.end, booking.purpose, timestamp, timestamp);
      const reservation = getReservation(id); enqueue('created', reservation, timestamp); return reservation;
    });
  }
  function updateReservation(id, input, user) {
    object(input, ['version', 'startAt', 'endAt', 'purpose', 'scope', 'gpuIndices']);
    if (Object.keys(input).length < 2) invalid('请提供要修改的预约字段');
    return transaction(() => {
      const original = getReservation(id); checkPermission(original, user, input.version);
      const resource = getResource(original.resourceId), timestamp = now();
      if (Date.parse(original.endAt) <= timestamp) throw new ApiError(409, 'RESERVATION_ELAPSED', '此预约时间已结束，不能再修改');
      if (!resource.enabled) invalid('此资源已停用，不能修改预约；仍可取消或提前结束');
      const merged = { ...original, ...input };
      if (input.scope === 'machine' && !own(input, 'gpuIndices')) merged.gpuIndices = [];
      const booking = bookingFields(merged, resource, timestamp, original);
      checkConflicts(resource.id, booking, id);
      db.prepare('UPDATE reservations SET scope=?,gpu_indices=?,start_at=?,end_at=?,purpose=?,updated_at=?,version=version+1 WHERE id=? AND version=?')
        .run(booking.scope, JSON.stringify(booking.gpuIndices), booking.start, booking.end, booking.purpose, timestamp, id, input.version);
      const reservation = getReservation(id); enqueue('updated', reservation, timestamp); return reservation;
    });
  }
  function transition(id, input, user, finish) {
    object(input, ['version']);
    return transaction(() => {
      const original = getReservation(id); checkPermission(original, user, input.version);
      const timestamp = now(), start = Date.parse(original.startAt), end = Date.parse(original.endAt);
      if (end <= timestamp) throw new ApiError(409, 'RESERVATION_ELAPSED', '此预约时间已结束，无需再次操作');
      if (finish && (start >= timestamp || timestamp >= end)) throw new ApiError(409, 'NOT_ONGOING', '只有正在进行的预约可以提前结束');
      if (finish) {
        db.prepare("UPDATE reservations SET status='completed',planned_end_at=end_at,end_at=?,updated_at=?,version=version+1 WHERE id=? AND version=?").run(timestamp, timestamp, id, input.version);
      } else {
        db.prepare("UPDATE reservations SET status='cancelled',updated_at=?,version=version+1 WHERE id=? AND version=?").run(timestamp, id, input.version);
      }
      const reservation = getReservation(id); enqueue(finish ? 'finished' : 'cancelled', reservation, timestamp); return reservation;
    });
  }
  function listReservations(query = {}, user) {
    userIdentity(user);
    const timestamp = now(), from = query.from === undefined ? timestamp - 7 * DAY : parseDate(query.from, '查询开始时间');
    const to = query.to === undefined ? timestamp + 30 * DAY : parseDate(query.to, '查询结束时间');
    if (to <= from || to - from > 366 * DAY) invalid('查询范围必须为 1 年内的有效时间段');
    if (query.mine !== undefined && !['true', 'false', true, false].includes(query.mine)) invalid('mine 参数无效');
    const mine = query.mine === true || query.mine === 'true';
    return db.prepare(`${selectReservation} WHERE r.start_at < ? AND r.end_at > ? ${mine ? 'AND r.owner_id=?' : ''} ORDER BY r.start_at,r.created_at LIMIT 1000`).all(...(mine ? [to, from, user.id] : [to, from])).map(reservationView);
  }
  function enqueueEnding() {
    return transaction(() => {
      const timestamp = now();
      const rows = db.prepare(`${selectReservation} WHERE r.status='confirmed' AND r.start_at <= ? AND r.end_at > ? AND r.end_at <= ?`).all(timestamp, timestamp, timestamp + 30 * 60_000);
      for (const row of rows) enqueue('ending', reservationView(row), timestamp);
      return rows.length;
    });
  }
  function claimOutbox(limit = 20) {
    integer(limit, '通知批次数量', 1, 100);
    return transaction(() => {
      const timestamp = now();
      const rows = db.prepare("SELECT * FROM notification_outbox WHERE (status='pending' OR status='sending') AND available_at <= ? ORDER BY id LIMIT ?").all(timestamp, limit);
      const claimed = [];
      for (const row of rows) {
        if (row.event_type === 'ending') {
          const current = getReservation(row.reservation_id);
          if (current.version !== row.version || current.status !== 'confirmed' || Date.parse(current.endAt) <= timestamp) {
            db.prepare("UPDATE notification_outbox SET status='superseded' WHERE id=?").run(row.id);
            continue;
          }
        }
        db.prepare("UPDATE notification_outbox SET status='sending',available_at=? WHERE id=?").run(timestamp + 120_000, row.id);
        claimed.push({ id: row.id, attempts: row.attempts, event: JSON.parse(row.payload) });
      }
      return claimed;
    });
  }
  function completeOutbox(id) {
    db.prepare("UPDATE notification_outbox SET status='sent',sent_at=?,last_error=NULL WHERE id=? AND status='sending'").run(now(), id);
  }
  function retryOutbox(id, reason = '通知发送失败', skipped = false) {
    const row = db.prepare('SELECT attempts FROM notification_outbox WHERE id=?').get(id);
    if (!row) return;
    const attempts = row.attempts + (skipped ? 0 : 1);
    const delay = skipped ? 60_000 : Math.min(3_600_000, 5000 * (2 ** Math.min(attempts, 10)));
    db.prepare("UPDATE notification_outbox SET status='pending',attempts=?,available_at=?,last_error=? WHERE id=? AND status='sending'")
      .run(attempts, now() + delay, String(reason).slice(0, 200), id);
  }
  function seedDemo() {
    transaction(() => {
      if (db.prepare("SELECT 1 FROM metadata WHERE key='demo_seeded'").get()) return;
      if (db.prepare('SELECT 1 FROM resources LIMIT 1').get()) {
        db.prepare("INSERT INTO metadata(key,value) VALUES('demo_seeded','existing-data-preserved')").run(); return;
      }
      const timestamp = now();
      const resources = [
        ['demo-atlas', '训练集群（演示）', 'Atlas · 8 卡节点（演示）', 'NVIDIA A100', 8],
        ['demo-orion', '训练集群（演示）', 'Orion · 4 卡节点（演示）', 'NVIDIA RTX 4090', 4],
        ['demo-cpu', '开发集群（演示）', 'CPU 开发节点（演示）', '', 0],
      ];
      for (const [id, cluster, name, gpuModel, gpuCount] of resources) db.prepare('INSERT INTO resources(id,cluster,name,gpu_model,gpu_count,notes,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)').run(id, cluster, name, gpuModel, gpuCount, '仅供本机演示；不是实际服务器', timestamp, timestamp);
      const samples = [
        ['demo-atlas', 'demo-lin', '小林（演示）', 'gpus', '[0,1]', timestamp - 30 * 60_000, timestamp + 90 * 60_000, '演示 · 模型训练'],
        ['demo-orion', 'demo-zhou', '小周（演示）', 'machine', '[]', timestamp + 2 * 3_600_000, timestamp + 4 * 3_600_000, '演示 · 推理评测'],
      ];
      for (const [resourceId, ownerId, ownerName, scope, gpuIndices, start, end, purpose] of samples) db.prepare("INSERT INTO reservations(id,resource_id,owner_id,owner_name,scope,gpu_indices,start_at,end_at,purpose,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,'confirmed',?,?)").run(randomUUID(), resourceId, ownerId, ownerName, scope, gpuIndices, start, end, purpose, timestamp, timestamp);
      db.prepare("INSERT INTO metadata(key,value) VALUES('demo_seeded','1')").run();
    });
  }
  return {
    getResource, getReservation, createResource, updateResource,
    listResources: () => db.prepare('SELECT * FROM resources ORDER BY cluster,name,id').all().map(resourceView),
    createReservation, updateReservation, listReservations,
    cancelReservation: (id, input, user) => transition(id, input, user, false),
    finishReservation: (id, input, user) => transition(id, input, user, true),
    enqueueEnding, claimOutbox, completeOutbox, retryOutbox, seedDemo,
    close: () => db.close(),
  };
}
