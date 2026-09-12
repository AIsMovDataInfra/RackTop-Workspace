import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const DAY = 86_400_000;
const companies = new Set(['A公司', 'B公司', 'C公司', '西浦']);
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
function reservationView(row) {
  return {
    id: row.id, company: row.company, resourceId: row.resource_id, resourceName: row.resource_name, cluster: row.cluster,
    ownerId: row.owner_id, ownerName: row.owner_name, scope: row.scope, gpuIndices: JSON.parse(row.gpu_indices),
    startAt: new Date(row.start_at).toISOString(), endAt: new Date(row.end_at).toISOString(),
    purpose: row.purpose, status: row.status, createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(), version: row.version,
    plannedEndAt: row.planned_end_at == null ? null : new Date(row.planned_end_at).toISOString(),
    gpuIds: JSON.parse(row.gpu_ids ?? '[]'), inventoryVersion: row.inventory_version ?? 0,
  };
}

export function createStore({ dbPath, now = Date.now, notificationsConfigured = false, enforceCompanies = false }) {
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
  // Separate inventory tables keep existing manually entered resource records intact.
  db.exec(`
    CREATE TABLE IF NOT EXISTS resource_inventory (
      resource_id TEXT PRIMARY KEY REFERENCES resources(id), authority_source TEXT NOT NULL, authority_server TEXT NOT NULL,
      gpus TEXT NOT NULL, pending_gpus TEXT, revision INTEGER NOT NULL DEFAULT 1,
      state TEXT NOT NULL DEFAULT 'synced', last_seen_at INTEGER NOT NULL, observed_at INTEGER NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('online','offline','unknown'))
    );
    CREATE TABLE IF NOT EXISTS resource_bindings (
      source_id TEXT NOT NULL, server_id TEXT NOT NULL, resource_id TEXT NOT NULL REFERENCES resources(id),
      created_at INTEGER NOT NULL, PRIMARY KEY(source_id,server_id)
    );
    CREATE TABLE IF NOT EXISTS gpu_identity (
      uuid TEXT PRIMARY KEY, id TEXT UNIQUE NOT NULL, resource_id TEXT NOT NULL REFERENCES resources(id)
    );
    CREATE TABLE IF NOT EXISTS reservation_requests (
      owner_id TEXT NOT NULL, request_id TEXT NOT NULL, payload_hash TEXT NOT NULL,
      reservation_id TEXT NOT NULL REFERENCES reservations(id), PRIMARY KEY(owner_id,request_id)
    );
    CREATE TABLE IF NOT EXISTS managed_resource_bindings (
      managed_server_id TEXT PRIMARY KEY, resource_id TEXT NOT NULL REFERENCES resources(id), created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS resource_usage (
      resource_id TEXT NOT NULL REFERENCES resources(id), managed_server_id TEXT NOT NULL,
      server_version INTEGER NOT NULL, observed_at INTEGER NOT NULL, received_at INTEGER NOT NULL,
      status TEXT NOT NULL, inventory_complete INTEGER NOT NULL, process_query_ok INTEGER NOT NULL,
      gpu_usage_valid INTEGER NOT NULL, gpus TEXT NOT NULL,
      PRIMARY KEY(resource_id,managed_server_id)
    );
  `);
  const reservationColumns = new Set(db.prepare('PRAGMA table_info(reservations)').all().map(column => column.name));
  if (!reservationColumns.has('gpu_ids')) db.exec("ALTER TABLE reservations ADD COLUMN gpu_ids TEXT NOT NULL DEFAULT '[]'");
  if (!reservationColumns.has('inventory_version')) db.exec('ALTER TABLE reservations ADD COLUMN inventory_version INTEGER NOT NULL DEFAULT 0');
  const resourceColumns = new Set(db.prepare('PRAGMA table_info(resources)').all().map(column => column.name));
  if (!resourceColumns.has('company')) db.exec("ALTER TABLE resources ADD COLUMN company TEXT NOT NULL DEFAULT ''");
  if (!resourceColumns.has('company_version')) db.exec('ALTER TABLE resources ADD COLUMN company_version INTEGER NOT NULL DEFAULT 1');
  if (!reservationColumns.has('company')) db.exec("ALTER TABLE reservations ADD COLUMN company TEXT NOT NULL DEFAULT ''");
  if (!reservationColumns.has('resource_name_snapshot')) {
    db.exec("ALTER TABLE reservations ADD COLUMN resource_name_snapshot TEXT NOT NULL DEFAULT ''");
    db.exec("ALTER TABLE reservations ADD COLUMN cluster_snapshot TEXT NOT NULL DEFAULT ''");
    db.exec('UPDATE reservations SET resource_name_snapshot=(SELECT name FROM resources WHERE id=resource_id),cluster_snapshot=(SELECT cluster FROM resources WHERE id=resource_id)');
  }
  try {
    db.exec('DROP INDEX IF EXISTS resources_unique_name');
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS resources_company_name ON resources(company,cluster COLLATE NOCASE,name COLLATE NOCASE)');
  } catch {
    db.close();
    throw new Error('无法建立资源名称唯一约束；若已有同集群重名资源，请先备份并修复重复记录。未删除或合并任何原数据。');
  }
  const selectReservation = 'SELECT r.*, r.resource_name_snapshot AS resource_name, r.cluster_snapshot AS cluster FROM reservations r JOIN resources s ON s.id=r.resource_id';
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
  function companyScope(user) {
    if (!enforceCompanies) return null;
    userIdentity(user);
    if (user.isSuperAdmin === true) return null;
    if (!companies.has(user.company)) throw new ApiError(403, 'COMPANY_REQUIRED', '请联系超级管理员分配公司');
    return user.company;
  }
  function checkCompany(value, user, kind = '资源') {
    const company = companyScope(user);
    if (company !== null && value.company !== company) missing(kind);
    return value;
  }
  function resourceCompany(input, user, previous) {
    companyScope(user);
    const desired = own(input, 'company') ? input.company : previous?.company ?? user.company ?? '';
    if (desired !== '' && !companies.has(desired)) invalid('请选择有效公司');
    if (typeof desired !== 'string') invalid('请选择有效公司');
    if (enforceCompanies && !user.isSuperAdmin && desired !== user.company) throw new ApiError(403, 'FORBIDDEN', '只有超级管理员可以跨公司分配资源');
    if (previous?.company && desired === '') invalid('已分配的资源不能清空公司');
    return desired;
  }
  function resourceView(row) {
    const inventory = db.prepare('SELECT * FROM resource_inventory WHERE resource_id=?').get(row.id);
    const gpus = inventory ? JSON.parse(inventory.gpus) : [];
    const usage = usageView(row, inventory, gpus);
    return {
      id: row.id, company: row.company, companyVersion: row.company_version, cluster: row.cluster, name: row.name, gpuModel: row.gpu_model,
      gpuCount: row.gpu_count, notes: row.notes, enabled: Boolean(row.enabled),
      gpus, inventoryVersion: inventory?.revision ?? 0,
      inventoryState: inventory?.state ?? 'manual', pendingGpus: inventory?.pending_gpus ? JSON.parse(inventory.pending_gpus) : null,
      lastSeenAt: inventory ? new Date(inventory.last_seen_at).toISOString() : null,
      observedAt: inventory ? new Date(inventory.observed_at).toISOString() : null,
      status: usage.state !== 'unknown' ? 'online' : inventory && now() - inventory.observed_at <= 90_000 ? inventory.status : 'unknown',
      usage,
    };
  }
  function viewReservation(row) {
    const result = reservationView(row);
    if (result.scope === 'gpus' && result.inventoryVersion > 0) {
      const resource = getResource(result.resourceId);
      const current = resource.company === result.company ? resource.gpus : [];
      // Historical or missing GPUs keep their saved index; never remap their stable identity.
      result.gpuIndices = result.gpuIds.map((id, index) => current.find(gpu => gpu.id === id)?.index ?? result.gpuIndices[index]).sort((a, b) => a - b);
    }
    return result;
  }
  function getResource(id) {
    const row = db.prepare('SELECT * FROM resources WHERE id=?').get(identifier(id));
    if (!row) missing('资源');
    return resourceView(row);
  }
  function getReservation(id) {
    const row = db.prepare(`${selectReservation} WHERE r.id=?`).get(identifier(id));
    if (!row) missing('预约');
    return viewReservation(row);
  }
  function checkResourceName(cluster, name, excludedId = '', company = '') {
    if (db.prepare('SELECT 1 FROM resources WHERE company=? AND cluster=? COLLATE NOCASE AND name=? COLLATE NOCASE AND id != ? LIMIT 1').get(company, cluster, name, excludedId)) {
      throw new ApiError(409, 'RESOURCE_DUPLICATE', '这个集群已有同名资源，请使用现有资源或检查资源名称');
    }
  }
  function checkPermission(reservation, user, version) {
    userIdentity(user);
    checkCompany(reservation, user, '预约');
    if (user.role !== 'admin' && reservation.ownerId !== user.id) throw new ApiError(403, 'FORBIDDEN', '只能修改自己的预约');
    integer(version, '预约版本', 1, Number.MAX_SAFE_INTEGER);
    if (reservation.version !== version) throw new ApiError(409, 'VERSION_CONFLICT', '预约已被其他操作更新，请刷新后重试');
    if (reservation.status !== 'confirmed') throw new ApiError(409, 'RESERVATION_CLOSED', '此预约已取消或结束');
  }
  function bookingFields(input, resource, timestamp, original) {
    const scope = input.scope;
    if (!['machine', 'gpus'].includes(scope)) invalid('请选择整机或指定 GPU');
    let gpuIndices = [], gpuIds = [], inventoryVersion = 0;
    if (resource.inventoryState !== 'manual') {
      if (resource.inventoryState === 'conflict' || input.inventoryVersion !== resource.inventoryVersion) {
        throw new ApiError(409, 'INVENTORY_CHANGED', 'GPU 清单已变化，请刷新；存在硬件冲突时请联系管理员确认资源清单');
      }
      if (!Array.isArray(input.gpuIds) || input.gpuIds.length > 64) invalid('同步资源必须按稳定 GPU 标识预约，请刷新资源');
      gpuIds = input.gpuIds.map(identifier).sort();
      if (new Set(gpuIds).size !== gpuIds.length) invalid('GPU 标识不能重复');
      const selected = gpuIds.map(id => resource.gpus.find(gpu => gpu.id === id));
      if (selected.some(gpu => !gpu)) throw new ApiError(409, 'INVENTORY_CHANGED', '所选 GPU 不在当前清单中，请刷新');
      gpuIndices = selected.map(gpu => gpu.index);
      inventoryVersion = resource.inventoryVersion;
      if (scope === 'machine' && gpuIds.length) invalid('整机预约不应指定 GPU');
      if (scope === 'gpus' && !gpuIds.length) invalid('请选择至少一张有效 GPU');
    } else {
      if (own(input, 'gpuIds') && (!Array.isArray(input.gpuIds) || input.gpuIds.length)) invalid('手工资源请使用 GPU 编号预约');
      if (!Array.isArray(input.gpuIndices) || input.gpuIndices.length > 64) invalid('GPU 编号必须是数组');
      gpuIndices = input.gpuIndices.map(value => integer(value, 'GPU 编号', 0, Math.max(0, resource.gpuCount - 1))).sort((a, b) => a - b);
      if (new Set(gpuIndices).size !== gpuIndices.length) invalid('GPU 编号不能重复');
      if (scope === 'machine' && gpuIndices.length) invalid('整机预约不应指定 GPU 编号');
      if (scope === 'gpus' && (!resource.gpuCount || !gpuIndices.length)) invalid('此资源需要选择至少一张有效 GPU；CPU 资源只能预约整机');
    }
    const start = parseDate(input.startAt, '开始时间'), end = parseDate(input.endAt, '结束时间');
    const oldStart = original ? Date.parse(original.startAt) : null;
    if (original && oldStart <= timestamp && start !== oldStart) invalid('已经开始的预约不能修改开始时间');
    if ((!original || oldStart > timestamp) && start < timestamp - 60_000) invalid('开始时间不能早于当前时间');
    if (end <= start || end <= timestamp) invalid('结束时间必须晚于开始时间及当前时间');
    if (end - start > 7 * DAY) invalid('单次预约最长 7 天');
    if (start > timestamp + 90 * DAY || end > timestamp + 90 * DAY) invalid('只能预约未来 90 天内的时间');
    return { scope, gpuIndices, gpuIds, inventoryVersion, start, end, purpose: text(input.purpose, '用途', 500) };
  }
  function checkConflicts(resourceId, booking, excludedId = '') {
    const existing = db.prepare(`${selectReservation} WHERE r.resource_id=? AND r.status='confirmed' AND r.start_at < ? AND r.end_at > ? AND r.id != ? ORDER BY r.start_at`).all(resourceId, booking.end, booking.start, excludedId);
    const conflicts = existing.filter(row => booking.scope === 'machine' || row.scope === 'machine' || (booking.inventoryVersion > 0 && row.inventory_version > 0 ? JSON.parse(row.gpu_ids).some(gpu => booking.gpuIds.includes(gpu)) : JSON.parse(row.gpu_indices).some(gpu => booking.gpuIndices.includes(gpu)))).map(viewReservation);
    if (conflicts.length) throw new ApiError(409, 'RESERVATION_CONFLICT', '所选资源在这个时间段已有预约，请调整时间或 GPU', conflicts.slice(0, 50));
  }
  function enqueue(type, reservation, timestamp) {
    const event = { type, reservation, resource: getResource(reservation.resourceId) };
    db.prepare('INSERT OR IGNORE INTO notification_outbox(reservation_id,version,event_type,payload,status,available_at,created_at) VALUES (?,?,?,?,?,?,?)')
      .run(reservation.id, reservation.version, type, JSON.stringify(event), notificationsConfigured ? 'pending' : 'disabled', timestamp, timestamp);
  }
  function normalizeGpus(input) {
    if (!Array.isArray(input) || input.length > 64) invalid('GPU 清单必须是最多 64 张卡的数组');
    const gpus = input.map(value => {
      object(value, ['uuid', 'index', 'name', 'memoryTotalMb']);
      const uuid = text(value.uuid, 'GPU UUID', 100).toLowerCase();
      if (!/^gpu-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(uuid) || uuid === 'gpu-00000000-0000-0000-0000-000000000000') {
        throw new ApiError(422, 'GPU_IDENTITY_UNAVAILABLE', '无法确认完整的 GPU 硬件 UUID；不支持占位卡号、NPU 编号或 MIG 分区，请检查采集结果');
      }
      if (typeof value.memoryTotalMb !== 'number' || !Number.isFinite(value.memoryTotalMb) || value.memoryTotalMb <= 0 || value.memoryTotalMb > 16_777_216) invalid('GPU 显存大小无效');
      return { uuid, index: integer(value.index, 'GPU 编号', 0, 63), model: text(value.name, 'GPU 型号', 100), memoryTotalMb: value.memoryTotalMb };
    }).sort((a, b) => a.uuid.localeCompare(b.uuid));
    if (new Set(gpus.map(gpu => gpu.uuid)).size !== gpus.length || new Set(gpus.map(gpu => gpu.index)).size !== gpus.length) invalid('GPU UUID 和编号不能重复');
    return gpus;
  }
  function inventoryShape(gpus) { return JSON.stringify(gpus.map(({ uuid, index, model, memoryTotalMb }) => ({ uuid, index, model, memoryTotalMb })).sort((a, b) => a.uuid.localeCompare(b.uuid))); }
  function sameHardware(left, right) { return left.length === right.length && left.every(gpu => right.some(other => other.uuid === gpu.uuid)); }
  function assignGpuIdentities(resourceId, gpus) {
    return gpus.map(gpu => {
      let identity = db.prepare('SELECT * FROM gpu_identity WHERE uuid=?').get(gpu.uuid);
      if (identity && identity.resource_id !== resourceId) throw new ApiError(409, 'TOPOLOGY_CONFLICT', '同一张 GPU 已属于另一个资源，请检查服务器或选择原资源');
      if (!identity) {
        identity = { id: randomUUID() };
        db.prepare('INSERT INTO gpu_identity(uuid,id,resource_id) VALUES(?,?,?)').run(gpu.uuid, identity.id, resourceId);
      }
      return { id: identity.id, ...gpu };
    });
  }
  function hasUpcomingReservations(id, timestamp) {
    return Boolean(db.prepare("SELECT 1 FROM reservations WHERE resource_id=? AND status='confirmed' AND end_at > ? LIMIT 1").get(id, timestamp));
  }
  function acceptInventory(id, expectedVersion, timestamp) {
    integer(expectedVersion, '资源清单版本', 1, Number.MAX_SAFE_INTEGER);
    const inventory = db.prepare('SELECT * FROM resource_inventory WHERE resource_id=?').get(id);
    if (!inventory || inventory.state !== 'conflict' || !inventory.pending_gpus || inventory.revision !== expectedVersion) throw new ApiError(409, 'INVENTORY_CHANGED', '待确认清单已变化，请刷新后重试');
    if (hasUpcomingReservations(id, timestamp)) throw new ApiError(409, 'RESOURCE_HAS_RESERVATIONS', '资源仍有尚未结束的预约，请先协调、取消或结束预约，再确认新 GPU 清单');
    const gpus = assignGpuIdentities(id, JSON.parse(inventory.pending_gpus));
    db.prepare("UPDATE resource_inventory SET gpus=?,pending_gpus=NULL,state='synced',revision=revision+1 WHERE resource_id=?").run(JSON.stringify(gpus), id);
    db.prepare('UPDATE resources SET gpu_model=?,gpu_count=?,updated_at=? WHERE id=?').run([...new Set(gpus.map(gpu => gpu.model))].join(' / ').slice(0, 100), gpus.length, timestamp, id);
  }
  function usageView(resource, inventory, gpus) {
    const reports = db.prepare('SELECT * FROM resource_usage WHERE resource_id=? ORDER BY observed_at DESC,received_at DESC,managed_server_id').all(resource.id);
    const timestamp = now();
    // The catalog may change the SSH destination or disable it after a report.
    // Stored observations from that previous directory version are not current.
    const hasDirectory = reports.length && db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='managed_servers'").get();
    const fresh = reports.filter(report => {
      if (timestamp - Math.min(report.observed_at, report.received_at) > 90_000 || report.status !== 'online') return false;
      if (hasDirectory && !db.prepare('SELECT 1 FROM managed_servers WHERE id=? AND company=? AND version=? AND enabled=1').get(report.managed_server_id, resource.company, report.server_version)) return false;
      return true;
    }).map(report => ({ ...report, gpus: JSON.parse(report.gpus) }));
    const selectedTimes = [];
    const devices = gpus.map(gpu => {
      const empty = { id: gpu.id, uuid: gpu.uuid, index: gpu.index, state: 'unknown', users: [], utilization: null, memoryUsedMb: null };
      if (inventory?.state === 'conflict') return empty;
      for (const report of fresh) {
        const observed = report.gpus.find(value => value.uuid === gpu.uuid);
        if (!observed) continue;
        const busy = observed.hasProcesses || observed.users.length > 0 || (observed.utilization ?? 0) > 0 || (observed.memoryUsedMb ?? 0) > 0;
        const free = report.inventory_complete && sameHardware(gpus, report.gpus) && report.process_query_ok && report.gpu_usage_valid
          && observed.utilization === 0 && observed.memoryUsedMb === 0 && !observed.hasProcesses && observed.users.length === 0;
        if (!busy && !free) continue;
        selectedTimes.push(Math.min(report.observed_at, report.received_at));
        return { ...empty, state: busy ? 'busy' : 'free', users: observed.users, utilization: observed.utilization, memoryUsedMb: observed.memoryUsedMb };
      }
      return empty;
    });
    return {
      state: devices.some(gpu => gpu.state === 'busy') ? 'busy' : devices.length && devices.every(gpu => gpu.state === 'free') ? 'free' : 'unknown',
      observedAt: selectedTimes.length ? new Date(Math.min(...selectedTimes)).toISOString() : null,
      gpus: devices,
    };
  }
  function telemetryFields(input, timestamp) {
    object(input, ['serverVersion', 'observedAt', 'status', 'inventoryComplete', 'gpus', 'processQueryOk', 'gpuUsageValid']);
    integer(input.serverVersion, '服务器版本', 1, Number.MAX_SAFE_INTEGER);
    const observedAt = integer(input.observedAt, '采集时间', 0, 8_640_000_000_000_000);
    if (observedAt > timestamp + 60_000) invalid('采集时间不能超前于服务器时间超过一分钟');
    if (!['online', 'unknown'].includes(input.status)) invalid('资源遥测状态无效');
    for (const field of ['inventoryComplete', 'processQueryOk', 'gpuUsageValid']) boolean(input[field], field);
    if (!Array.isArray(input.gpus) || input.gpus.length > 64) invalid('GPU 遥测必须是最多 64 张卡的数组');
    const hardware = normalizeGpus(input.gpus.map(value => {
      object(value, ['uuid', 'index', 'name', 'memoryTotalMb', 'utilization', 'memoryUsedMb', 'users', 'hasProcesses']);
      return { uuid: value.uuid, index: value.index, name: value.name, memoryTotalMb: value.memoryTotalMb };
    }));
    const gpus = hardware.map(gpu => {
      const value = input.gpus.find(item => item.uuid.toLowerCase() === gpu.uuid);
      const metric = (number, max, label) => {
        if (number === null) return null;
        if (typeof number !== 'number' || !Number.isFinite(number) || number < 0 || number > max) invalid(`${label}无效`);
        return number;
      };
      boolean(value.hasProcesses, 'GPU 进程状态');
      if (!Array.isArray(value.users) || value.users.length > 128) invalid('GPU 系统用户列表无效');
      const users = [...new Set(value.users.map(name => {
        const normalized = text(name, '系统用户名', 64);
        if (/[\u0000-\u001f\u007f]/u.test(normalized)) invalid('系统用户名格式无效');
        return normalized;
      }).filter(name => !['unknown', 'n/a', '<unknown>', '?', '匿名用户'].includes(name.toLowerCase())))].sort();
      if (value.users.length && !value.hasProcesses) invalid('系统用户与 GPU 进程状态不一致');
      return { ...gpu, utilization: metric(value.utilization, 100, 'GPU 利用率'), memoryUsedMb: metric(value.memoryUsedMb, gpu.memoryTotalMb, 'GPU 已用显存'), users, hasProcesses: value.hasProcesses };
    });
    if (input.status === 'online' && input.inventoryComplete && !gpus.length) invalid('GPU 资源必须包含完整硬件清单，不能从空清单推断 CPU');
    return { ...input, observedAt, gpus };
  }
  function syncManagedTelemetry(input, user, managed) {
    requireAdmin(user);
    const timestamp = now(), report = telemetryFields(input, timestamp);
    // managed is server-derived metadata from authorizeTelemetry, never body data.
    if (!managed || managed.enabled !== true || managed.version !== input.serverVersion || !companies.has(managed.company)) throw new ApiError(409, 'SERVER_CHANGED', '服务器资源已变化，请刷新目录');
    companyScope(user);
    if (enforceCompanies && !user.isSuperAdmin && user.company !== managed.company) missing('资源');
    const complete = report.status === 'online' && report.inventoryComplete && report.gpus.length > 0 && timestamp - report.observedAt <= 90_000;
    const result = transaction(() => {
      const binding = db.prepare('SELECT * FROM managed_resource_bindings WHERE managed_server_id=?').get(managed.id);
      // A failed first connection is not a CPU node or a new empty resource.
      if (!binding && !complete) return { resource: null };
      const claimed = new Set(report.gpus.map(gpu => db.prepare('SELECT resource_id FROM gpu_identity WHERE uuid=?').get(gpu.uuid)?.resource_id).filter(Boolean));
      let id = binding?.resource_id ?? (claimed.size === 1 ? [...claimed][0] : null);
      if (claimed.size > 1 || (id && [...claimed].some(owner => owner !== id))) throw new ApiError(409, 'TOPOLOGY_CONFLICT', 'GPU 清单属于不同资源，不能自动合并或转移预约');
      let resource = id ? db.prepare('SELECT * FROM resources WHERE id=?').get(id) : null;
      let inventory = id ? db.prepare('SELECT * FROM resource_inventory WHERE resource_id=?').get(id) : null;
      if (resource && resource.company && resource.company !== managed.company) throw new ApiError(409, 'RESOURCE_COMPANY_CONFLICT', '该硬件已属于其他组织，不能自动转移');
      if (resource && !inventory) throw new ApiError(409, 'INVENTORY_CHANGED', '现有资源缺少稳定 GPU 清单，不能自动绑定');
      const originalGpus = inventory ? JSON.parse(inventory.gpus) : [];
      if (resource && !binding && (!complete || !sameHardware(originalGpus, report.gpus))) throw new ApiError(409, 'TOPOLOGY_CONFLICT', '新连接必须提供现有资源完整且完全相同的 GPU 清单');
      if (resource && !resource.company) {
        if (!user.isSuperAdmin) throw new ApiError(403, 'SUPERADMIN_REQUIRED', '未分配硬件须由超级管理员确认所属组织');
        if (!complete || !sameHardware(originalGpus, report.gpus)) throw new ApiError(409, 'TOPOLOGY_CONFLICT', '认领未分配资源需要完整且完全相同的 GPU 清单');
        checkResourceName(resource.cluster, resource.name, id, managed.company);
        const assigned = db.prepare("UPDATE resources SET company=?,company_version=company_version+1,updated_at=? WHERE id=? AND company='' AND company_version=?").run(managed.company, timestamp, id, resource.company_version);
        if (assigned.changes !== 1) throw new ApiError(409, 'VERSION_CONFLICT', '资源组织已变化，请刷新');
        db.prepare("UPDATE reservations SET company=? WHERE resource_id=? AND company=''").run(managed.company, id);
      }
      if (!resource) {
        if (!complete) return { resource: null };
        const name = text(managed.name, '资源名称', 100), cluster = 'GPU集群';
        checkResourceName(cluster, name, '', managed.company);
        id = randomUUID();
        db.prepare('INSERT INTO resources(id,cluster,name,gpu_model,gpu_count,notes,created_at,updated_at,company) VALUES(?,?,?,?,?,?,?,?,?)')
          .run(id, cluster, name, [...new Set(report.gpus.map(gpu => gpu.model))].join(' / ').slice(0, 100), report.gpus.length, '', timestamp, timestamp, managed.company);
        const identified = assignGpuIdentities(id, report.gpus.map(({ uuid, index, model, memoryTotalMb }) => ({ uuid, index, model, memoryTotalMb })));
        db.prepare('INSERT INTO resource_inventory(resource_id,authority_source,authority_server,gpus,last_seen_at,observed_at,status) VALUES(?,?,?,?,?,?,?)')
          .run(id, `managed:${managed.id}`, managed.id, JSON.stringify(identified), timestamp, report.observedAt, 'online');
        inventory = db.prepare('SELECT * FROM resource_inventory WHERE resource_id=?').get(id);
      }
      const previous = db.prepare('SELECT observed_at FROM resource_usage WHERE resource_id=? AND managed_server_id=?').get(id, managed.id);
      if (previous && report.observedAt <= previous.observed_at) return { resource: getResource(id) };
      if (binding && complete && !sameHardware(originalGpus, report.gpus)) {
        const pending = inventoryShape(report.gpus), changed = inventory.pending_gpus !== pending || inventory.state !== 'conflict';
        db.prepare("UPDATE resource_inventory SET pending_gpus=?,state='conflict',revision=revision+? WHERE resource_id=?").run(pending, changed ? 1 : 0, id);
        return { error: new ApiError(409, 'INVENTORY_CHANGED', '检测到 GPU 清单变化，已保留原硬件和预约；请由管理员核验') };
      }
      if (binding && !complete && report.gpus.some(gpu => !originalGpus.some(original => original.uuid === gpu.uuid))) throw new ApiError(409, 'TOPOLOGY_CONFLICT', '不完整观测不能引入未知 GPU');
      // A newer, complete observation can refresh descriptors for exactly the
      // same physical GPUs. Stable IDs keep every booking attached to its card;
      // names, ownership and a pending topology review are never overwritten.
      if (complete && inventory?.state === 'synced' && report.observedAt > inventory.observed_at && sameHardware(originalGpus, report.gpus)) {
        const descriptors = report.gpus.map(({ uuid, index, model, memoryTotalMb }) => ({ uuid, index, model, memoryTotalMb }));
        const changed = inventoryShape(originalGpus) !== inventoryShape(descriptors);
        const identified = assignGpuIdentities(id, descriptors);
        db.prepare('UPDATE resource_inventory SET gpus=?,revision=revision+?,last_seen_at=?,observed_at=?,status=? WHERE resource_id=?')
          .run(JSON.stringify(identified), changed ? 1 : 0, timestamp, report.observedAt, 'online', id);
        if (changed) db.prepare('UPDATE resources SET gpu_model=?,updated_at=? WHERE id=?')
          .run([...new Set(descriptors.map(gpu => gpu.model))].join(' / ').slice(0, 100), timestamp, id);
      }
      db.prepare('INSERT OR IGNORE INTO managed_resource_bindings(managed_server_id,resource_id,created_at) VALUES(?,?,?)').run(managed.id, id, timestamp);
      db.prepare(`INSERT INTO resource_usage(resource_id,managed_server_id,server_version,observed_at,received_at,status,inventory_complete,process_query_ok,gpu_usage_valid,gpus)
        VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(resource_id,managed_server_id) DO UPDATE SET server_version=excluded.server_version,observed_at=excluded.observed_at,
        received_at=excluded.received_at,status=excluded.status,inventory_complete=excluded.inventory_complete,process_query_ok=excluded.process_query_ok,gpu_usage_valid=excluded.gpu_usage_valid,gpus=excluded.gpus`)
        .run(id, managed.id, managed.version, report.observedAt, timestamp, report.status, report.inventoryComplete ? 1 : 0, report.processQueryOk ? 1 : 0, report.gpuUsageValid ? 1 : 0, JSON.stringify(report.gpus));
      return { resource: getResource(id) };
    });
    if (result.error) throw result.error;
    return result.resource;
  }
  function syncResource(input, user) {
    requireAdmin(user);
    object(input, ['sourceId', 'serverId', 'resourceId', 'name', 'cluster', 'notes', 'gpus', 'observedAt', 'status']);
    const sourceId = identifier(input.sourceId), serverId = identifier(input.serverId);
    const explicitId = own(input, 'resourceId') ? identifier(input.resourceId) : null;
    const name = text(input.name, '资源名称', 100), cluster = text(input.cluster, '集群名称', 100), notes = text(input.notes, '备注', 1000, true);
    const timestamp = now(), observedAt = typeof input.observedAt === 'number' ? integer(input.observedAt, '采集时间', 0, 8_640_000_000_000_000) : parseDate(input.observedAt, '采集时间');
    if (observedAt > timestamp + 60_000) invalid('采集时间不能超前于服务器时间超过一分钟');
    if (!['online', 'offline', 'unknown'].includes(input.status)) invalid('资源状态无效');
    const gpus = normalizeGpus(input.gpus);
    const result = transaction(() => {
      const binding = db.prepare('SELECT * FROM resource_bindings WHERE source_id=? AND server_id=?').get(sourceId, serverId);
      if (binding && explicitId && binding.resource_id !== explicitId) throw new ApiError(409, 'TOPOLOGY_CONFLICT', '此本地连接已绑定另一个资源，不能自动转移预约');
      const claimedResources = new Set(gpus.map(gpu => db.prepare('SELECT resource_id FROM gpu_identity WHERE uuid=?').get(gpu.uuid)?.resource_id).filter(Boolean));
      let id = binding?.resource_id ?? explicitId ?? (claimedResources.size === 1 ? [...claimedResources][0] : null);
      if (claimedResources.size > 1 || (id && [...claimedResources].some(owner => owner !== id))) throw new ApiError(409, 'TOPOLOGY_CONFLICT', '上报的 GPU 分属其他资源，不能合并或转移预约');
      if (id) checkCompany(getResource(id), user);
      const company = id ? getResource(id).company : resourceCompany(input, user);
      const inventory = id ? db.prepare('SELECT * FROM resource_inventory WHERE resource_id=?').get(id) : null;
      const authoritative = !inventory || (inventory.authority_source === sourceId && inventory.authority_server === serverId);
      if (inventory && !authoritative) {
        if (!(binding && input.status !== 'online') && !sameHardware(JSON.parse(inventory.gpus), gpus)) throw new ApiError(409, 'TOPOLOGY_CONFLICT', '该连接只能看到部分 GPU 或不同的硬件，不能覆盖原资源；请使用完整清单的原连接');
        db.prepare('INSERT OR IGNORE INTO resource_bindings(source_id,server_id,resource_id,created_at) VALUES(?,?,?,?)').run(sourceId, serverId, id, timestamp);
        return { ...getResource(id), binding: { sourceId, serverId, authoritative: false } };
      }
      if (!inventory) {
        if (input.status !== 'online' || timestamp - observedAt > 90_000) throw new ApiError(409, 'INVENTORY_CHANGED', '首次登记需要最近 90 秒内在线采集的完整 GPU 清单');
        if (id && hasUpcomingReservations(id, timestamp)) throw new ApiError(409, 'INVENTORY_CHANGED', '现有手工资源仍有预约，无法依据当前编号推断当时的 GPU；请先处理预约再绑定硬件');
        checkResourceName(cluster, name, id ?? '', company);
        if (!id) {
          id = randomUUID();
          db.prepare('INSERT INTO resources(id,cluster,name,gpu_model,gpu_count,notes,created_at,updated_at,company) VALUES(?,?,?,?,?,?,?,?,?)').run(id, cluster, name, '', gpus.length, notes, timestamp, timestamp, company);
        }
        const identified = assignGpuIdentities(id, gpus);
        db.prepare('INSERT INTO resource_inventory(resource_id,authority_source,authority_server,gpus,last_seen_at,observed_at,status) VALUES(?,?,?,?,?,?,?)').run(id, sourceId, serverId, JSON.stringify(identified), timestamp, observedAt, input.status);
        db.prepare('INSERT INTO resource_bindings(source_id,server_id,resource_id,created_at) VALUES(?,?,?,?)').run(sourceId, serverId, id, timestamp);
        db.prepare('UPDATE resources SET cluster=?,name=?,gpu_model=?,gpu_count=?,notes=?,updated_at=? WHERE id=?').run(cluster, name, [...new Set(gpus.map(gpu => gpu.model))].join(' / ').slice(0, 100), gpus.length, notes, timestamp, id);
      } else {
        db.prepare('UPDATE resource_inventory SET last_seen_at=? WHERE resource_id=?').run(timestamp, id);
        // An offline report updates liveness only. It must never erase the last known hardware.
        if (input.status !== 'online') {
          db.prepare('UPDATE resource_inventory SET last_seen_at=?,observed_at=?,status=? WHERE resource_id=?').run(timestamp, Math.max(observedAt, inventory.observed_at), input.status, id);
        } else if (observedAt < inventory.observed_at) {
          return { ...getResource(id), binding: { sourceId, serverId, authoritative: true } };
        } else if (!sameHardware(JSON.parse(inventory.gpus), gpus)) {
          const pending = inventoryShape(gpus), changed = inventory.pending_gpus !== pending || inventory.state !== 'conflict';
          db.prepare("UPDATE resource_inventory SET pending_gpus=?,state='conflict',revision=revision+?,last_seen_at=?,observed_at=?,status=? WHERE resource_id=?").run(pending, changed ? 1 : 0, timestamp, observedAt, input.status, id);
          // Commit the diagnostic before reporting 409; the old inventory and every reservation stay intact.
          return { error: new ApiError(409, 'INVENTORY_CHANGED', '检测到 GPU 缺失、更换或数量变化，已保留原清单与预约；请在网页由管理员确认新清单') };
        } else {
          checkResourceName(cluster, name, id, company);
          const identified = assignGpuIdentities(id, gpus);
          const changed = inventoryShape(JSON.parse(inventory.gpus)) !== inventoryShape(gpus) || inventory.state !== 'synced';
          db.prepare("UPDATE resource_inventory SET gpus=?,pending_gpus=NULL,state='synced',revision=revision+?,last_seen_at=?,observed_at=?,status=? WHERE resource_id=?").run(JSON.stringify(identified), changed ? 1 : 0, timestamp, observedAt, input.status, id);
          db.prepare('UPDATE resources SET cluster=?,name=?,gpu_model=?,notes=?,updated_at=? WHERE id=?').run(cluster, name, [...new Set(gpus.map(gpu => gpu.model))].join(' / ').slice(0, 100), notes, timestamp, id);
        }
      }
      return { ...getResource(id), binding: { sourceId, serverId, authoritative: true } };
    });
    if (result.error) throw result.error;
    return result;
  }
  function createResource(input, user) {
    requireAdmin(user);
    object(input, ['cluster', 'name', 'gpuModel', 'gpuCount', 'notes', 'company']);
    const company = resourceCompany(input, user);
    const id = randomUUID(), timestamp = now();
    const cluster = text(input.cluster, '集群名称', 100), name = text(input.name, '资源名称', 100);
    const gpuCount = integer(input.gpuCount, 'GPU 数量', 0, 64);
    const gpuModel = text(input.gpuModel ?? '', 'GPU 型号', 100, gpuCount === 0), notes = text(input.notes, '备注', 1000, true);
    return transaction(() => {
      checkResourceName(cluster, name, '', company);
      db.prepare('INSERT INTO resources(id,cluster,name,gpu_model,gpu_count,notes,created_at,updated_at,company) VALUES(?,?,?,?,?,?,?,?,?)').run(id, cluster, name, gpuModel, gpuCount, notes, timestamp, timestamp, company);
      return getResource(id);
    });
  }
  function updateResource(id, input, user) {
    requireAdmin(user);
    object(input, ['cluster', 'name', 'gpuModel', 'gpuCount', 'notes', 'enabled', 'acceptInventoryVersion', 'company', 'companyVersion']);
    if (!Object.keys(input).length) invalid('请提供要修改的资源字段');
    return transaction(() => {
      let original = checkCompany(getResource(id), user);
      const company = resourceCompany(input, user, original);
      if (company !== original.company && input.companyVersion !== original.companyVersion) throw new ApiError(409, 'VERSION_CONFLICT', '资源公司已变化，请刷新后再分配');
      const timestamp = now();
      if (own(input, 'acceptInventoryVersion')) {
        acceptInventory(id, input.acceptInventoryVersion, timestamp);
        original = getResource(id);
      }
      if (original.inventoryState !== 'manual' && (own(input, 'gpuCount') || own(input, 'gpuModel'))) {
        throw new ApiError(409, 'INVENTORY_CHANGED', '同步资源的 GPU 清单由 RackTop 上报，不能手动改写数量或型号');
      }
      if (original.company && company !== original.company && hasUpcomingReservations(id, timestamp)) throw new ApiError(409, 'RESOURCE_HAS_RESERVATIONS', '资源仍有未结束的预约，结束或取消后才能调整公司');
      const merged = { ...original, ...input };
      const gpuCount = integer(merged.gpuCount, 'GPU 数量', 0, 64);
      const cluster = text(merged.cluster, '集群名称', 100), name = text(merged.name, '资源名称', 100);
      checkResourceName(cluster, name, id, company);
      if (gpuCount !== original.gpuCount && db.prepare("SELECT 1 FROM reservations WHERE resource_id=? AND status='confirmed' AND end_at > ? LIMIT 1").get(id, timestamp)) throw new ApiError(409, 'RESOURCE_HAS_RESERVATIONS', '资源存在尚未结束的预约，不能修改 GPU 数量');
      db.prepare('UPDATE resources SET cluster=?,name=?,gpu_model=?,gpu_count=?,notes=?,enabled=?,updated_at=?,company=?,company_version=company_version+? WHERE id=?').run(
        cluster, name, text(merged.gpuModel, 'GPU 型号', 100, gpuCount === 0), gpuCount,
        text(merged.notes, '备注', 1000, true), boolean(merged.enabled, '启用状态') ? 1 : 0, timestamp, company, company === original.company ? 0 : 1, id);
      if (!original.company && company) db.prepare("UPDATE reservations SET company=? WHERE resource_id=? AND company=''").run(company, id);
      return getResource(id);
    });
  }
  function createReservation(input, user) {
    userIdentity(user);
    object(input, ['resourceId', 'scope', 'gpuIndices', 'gpuIds', 'inventoryVersion', 'requestId', 'startAt', 'endAt', 'purpose']);
    const requestId = own(input, 'requestId') ? identifier(input.requestId) : null;
    const requestHash = requestId ? createHash('sha256').update(JSON.stringify(Object.keys(input).filter(key => key !== 'requestId').sort().map(key => [key, input[key]]))).digest('hex') : null;
    return transaction(() => {
      if (requestId) {
        const previous = db.prepare('SELECT * FROM reservation_requests WHERE owner_id=? AND request_id=?').get(user.id, requestId);
        if (previous) {
          if (previous.payload_hash !== requestHash) throw new ApiError(409, 'IDEMPOTENCY_CONFLICT', '同一预约请求不能更改内容，请刷新后重新提交');
          return checkCompany(getReservation(previous.reservation_id), user, '预约');
        }
      }
      const resource = checkCompany(getResource(input.resourceId), user), timestamp = now();
      if (enforceCompanies && !companies.has(resource.company)) invalid('请先为资源分配公司再预约');
      if (!resource.enabled) invalid('此资源已停用，不能新建预约');
      const booking = bookingFields(input, resource, timestamp);
      checkConflicts(resource.id, booking);
      const id = randomUUID();
      db.prepare("INSERT INTO reservations(id,resource_id,owner_id,owner_name,scope,gpu_indices,gpu_ids,inventory_version,start_at,end_at,purpose,status,created_at,updated_at,company,resource_name_snapshot,cluster_snapshot) VALUES (?,?,?,?,?,?,?,?,?,?,?,'confirmed',?,?,?,?,?)")
        .run(id, resource.id, user.id, user.name, booking.scope, JSON.stringify(booking.gpuIndices), JSON.stringify(booking.gpuIds), booking.inventoryVersion, booking.start, booking.end, booking.purpose, timestamp, timestamp, resource.company, resource.name, resource.cluster);
      if (requestId) db.prepare('INSERT INTO reservation_requests(owner_id,request_id,payload_hash,reservation_id) VALUES(?,?,?,?)').run(user.id, requestId, requestHash, id);
      const reservation = getReservation(id); enqueue('created', reservation, timestamp); return reservation;
    });
  }
  function updateReservation(id, input, user) {
    object(input, ['version', 'startAt', 'endAt', 'purpose', 'scope', 'gpuIndices', 'gpuIds', 'inventoryVersion']);
    if (Object.keys(input).length < 2) invalid('请提供要修改的预约字段');
    return transaction(() => {
      const original = getReservation(id); checkPermission(original, user, input.version);
      const resource = checkCompany(getResource(original.resourceId), user), timestamp = now();
      if (Date.parse(original.endAt) <= timestamp) throw new ApiError(409, 'RESERVATION_ELAPSED', '此预约时间已结束，不能再修改');
      if (!resource.enabled) invalid('此资源已停用，不能修改预约；仍可取消或提前结束');
      const merged = { ...original, ...input };
      if (resource.inventoryState !== 'manual' && input.inventoryVersion !== resource.inventoryVersion) throw new ApiError(409, 'INVENTORY_CHANGED', 'GPU 清单已变化，请刷新后重试');
      if (input.scope === 'machine') { merged.gpuIndices = []; merged.gpuIds = []; }
      const booking = bookingFields(merged, resource, timestamp, original);
      checkConflicts(resource.id, booking, id);
      db.prepare('UPDATE reservations SET scope=?,gpu_indices=?,gpu_ids=?,inventory_version=?,start_at=?,end_at=?,purpose=?,updated_at=?,version=version+1 WHERE id=? AND version=?')
        .run(booking.scope, JSON.stringify(booking.gpuIndices), JSON.stringify(booking.gpuIds), booking.inventoryVersion, booking.start, booking.end, booking.purpose, timestamp, id, input.version);
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
    const company = companyScope(user);
    return db.prepare(`${selectReservation} WHERE r.start_at < ? AND r.end_at > ? ${mine ? 'AND r.owner_id=?' : ''} ${company === null ? '' : 'AND r.company=?'} ORDER BY r.start_at,r.created_at LIMIT 1000`).all(to, from, ...(mine ? [user.id] : []), ...(company === null ? [] : [company])).map(viewReservation);
  }
  function enqueueEnding() {
    return transaction(() => {
      const timestamp = now();
      const rows = db.prepare(`${selectReservation} WHERE r.status='confirmed' AND r.start_at <= ? AND r.end_at > ? AND r.end_at <= ?`).all(timestamp, timestamp, timestamp + 30 * 60_000);
      for (const row of rows) enqueue('ending', viewReservation(row), timestamp);
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
      db.exec("UPDATE reservations SET resource_name_snapshot=(SELECT name FROM resources WHERE id=resource_id),cluster_snapshot=(SELECT cluster FROM resources WHERE id=resource_id) WHERE resource_name_snapshot=''");
      db.prepare("INSERT INTO metadata(key,value) VALUES('demo_seeded','1')").run();
    });
  }
  return {
    getResource: (id, user) => checkCompany(getResource(id), user),
    getReservation: (id, user) => checkCompany(getReservation(id), user, '预约'),
    createResource, updateResource, syncResource, syncManagedTelemetry,
    listResources: user => { const company = companyScope(user); return db.prepare(`SELECT * FROM resources ${company === null ? '' : 'WHERE company=?'} ORDER BY cluster,name,id`).all(...(company === null ? [] : [company])).map(resourceView); },
    createReservation, updateReservation, listReservations,
    cancelReservation: (id, input, user) => transition(id, input, user, false),
    finishReservation: (id, input, user) => transition(id, input, user, true),
    enqueueEnding, claimOutbox, completeOutbox, retryOutbox, seedDemo,
    close: () => db.close(),
  };
}
