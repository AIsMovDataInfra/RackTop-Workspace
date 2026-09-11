import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { ApiError } from './store.mjs';

const fields = { name: 120, category: 80, model: 160, company: 80, responsiblePerson: 80, currentUser: 80, location: 160, notes: 4000 };
const mutable = [...Object.keys(fields), 'status'];
const statuses = new Set(['available', 'in_use', 'maintenance', 'retired']);
const categories = new Set(['机械臂', '台式主机', '显示屏', '摄像头模组', '实验物料', '小推车', '夹爪']);
const locations = new Set(['上海', '太仓']);
const companies = new Set(['A公司', 'B公司', 'C公司', '西浦']);
const columns = { name: 'name', category: 'category', model: 'model', company: 'company', responsiblePerson: 'responsible_person', currentUser: 'current_user', location: 'location', notes: 'notes', status: 'status' };
const maxPhotoBytes = 512 * 1024;
// Metadata queries deliberately exclude the image BLOB. Only getPhoto reads it.
const equipmentSelect = `SELECT e.*,p.width AS photo_width,p.height AS photo_height,
  length(p.bytes) AS photo_bytes,p.updated_at AS photo_updated_at
  FROM equipment e LEFT JOIN equipment_photos p ON p.equipment_id=e.id`;
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
function validClassification(value) {
  if (!categories.has(value.category)) invalid('请选择有效的设备类别');
  if (!locations.has(value.location)) invalid('请选择上海或太仓作为设备位置');
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
  if (!patch) validClassification(result);
  else {
    if (own(result, 'category') && !categories.has(result.category)) invalid('请选择有效的设备类别');
    if (own(result, 'location') && !locations.has(result.location)) invalid('请选择上海或太仓作为设备位置');
  }
  if (!patch || own(value, 'status')) {
    result.status = own(value, 'status') ? value.status : 'available';
    if (!statuses.has(result.status)) invalid('设备状态无效');
  }
  return result;
}
function view(row) {
  return { id: row.id, code: row.code, name: row.name, category: row.category, model: row.model, company: row.company,
    serialNumber: row.serial_number, legacySerialNumber: row.legacy_serial_number,
    responsiblePerson: row.responsible_person, currentUser: row.current_user, location: row.location,
    notes: row.notes, status: row.status, version: row.version,
    photo: row.photo_width == null ? null : { url: `/api/equipment/${row.id}/photo?v=${row.version}`,
      width: row.photo_width, height: row.photo_height, bytes: row.photo_bytes, updatedAt: new Date(row.photo_updated_at).toISOString() },
    createdAt: new Date(row.created_at).toISOString(), updatedAt: new Date(row.updated_at).toISOString() };
}
function photoInput(value, includeBytes) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('照片参数无效');
  const allowed = includeBytes ? ['version', 'bytes', 'width', 'height'] : ['version'];
  for (const key of Object.keys(value)) if (!allowed.includes(key)) invalid(`不支持的照片字段：${key}`);
  if (!Number.isSafeInteger(value.version) || value.version < 1) invalid('修改照片必须提交当前整数 version');
  if (includeBytes) {
    // The HTTP image decoder supplies these dimensions after decoding/rotating
    // and compressing the original. Client-supplied metadata never reaches here.
    if (!Buffer.isBuffer(value.bytes) || value.bytes.length < 5 || value.bytes.length > maxPhotoBytes ||
      value.bytes[0] !== 0xff || value.bytes[1] !== 0xd8 || value.bytes[2] !== 0xff ||
      value.bytes[value.bytes.length - 2] !== 0xff || value.bytes[value.bytes.length - 1] !== 0xd9) invalid('照片必须为不超过 512 KB 的 JPEG');
    if (![value.width, value.height].every(size => Number.isSafeInteger(size) && size >= 1 && size <= 1600)) invalid('照片宽高必须在 1–1600 像素之间');
  }
}
function photoDescription(photo) {
  return photo ? `${photo.url}（${photo.width}×${photo.height}，${photo.bytes} 字节）` : null;
}

// Equipment shares the booking database file, so the existing SQLite backup
// captures it consistently. No account IDs or authentication state are public.
export function createEquipmentStore({ dbPath = ':memory:', now = Date.now, enforceCompanies = false } = {}) {
  if (dbPath !== ':memory:') mkdirSync(dirname(resolve(dbPath)), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(dbPath);
  try {
    db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
    db.exec('BEGIN IMMEDIATE');
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
      CREATE TABLE IF NOT EXISTS equipment_migrations (name TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS equipment_serial_numbers (
        number INTEGER PRIMARY KEY AUTOINCREMENT CHECK(number BETWEEN 1 AND 99999999),
        equipment_id TEXT NOT NULL UNIQUE
      );
      CREATE TABLE IF NOT EXISTS equipment_photos (
        equipment_id TEXT PRIMARY KEY REFERENCES equipment(id) ON DELETE CASCADE,
        bytes BLOB NOT NULL CHECK(typeof(bytes)='blob' AND length(bytes) BETWEEN 5 AND 524288),
        width INTEGER NOT NULL CHECK(typeof(width)='integer' AND width BETWEEN 1 AND 1600),
        height INTEGER NOT NULL CHECK(typeof(height)='integer' AND height BETWEEN 1 AND 1600),
        updated_at INTEGER NOT NULL
      );
    `);
    const equipmentColumns = new Set(db.prepare('PRAGMA table_info(equipment)').all().map(column => column.name));
    if (!equipmentColumns.has('legacy_serial_number')) db.exec("ALTER TABLE equipment ADD COLUMN legacy_serial_number TEXT NOT NULL DEFAULT ''");
    if (!equipmentColumns.has('current_user')) db.exec("ALTER TABLE equipment ADD COLUMN current_user TEXT NOT NULL DEFAULT ''");
    if (!equipmentColumns.has('company')) db.exec("ALTER TABLE equipment ADD COLUMN company TEXT NOT NULL DEFAULT ''");
    const historyColumns = new Set(db.prepare('PRAGMA table_info(equipment_changes)').all().map(column => column.name));
    if (!historyColumns.has('company')) {
      db.exec("ALTER TABLE equipment_changes ADD COLUMN company TEXT NOT NULL DEFAULT ''");
      const scopes = new Map();
      for (const entry of db.prepare('SELECT id,equipment_id,changes FROM equipment_changes ORDER BY id').all()) {
        let changes; try { changes = JSON.parse(entry.changes); } catch { changes = []; }
        const transfer = Array.isArray(changes) ? changes.find(change => change.field === 'company') : undefined;
        const before = scopes.get(entry.equipment_id) || '';
        const scope = transfer ? transfer.oldValue === null ? transfer.newValue : transfer.oldValue : before;
        db.prepare('UPDATE equipment_changes SET company=? WHERE id=?').run(companies.has(scope) ? scope : '', entry.id);
        scopes.set(entry.equipment_id, transfer ? transfer.newValue : before);
      }
    }
    if (!db.prepare("SELECT 1 FROM equipment_migrations WHERE name='immutable-serial-v1'").get()) {
      const existing = db.prepare('SELECT id,serial_number FROM equipment ORDER BY created_at,rowid').all();
      for (const row of existing) {
        const number = db.prepare('INSERT INTO equipment_serial_numbers(equipment_id) VALUES(?)').run(row.id).lastInsertRowid;
        db.prepare('UPDATE equipment SET legacy_serial_number=serial_number,serial_number=? WHERE id=?')
          .run(String(number).padStart(8, '0'), row.id);
      }
      db.prepare('INSERT INTO equipment_migrations(name) VALUES(?)').run('immutable-serial-v1');
    }
    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS equipment_serial_unique ON equipment(serial_number);
      CREATE TRIGGER IF NOT EXISTS equipment_serial_immutable BEFORE UPDATE OF serial_number ON equipment
      WHEN NEW.serial_number IS NOT OLD.serial_number
      BEGIN SELECT RAISE(ABORT, 'equipment serial number is immutable'); END;
      CREATE TRIGGER IF NOT EXISTS equipment_serial_insert BEFORE INSERT ON equipment
      WHEN length(NEW.serial_number) != 8 OR NEW.serial_number GLOB '*[^0-9]*'
        OR NOT EXISTS(SELECT 1 FROM equipment_serial_numbers WHERE equipment_id=NEW.id AND printf('%08d',number)=NEW.serial_number)
      BEGIN SELECT RAISE(ABORT, 'equipment serial number must be allocated by the server'); END;
      CREATE TRIGGER IF NOT EXISTS equipment_serial_allocation_immutable BEFORE UPDATE ON equipment_serial_numbers
      BEGIN SELECT RAISE(ABORT, 'equipment serial allocation is immutable'); END;
      CREATE TRIGGER IF NOT EXISTS equipment_serial_allocation_permanent BEFORE DELETE ON equipment_serial_numbers
      BEGIN SELECT RAISE(ABORT, 'equipment serial allocation is permanent'); END;
    `);
    db.exec('COMMIT');
  } catch (error) { try { db.exec('ROLLBACK'); } catch { /* initialization may not have started */ } db.close(); throw error; }
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
    const row = db.prepare(`${equipmentSelect} WHERE e.id=?`).get(identifier(id));
    if (!row) throw new ApiError(404, 'NOT_FOUND', '找不到设备');
    return row;
  }
  function companyScope(user) {
    if (!enforceCompanies) return null;
    actor(user);
    if (user.isSuperAdmin === true) return null;
    if (!companies.has(user.company)) throw new ApiError(403, 'COMPANY_REQUIRED', '请联系超级管理员分配公司');
    return user.company;
  }
  function scopedRow(id, user) {
    const scope = companyScope(user), row = rowFor(id);
    if (scope !== null && row.company !== scope) throw new ApiError(404, 'NOT_FOUND', '找不到设备');
    return row;
  }
  function record(id, user, action, timestamp, changes) {
    const transfer = changes.find(change => change.field === 'company' && change.oldValue !== null && change.oldValue !== change.newValue);
    const company = transfer ? transfer.oldValue : rowFor(id).company;
    db.prepare('INSERT INTO equipment_changes(equipment_id,actor_id,actor_name,action,at,changes,company) VALUES(?,?,?,?,?,?,?)')
      .run(id, user.id, user.name, action, timestamp, JSON.stringify(changes), company || '');
  }
  function checkVersion(previous, version) {
    if (previous.version !== version || previous.version >= Number.MAX_SAFE_INTEGER) throw new ApiError(409, 'VERSION_CONFLICT', '设备已被其他人修改，请刷新后重新编辑');
  }
  function bumpVersion(previous, timestamp, editor) {
    const result = db.prepare('UPDATE equipment SET version=version+1,updated_at=?,editor_id=?,editor_name=? WHERE id=? AND version=?')
      .run(timestamp, editor.id, editor.name, previous.id, previous.version);
    if (!result.changes) throw new ApiError(409, 'VERSION_CONFLICT', '设备已被其他人修改，请刷新后重新编辑');
  }
  function get(id, user) {
    return transaction(() => {
      const equipment = view(scopedRow(id, user));
      const scope = companyScope(user);
      const history = db.prepare(`SELECT actor_name,action,at,changes FROM equipment_changes WHERE equipment_id=? ${scope === null ? '' : 'AND company=?'} ORDER BY id DESC LIMIT 30`)
        .all(equipment.id, ...(scope === null ? [] : [scope])).map(row => ({ actorName: row.actor_name, action: row.action, at: new Date(row.at).toISOString(), changes: JSON.parse(row.changes) }));
      return { equipment, history };
    }, false);
  }
  function stats(user) {
    const company = companyScope(user);
    return transaction(() => {
      const where = company === null ? '' : 'WHERE company=?';
      const parameters = company === null ? [] : [company];
      // Aggregate the whole permitted ledger, without fetching photos or applying
      // the client's list filters. All dimensions share one read snapshot.
      const totals = db.prepare(`SELECT COUNT(*) AS total,
        ${[...statuses].map(status => `COUNT(CASE WHEN status='${status}' THEN 1 END) AS ${status}`).join(',')}
        FROM equipment ${where}`).get(...parameters);
      const grouped = column => db.prepare(`SELECT ${column},COUNT(*) AS count FROM equipment ${where}
        GROUP BY ${column} ORDER BY count DESC,${column} ASC`).all(...parameters)
        .map(row => ({ [column]: row[column], count: row.count }));
      return {
        total: totals.total,
        statuses: Object.fromEntries([...statuses].map(status => [status, totals[status]])),
        companies: grouped('company'), categories: grouped('category'), locations: grouped('location'),
      };
    }, false);
  }
  function create(value, user) {
    const editor = actor(user), data = input(value, false);
    if (user.isSuperAdmin === true) {
      if (!companies.has(data.company)) invalid('请选择设备所属公司');
    } else {
      if (!companies.has(user.company)) throw new ApiError(403, 'COMPANY_REQUIRED', '请联系超级管理员分配公司后新增设备');
      if (own(value, 'company') && data.company !== user.company) throw new ApiError(403, 'FORBIDDEN', '只有超级管理员可以选择其他设备公司');
      data.company = user.company;
    }
    return transaction(() => {
      if (db.prepare('SELECT COUNT(*) AS count FROM equipment').get().count >= 5000) throw new ApiError(409, 'EQUIPMENT_LIMIT', '设备台账已达到 5000 条上限');
      const id = randomUUID(), timestamp = now();
      if ((db.prepare('SELECT MAX(number) AS number FROM equipment_serial_numbers').get().number ?? 0) >= 99999999) throw new ApiError(409, 'SERIAL_EXHAUSTED', '八位设备序列号已用尽');
      const number = db.prepare('INSERT INTO equipment_serial_numbers(equipment_id) VALUES(?)').run(id).lastInsertRowid;
      const serialNumber = String(number).padStart(8, '0');
      const statement = db.prepare(`INSERT INTO equipment(id,code,serial_number,${mutable.map(key => columns[key]).join(',')},version,created_at,updated_at,creator_id,creator_name,editor_id,editor_name)
        VALUES(?,?,?,${mutable.map(() => '?').join(',')},1,?,?,?,?,?,?) ON CONFLICT(code) DO NOTHING`);
      for (let attempt = 0; attempt < 5; attempt++) {
        const code = `RT-${randomUUID().slice(0, 8).toUpperCase()}`;
        const result = statement.run(id, code, serialNumber, ...mutable.map(key => data[key]), timestamp, timestamp, editor.id, editor.name, editor.id, editor.name);
        if (result.changes) {
          record(id, editor, 'created', timestamp, ['code', 'serialNumber', ...mutable].map(field => ({ field, oldValue: null, newValue: field === 'code' ? code : field === 'serialNumber' ? serialNumber : data[field] })));
          return view(rowFor(id));
        }
      }
      throw new ApiError(503, 'CODE_UNAVAILABLE', '暂时无法分配设备编号，请重试');
    });
  }
  function update(id, value, user) {
    const editor = actor(user), data = input(value, true);
    return transaction(() => {
      const previous = view(scopedRow(id, user));
      checkVersion(previous, value.version);
      if (own(data, 'company') && data.company !== previous.company) {
        if (user.isSuperAdmin !== true && (data.company !== user.company || previous.company !== user.company)) throw new ApiError(403, 'FORBIDDEN', '只能选择自己所属的公司');
        if (!companies.has(data.company)) invalid('请选择设备所属公司');
      }
      validClassification({ ...previous, ...data });
      const changes = mutable.filter(field => own(data, field) && data[field] !== previous[field])
        .map(field => ({ field, oldValue: previous[field], newValue: data[field] }));
      if (!changes.length) return previous;
      const next = { ...previous, ...data }, timestamp = now();
      const result = db.prepare(`UPDATE equipment SET ${mutable.map(key => `${columns[key]}=?`).join(',')},version=version+1,updated_at=?,editor_id=?,editor_name=? WHERE id=? AND version=?`)
        .run(...mutable.map(key => next[key]), timestamp, editor.id, editor.name, previous.id, value.version);
      if (!result.changes) throw new ApiError(409, 'VERSION_CONFLICT', '设备已被其他人修改，请刷新后重新编辑');
      record(previous.id, editor, 'updated', timestamp, changes);
      return view(rowFor(previous.id));
    });
  }
  function getPhoto(id, user) {
    return transaction(() => {
      const equipment = view(scopedRow(id, user));
      if (!equipment.photo) return null;
      const photo = db.prepare('SELECT bytes,width,height,updated_at FROM equipment_photos WHERE equipment_id=?').get(equipment.id);
      return { bytes: Buffer.from(photo.bytes), width: photo.width, height: photo.height,
        updatedAt: new Date(photo.updated_at).toISOString(), version: equipment.version, contentType: 'image/jpeg' };
    }, false);
  }
  function setPhoto(id, value, user) {
    const editor = actor(user); photoInput(value, true);
    return transaction(() => {
      const previous = view(scopedRow(id, user)); checkVersion(previous, value.version);
      const timestamp = now();
      db.prepare(`INSERT INTO equipment_photos(equipment_id,bytes,width,height,updated_at) VALUES(?,?,?,?,?)
        ON CONFLICT(equipment_id) DO UPDATE SET bytes=excluded.bytes,width=excluded.width,height=excluded.height,updated_at=excluded.updated_at`)
        .run(previous.id, value.bytes, value.width, value.height, timestamp);
      bumpVersion(previous, timestamp, editor);
      const next = view(rowFor(previous.id));
      record(previous.id, editor, 'updated', timestamp, [{ field: 'photo', oldValue: photoDescription(previous.photo), newValue: photoDescription(next.photo) }]);
      return next;
    });
  }
  function removePhoto(id, value, user) {
    const editor = actor(user); photoInput(value, false);
    return transaction(() => {
      const previous = view(scopedRow(id, user)); checkVersion(previous, value.version);
      if (!previous.photo) return previous;
      const timestamp = now();
      db.prepare('DELETE FROM equipment_photos WHERE equipment_id=?').run(previous.id);
      bumpVersion(previous, timestamp, editor);
      record(previous.id, editor, 'updated', timestamp, [{ field: 'photo', oldValue: photoDescription(previous.photo), newValue: null }]);
      return view(rowFor(previous.id));
    });
  }
  return { list: user => { const company = companyScope(user); return db.prepare(`${equipmentSelect} ${company === null ? '' : 'WHERE e.company=?'} ORDER BY e.updated_at DESC,e.serial_number ASC`).all(...(company === null ? [] : [company])).map(view); },
    stats, get, create, update, getPhoto, setPhoto, removePhoto, close: () => db.close() };
}
