import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { ApiError } from './store.mjs';

const fields = { name: 120, category: 80, model: 160, serialNumber: 160, responsiblePerson: 80, location: 160, notes: 4000 };
const mutable = [...Object.keys(fields), 'status'];
const statuses = new Set(['available', 'in_use', 'maintenance', 'retired']);
const columns = { name: 'name', category: 'category', model: 'model', serialNumber: 'serial_number', responsiblePerson: 'responsible_person', location: 'location', notes: 'notes', status: 'status' };
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
function invalid(message) { throw new ApiError(422, 'INVALID_INPUT', message); }
function actor(user) {
  if (!user || typeof user.id !== 'string' || !user.id || typeof user.name !== 'string' || !user.name || !['admin', 'member'].includes(user.role)) throw new ApiError(401, 'UNAUTHENTICATED', '请先登录');
  return { id: user.id, name: user.name };
}
function identifier(value) {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) invalid('设备标识符必须为 UUID');
  return value.toLowerCase();
}
function input(value, patch) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('请求内容必须为 JSON 对象');
  for (const key of Object.keys(value)) if (!mutable.includes(key) && !(patch && key === 'version')) invalid(`不支持的设备字段：${key}`);
  if (patch && (!Number.isSafeInteger(value.version) || value.version < 1)) invalid('修改设备必须提交当前整数 version');
  if (patch && !mutable.some(key => own(value, key))) invalid('请至少提交一个设备字段');
  const result = {};
  for (const [key, max] of Object.entries(fields)) {
    if (patch && !own(value, key)) continue;
    const raw = own(value, key) ? value[key] : (key === 'name' ? undefined : '');
    if (typeof raw !== 'string') invalid(`${key} 必须为文本`);
    const text = raw.trim();
    if ((key === 'name' && !text) || text.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text)) invalid(`${key} 格式或长度无效（最多 ${max} 字符）`);
    result[key] = text;
  }
  if (!patch || own(value, 'status')) {
    result.status = own(value, 'status') ? value.status : 'available';
    if (!statuses.has(result.status)) invalid('设备状态无效');
  }
  return result;
}
function view(row) {
  return { id: row.id, code: row.code, name: row.name, category: row.category, model: row.model,
    serialNumber: row.serial_number, responsiblePerson: row.responsible_person, location: row.location,
    notes: row.notes, status: row.status, version: row.version,
    createdAt: new Date(row.created_at).toISOString(), updatedAt: new Date(row.updated_at).toISOString() };
}

// Equipment shares the booking database file, so the existing SQLite backup
// captures it consistently. No account IDs or authentication state are public.
export function createEquipmentStore({ dbPath = ':memory:', now = Date.now } = {}) {
  if (dbPath !== ':memory:') mkdirSync(dirname(resolve(dbPath)), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(dbPath);
  try {
    db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL;');
    db.exec(`
      CREATE TABLE IF NOT EXISTS equipment (
        id TEXT PRIMARY KEY, code TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL, category TEXT NOT NULL, model TEXT NOT NULL, serial_number TEXT NOT NULL,
        responsible_person TEXT NOT NULL, location TEXT NOT NULL, notes TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('available','in_use','maintenance','retired')),
        version INTEGER NOT NULL CHECK(version > 0), created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        creator_id TEXT NOT NULL, creator_name TEXT NOT NULL, editor_id TEXT NOT NULL, editor_name TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS equipment_changes (
        id INTEGER PRIMARY KEY AUTOINCREMENT, equipment_id TEXT NOT NULL REFERENCES equipment(id),
        actor_id TEXT NOT NULL, actor_name TEXT NOT NULL, action TEXT NOT NULL CHECK(action IN ('created','updated')),
        at INTEGER NOT NULL, changes TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS equipment_recent_changes ON equipment_changes(equipment_id,id DESC);
    `);
  } catch (error) { db.close(); throw error; }
  function transaction(operation, write = true) {
    let started = false;
    try {
      db.exec(write ? 'BEGIN IMMEDIATE' : 'BEGIN'); started = true;
      const result = operation(); db.exec('COMMIT'); return result;
    } catch (error) {
      if (started) { try { db.exec('ROLLBACK'); } catch { /* preserve original error */ } }
      if (error?.errcode === 5 || error?.code === 'SQLITE_BUSY') throw new ApiError(503, 'DATABASE_BUSY', '设备台账繁忙，请稍后重试');
      throw error;
    }
  }
  function rowFor(id) {
    const row = db.prepare('SELECT * FROM equipment WHERE id=?').get(identifier(id));
    if (!row) throw new ApiError(404, 'NOT_FOUND', '找不到设备');
    return row;
  }
  function record(id, user, action, timestamp, changes) {
    db.prepare('INSERT INTO equipment_changes(equipment_id,actor_id,actor_name,action,at,changes) VALUES(?,?,?,?,?,?)')
      .run(id, user.id, user.name, action, timestamp, JSON.stringify(changes));
  }
  function get(id) {
    return transaction(() => {
      const equipment = view(rowFor(id));
      const history = db.prepare('SELECT actor_name,action,at,changes FROM equipment_changes WHERE equipment_id=? ORDER BY id DESC LIMIT 30')
        .all(equipment.id).map(row => ({ actorName: row.actor_name, action: row.action, at: new Date(row.at).toISOString(), changes: JSON.parse(row.changes) }));
      return { equipment, history };
    }, false);
  }
  function create(value, user) {
    const editor = actor(user), data = input(value, false);
    return transaction(() => {
      if (db.prepare('SELECT COUNT(*) AS count FROM equipment').get().count >= 5000) throw new ApiError(409, 'EQUIPMENT_LIMIT', '设备台账已达到 5000 条上限');
      const id = randomUUID(), timestamp = now();
      const statement = db.prepare(`INSERT INTO equipment(id,code,${mutable.map(key => columns[key]).join(',')},version,created_at,updated_at,creator_id,creator_name,editor_id,editor_name)
        VALUES(?,?,${mutable.map(() => '?').join(',')},1,?,?,?,?,?,?) ON CONFLICT(code) DO NOTHING`);
      for (let attempt = 0; attempt < 5; attempt++) {
        const code = `RT-${randomUUID().slice(0, 8).toUpperCase()}`;
        const result = statement.run(id, code, ...mutable.map(key => data[key]), timestamp, timestamp, editor.id, editor.name, editor.id, editor.name);
        if (result.changes) {
          record(id, editor, 'created', timestamp, ['code', ...mutable].map(field => ({ field, oldValue: null, newValue: field === 'code' ? code : data[field] })));
          return view(rowFor(id));
        }
      }
      throw new ApiError(503, 'CODE_UNAVAILABLE', '暂时无法分配设备编号，请重试');
    });
  }
  function update(id, value, user) {
    const editor = actor(user), data = input(value, true);
    return transaction(() => {
      const previous = view(rowFor(id));
      if (previous.version !== value.version) throw new ApiError(409, 'VERSION_CONFLICT', '设备已被其他人修改，请刷新后重新编辑');
      const changes = mutable.filter(field => own(data, field) && data[field] !== previous[field])
        .map(field => ({ field, oldValue: previous[field], newValue: data[field] }));
      if (!changes.length) return previous;
      if (previous.version >= Number.MAX_SAFE_INTEGER) throw new ApiError(409, 'VERSION_CONFLICT', '设备版本已达到上限');
      const next = { ...previous, ...data }, timestamp = now();
      const result = db.prepare(`UPDATE equipment SET ${mutable.map(key => `${columns[key]}=?`).join(',')},version=version+1,updated_at=?,editor_id=?,editor_name=? WHERE id=? AND version=?`)
        .run(...mutable.map(key => next[key]), timestamp, editor.id, editor.name, previous.id, value.version);
      if (!result.changes) throw new ApiError(409, 'VERSION_CONFLICT', '设备已被其他人修改，请刷新后重新编辑');
      record(previous.id, editor, 'updated', timestamp, changes);
      return view(rowFor(previous.id));
    });
  }
  return { list: () => db.prepare('SELECT * FROM equipment ORDER BY updated_at DESC,code ASC').all().map(view), get, create, update, close: () => db.close() };
}
