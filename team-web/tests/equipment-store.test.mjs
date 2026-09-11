import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { Worker } from 'node:worker_threads';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createEquipmentStore } from '../server/equipment-store.mjs';
import { createStore } from '../server/store.mjs';
import { backupTeamDatabase } from '../../scripts/team-backup.mjs';

const member = { id: 'real-member-id', name: '登记人', role: 'member', company: 'A公司' };
const other = { id: 'real-editor-id', name: '另一位成员', role: 'member', company: 'B公司' };
const draft = value => ({ category: '台式主机', location: '上海', ...value });
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 2, 0xff, 0xd9]);
const BASE = Date.parse('2026-09-08T04:00:00Z');
function fixture(t, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'racktop-equipment-'));
  const dbPath = join(directory, 'team.sqlite');
  const store = createEquipmentStore({ dbPath, now: () => BASE, ...options });
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { store, dbPath };
}

test('equipment statistics count the full ledger and every status without exposing individual records', t => {
  const { store } = fixture(t);
  assert.deepEqual(store.stats(), { total: 0, statuses: { available: 0, in_use: 0, maintenance: 0, retired: 0 }, companies: [], categories: [], locations: [] });
  const statusValues = ['available', 'in_use', 'maintenance', 'retired'];
  for (let index = 0; index < 1005; index++) {
    store.create(draft({ name: `私有设备 ${index}`, category: index % 2 ? '台式主机' : '机械臂',
      location: index % 2 ? '上海' : '太仓', status: statusValues[index % 4], currentUser: '私有使用人', notes: '私有备注' }), index % 2 ? other : member);
  }
  const stats = store.stats();
  assert.deepEqual(stats, {
    total: 1005, statuses: { available: 252, in_use: 251, maintenance: 251, retired: 251 },
    companies: [{ company: 'A公司', count: 503 }, { company: 'B公司', count: 502 }],
    categories: [{ category: '机械臂', count: 503 }, { category: '台式主机', count: 502 }],
    locations: [{ location: '太仓', count: 503 }, { location: '上海', count: 502 }],
  });
  assert.equal(Object.values(stats.statuses).reduce((sum, count) => sum + count, 0), stats.total);
  for (const groups of [stats.companies, stats.categories, stats.locations]) assert.equal(groups.reduce((sum, group) => sum + group.count, 0), stats.total);
  for (const privateValue of ['私有设备', '私有使用人', '私有备注', member.id, other.id, 'photo', 'serialNumber']) assert.equal(JSON.stringify(stats).includes(privateValue), false);
});

test('statistics enforce company scope, include legacy groups for super administrators, and track transfers', t => {
  const { store, dbPath } = fixture(t, { enforceCompanies: true });
  const superAdmin = { id: 'super-statistics', name: '超级管理员', role: 'admin', isSuperAdmin: true, company: null };
  const first = store.create(draft({ name: 'A 公司设备' }), member);
  store.create(draft({ name: 'B 公司设备', status: 'in_use' }), other);
  const legacy = store.create(draft({ name: '历史未分配设备', company: '西浦', status: 'retired' }), superAdmin);
  const db = new DatabaseSync(dbPath); t.after(() => db.close());
  db.prepare("UPDATE equipment SET company='',category='历史类别',location='旧仓库' WHERE id=?").run(legacy.id);
  assert.throws(() => store.stats(null), { status: 401, code: 'UNAUTHENTICATED' });
  for (const role of ['member', 'admin']) assert.throws(() => store.stats({ ...member, role, company: null }), { status: 403, code: 'COMPANY_REQUIRED' });
  const ownStats = store.stats(member);
  assert.deepEqual(ownStats, { total: 1, statuses: { available: 1, in_use: 0, maintenance: 0, retired: 0 },
    companies: [{ company: 'A公司', count: 1 }], categories: [{ category: '台式主机', count: 1 }], locations: [{ location: '上海', count: 1 }] });
  assert.deepEqual(store.stats({ ...member, role: 'admin' }), ownStats, 'ordinary administrators retain their company scope');
  const all = store.stats(superAdmin);
  assert.equal(all.total, 3); assert.deepEqual(all.statuses, { available: 1, in_use: 1, maintenance: 0, retired: 1 });
  assert.deepEqual(all.companies, [{ company: '', count: 1 }, { company: 'A公司', count: 1 }, { company: 'B公司', count: 1 }]);
  assert.ok(all.categories.some(group => group.category === '历史类别' && group.count === 1));
  assert.ok(all.locations.some(group => group.location === '旧仓库' && group.count === 1));
  store.update(first.id, { version: 1, company: 'B公司', status: 'maintenance' }, superAdmin);
  assert.equal(store.stats(member).total, 0);
  assert.equal(store.stats(other).total, 2);
  assert.deepEqual(store.stats(superAdmin).statuses, { available: 0, in_use: 1, maintenance: 1, retired: 1 });
});

test('equipment starts empty, persists in the booking database, and projects only public business fields', t => {
  const { store, dbPath } = fixture(t);
  assert.deepEqual(store.list(), []);
  const bookingStore = createStore({ dbPath }); t.after(() => bookingStore.close());
  assert.deepEqual(bookingStore.listResources(), []);
  const created = store.create(draft({ name: '  A100 工作站  ', responsiblePerson: '小林', location: '太仓', notes: '<b>原样文本</b>' }), member);
  assert.match(created.id, /^[0-9a-f-]{36}$/); assert.match(created.code, /^RT-[0-9A-F]{8}$/);
  assert.equal(created.name, 'A100 工作站'); assert.equal(created.status, 'available'); assert.equal(created.model, '');
  assert.equal(created.serialNumber, '00000001'); assert.equal(created.legacySerialNumber, '');
  assert.equal(created.company, 'A公司'); assert.equal(created.currentUser, ''); assert.equal(created.photo, null);
  assert.equal(created.version, 1); assert.equal(created.createdAt, new Date(BASE).toISOString());
  const reopened = createEquipmentStore({ dbPath }); t.after(() => reopened.close());
  assert.deepEqual(reopened.list(), [created]);
  const detail = reopened.get(created.id);
  assert.deepEqual(detail.equipment, created); assert.equal(detail.history[0].actorName, member.name);
  assert.equal(detail.history[0].action, 'created');
  assert.ok(detail.history[0].changes.some(change => change.field === 'notes' && change.newValue === '<b>原样文本</b>'));
  const serialized = JSON.stringify(detail);
  for (const privateField of ['creator_id', 'editor_id', 'actor_id', member.id]) assert.equal(serialized.includes(privateField), false);
  const db = new DatabaseSync(dbPath); t.after(() => db.close());
  assert.equal(db.prepare('SELECT creator_id FROM equipment').get().creator_id, member.id);
  assert.equal(db.prepare('SELECT actor_id FROM equipment_changes').get().actor_id, member.id);
});

test('members can edit and retire the same stable equipment ID with exact version protection', t => {
  const { store, dbPath } = fixture(t);
  const original = store.create(draft({ name: '服务器' }), member);
  const updated = store.update(original.id, { version: 1, name: '新名字', status: 'retired', location: '太仓' }, other);
  assert.equal(updated.id, original.id); assert.equal(updated.code, original.code); assert.equal(updated.version, 2);
  assert.throws(() => store.update(original.id, { version: 1, notes: '旧页面的修改' }, member), { status: 409, code: 'VERSION_CONFLICT' });
  assert.deepEqual(store.update(original.id, { version: 2, name: '新名字' }, member), updated);
  const detail = store.get(original.id);
  assert.equal(detail.history.length, 2); assert.equal(detail.history[0].actorName, other.name);
  assert.deepEqual(detail.history[0].changes, [
    { field: 'name', oldValue: '服务器', newValue: '新名字' },
    { field: 'location', oldValue: '上海', newValue: '太仓' },
    { field: 'status', oldValue: 'available', newValue: 'retired' },
  ]);
  const db = new DatabaseSync(dbPath); t.after(() => db.close());
  assert.equal(db.prepare('SELECT creator_id,editor_id FROM equipment').get().creator_id, member.id);
  assert.equal(db.prepare('SELECT editor_id FROM equipment').get().editor_id, other.id);
});

test('the existing live SQLite backup captures equipment and its committed change history', async t => {
  const { store, dbPath } = fixture(t);
  const equipment = store.create(draft({ name: '在线设备' }), member);
  store.update(equipment.id, { version: 1, status: 'maintenance', notes: '已送修' }, other);
  const target = `${dbPath}.backup`;
  await backupTeamDatabase(dbPath, target);
  const restored = new DatabaseSync(target, { readOnly: true });
  try {
    const record = restored.prepare('SELECT * FROM equipment WHERE id=?').get(equipment.id);
    assert.equal(record.code, equipment.code); assert.equal(record.status, 'maintenance');
    assert.equal(record.notes, '已送修'); assert.equal(record.version, 2);
    assert.equal(restored.prepare('SELECT COUNT(*) AS count FROM equipment_changes').get().count, 2);
    assert.equal(restored.prepare('SELECT actor_id FROM equipment_changes ORDER BY id DESC LIMIT 1').get().actor_id, other.id);
  } finally { restored.close(); }
});

test('equipment rejects untrusted fields, invalid capacities/status/IDs, missing versions and anonymous writes', t => {
  const { store } = fixture(t);
  for (const value of [{}, { name: ' \t' }, { name: 42 }, { name: 'x'.repeat(121) }, { name: 'x', notes: 'x'.repeat(4001) }, { name: 'x', status: 'deleted' }, { name: 'x', location: null }, { name: 'x', serialNumber: '\0' }, { name: 'x', code: 'RT-OWN' }, { name: 'x', id: randomUUID() }, { name: 'x', creatorId: member.id }, JSON.parse('{"name":"x","__proto__":{}}')]) {
    assert.throws(() => store.create(draft(value), member), { code: 'INVALID_INPUT' });
  }
  assert.throws(() => store.create(draft({ name: 'x' }), null), { status: 401 });
  const created = store.create(draft({ name: 'x' }), member);
  for (const value of [{ name: 'new' }, { version: '1', name: 'new' }, { version: 0, name: 'new' }, { version: 1 }, { version: 1, code: created.code }]) assert.throws(() => store.update(created.id, value, other), { code: 'INVALID_INPUT' });
  assert.throws(() => store.update(created.id, { version: 1, name: 'new' }, null), { status: 401 });
  assert.throws(() => store.get('../unsafe'), { status: 422 });
  assert.throws(() => store.get(randomUUID()), { status: 404 });
  assert.equal(store.get(created.id).history.length, 1);
});

test('equipment and history roll back together when audit insertion fails', t => {
  const { store, dbPath } = fixture(t);
  const created = store.create(draft({ name: '原设备' }), member);
  const db = new DatabaseSync(dbPath); t.after(() => db.close());
  db.exec("CREATE TRIGGER equipment_history_failure BEFORE INSERT ON equipment_changes BEGIN SELECT RAISE(ABORT, 'simulated audit failure'); END");
  assert.throws(() => store.update(created.id, { version: 1, name: '不应保存' }, other));
  assert.throws(() => store.create(draft({ name: '不应创建' }), other));
  assert.deepEqual(store.list(), [created]); assert.equal(store.get(created.id).history.length, 1);
});

test('public equipment history is limited to the newest 30 changes even with identical timestamps', t => {
  const { store } = fixture(t);
  const created = store.create(draft({ name: '设备' }), member);
  for (let index = 1; index <= 35; index++) store.update(created.id, { version: index, notes: `记录 ${index}` }, other);
  const detail = store.get(created.id);
  assert.equal(detail.history.length, 30); assert.equal(detail.equipment.version, 36);
  assert.equal(detail.history[0].changes[0].newValue, '记录 35');
  assert.equal(detail.history[29].changes[0].newValue, '记录 6');
});

test('simultaneous independent SQLite writers accept only one version and one audit record', { timeout: 15000 }, async t => {
  const { store, dbPath } = fixture(t);
  const created = store.create(draft({ name: '共享设备' }), member);
  const gate = new SharedArrayBuffer(4);
  const workerSource = `const { parentPort,workerData }=require('node:worker_threads');
    (async()=>{const {createEquipmentStore}=await import(workerData.module);const store=createEquipmentStore({dbPath:workerData.dbPath});
      parentPort.postMessage({ready:true});Atomics.wait(new Int32Array(workerData.gate),0,0);
      try{const equipment=store.update(workerData.id,{version:1,notes:workerData.name},{id:workerData.name,name:workerData.name,role:'member'});parentPort.postMessage({version:equipment.version});}
      catch(error){parentPort.postMessage({code:error.code,status:error.status});}finally{store.close();}})();`;
  const workers = ['甲', '乙'].map(name => new Worker(workerSource, { eval: true, workerData: { module: new URL('../server/equipment-store.mjs', import.meta.url).href, dbPath, id: created.id, gate, name } }));
  t.after(async () => { await Promise.all(workers.map(worker => worker.terminate())); });
  await Promise.all(workers.map(worker => once(worker, 'message')));
  const results = workers.map(worker => once(worker, 'message'));
  Atomics.store(new Int32Array(gate), 0, 1); Atomics.notify(new Int32Array(gate), 0);
  const replies = (await Promise.all(results)).map(([reply]) => reply);
  assert.equal(replies.filter(reply => reply.version === 2).length, 1);
  assert.equal(replies.filter(reply => reply.code === 'VERSION_CONFLICT' && reply.status === 409).length, 1);
  assert.equal(store.get(created.id).history.length, 2);
});

test('classification is required, immutable fields cannot be forged, and returning equipment clears only its current user', t => {
  const { store, dbPath } = fixture(t);
  for (const value of [{ name: 'x' }, draft({ name: 'x', category: '' }), draft({ name: 'x', location: '' }),
    draft({ name: 'x', category: '服务器' }), draft({ name: 'x', location: '北京' }),
    ...['serialNumber', 'legacySerialNumber', 'photo'].map(field => draft({ name: 'x', [field]: '伪造' }))]) {
    assert.throws(() => store.create(value, member), { code: 'INVALID_INPUT' });
  }
  const created = store.create(draft({ name: '机械臂', category: '机械臂', responsiblePerson: '负责人', currentUser: ' 借用人 ' }), member);
  assert.equal(created.currentUser, '借用人');
  for (const field of ['serialNumber', 'legacySerialNumber', 'photo']) {
    assert.throws(() => store.update(created.id, { version: 1, [field]: '伪造' }, member), { code: 'INVALID_INPUT' });
  }
  const returned = store.update(created.id, { version: 1, currentUser: '', status: 'available' }, other);
  assert.equal(returned.currentUser, ''); assert.equal(returned.responsiblePerson, '负责人');
  assert.equal(returned.serialNumber, created.serialNumber);
  assert.deepEqual(store.get(created.id).history[0].changes, [{ field: 'currentUser', oldValue: '借用人', newValue: '' }]);
  const db = new DatabaseSync(dbPath); t.after(() => db.close());
  assert.throws(() => db.prepare('UPDATE equipment SET serial_number=? WHERE id=?').run('00000099', created.id), /immutable/);
  assert.throws(() => db.exec('DELETE FROM equipment_serial_numbers'), /permanent/);
  assert.throws(() => db.exec('UPDATE equipment_serial_numbers SET number=99'), /immutable/);
});

test('legacy rows migrate in creation order once, retaining old free serials, IDs, codes, history and invalid classifications', t => {
  const directory = mkdtempSync(join(tmpdir(), 'racktop-equipment-migration-'));
  let store;
  t.after(() => { store?.close(); rmSync(directory, { recursive: true, force: true }); });
  const dbPath = join(directory, 'legacy.sqlite');
  const db = new DatabaseSync(dbPath);
  db.exec(`CREATE TABLE equipment (
    id TEXT PRIMARY KEY,code TEXT NOT NULL UNIQUE,name TEXT NOT NULL,category TEXT NOT NULL,model TEXT NOT NULL,
    serial_number TEXT NOT NULL,responsible_person TEXT NOT NULL,location TEXT NOT NULL,notes TEXT NOT NULL,
    status TEXT NOT NULL,version INTEGER NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,
    creator_id TEXT NOT NULL,creator_name TEXT NOT NULL,editor_id TEXT NOT NULL,editor_name TEXT NOT NULL);
    CREATE TABLE equipment_changes(id INTEGER PRIMARY KEY AUTOINCREMENT,equipment_id TEXT NOT NULL,
    actor_id TEXT NOT NULL,actor_name TEXT NOT NULL,action TEXT NOT NULL,at INTEGER NOT NULL,changes TEXT NOT NULL);`);
  const ids = [randomUUID(), randomUUID(), randomUUID()];
  const serials = ['旧厂商/编号 A', '00000001', ''];
  const dates = [BASE + 10, BASE, BASE];
  for (let index = 0; index < ids.length; index++) {
    db.prepare('INSERT INTO equipment VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(ids[index], `OLD-${index}`, `旧设备${index}`, '旧类别', '', serials[index], '负责人', '301 室', '原备注', 'available', 3, dates[index], dates[index], member.id, member.name, member.id, member.name);
  }
  db.prepare('INSERT INTO equipment_changes(equipment_id,actor_id,actor_name,action,at,changes) VALUES(?,?,?,?,?,?)')
    .run(ids[0], member.id, member.name, 'updated', BASE, JSON.stringify([{ field: 'notes', oldValue: '', newValue: '原备注' }]));
  db.exec("CREATE TRIGGER migration_failure BEFORE UPDATE ON equipment BEGIN SELECT RAISE(ABORT,'simulated migration failure'); END");
  db.close();
  assert.throws(() => createEquipmentStore({ dbPath }), /simulated migration failure/);
  const afterFailure = new DatabaseSync(dbPath);
  assert.equal(afterFailure.prepare('SELECT serial_number FROM equipment WHERE id=?').get(ids[0]).serial_number, serials[0]);
  assert.equal(afterFailure.prepare('PRAGMA table_info(equipment)').all().some(column => column.name === 'legacy_serial_number'), false);
  afterFailure.exec('DROP TRIGGER migration_failure'); afterFailure.close();
  store = createEquipmentStore({ dbPath, now: () => BASE + 100 });
  const expected = ['00000003', '00000001', '00000002'];
  for (let index = 0; index < ids.length; index++) {
    const equipment = store.get(ids[index]).equipment;
    assert.equal(equipment.id, ids[index]); assert.equal(equipment.code, `OLD-${index}`);
    assert.equal(equipment.serialNumber, expected[index]); assert.equal(equipment.legacySerialNumber, serials[index]);
    assert.equal(equipment.company, ''); assert.equal(equipment.category, '旧类别'); assert.equal(equipment.location, '301 室');
    assert.equal(equipment.notes, '原备注'); assert.equal(equipment.version, 3);
  }
  assert.equal(store.get(ids[0]).history[0].changes[0].newValue, '原备注');
  assert.throws(() => store.update(ids[0], { version: 3, notes: '未改类别' }, member), { status: 422 });
  const photographed = store.setPhoto(ids[0], { version: 3, bytes: jpeg, width: 1, height: 1 }, member);
  assert.equal(photographed.category, '旧类别'); assert.equal(photographed.version, 4);
  const corrected = store.update(ids[0], { version: 4, category: '实验物料', location: '太仓' }, member);
  assert.equal(corrected.company, ''); assert.equal(corrected.legacySerialNumber, serials[0]); assert.equal(corrected.version, 5);
  const before = store.list(); store.close(); store = createEquipmentStore({ dbPath });
  assert.deepEqual(store.list(), before);
  assert.equal(store.create(draft({ name: '迁移后新设备' }), member).serialNumber, '00000004');
});

test('serial allocations survive restart and deletion without reusing or moving backwards', t => {
  const { store, dbPath } = fixture(t);
  const first = store.create(draft({ name: '设备一' }), member);
  const second = store.create(draft({ name: '设备二' }), member);
  assert.equal(first.serialNumber, '00000001'); assert.equal(second.serialNumber, '00000002');
  const db = new DatabaseSync(dbPath); t.after(() => db.close());
  // No delete API exists; the permanent allocation also prevents reuse after an
  // administrator removes a row directly while repairing the database.
  db.prepare('DELETE FROM equipment_changes WHERE equipment_id=?').run(second.id);
  db.prepare('DELETE FROM equipment WHERE id=?').run(second.id);
  const reopened = createEquipmentStore({ dbPath }); t.after(() => reopened.close());
  const third = reopened.create(draft({ name: '设备三' }), member);
  assert.equal(third.serialNumber, '00000003');
  assert.equal(store.get(first.id).equipment.serialNumber, '00000001');
});

test('simultaneous independent creators receive different monotonic eight-digit serial numbers', { timeout: 15000 }, async t => {
  const { store, dbPath } = fixture(t);
  const gate = new SharedArrayBuffer(4);
  const workerSource = `const {parentPort,workerData}=require('node:worker_threads');
    (async()=>{const {createEquipmentStore}=await import(workerData.module);const store=createEquipmentStore({dbPath:workerData.dbPath});
      parentPort.postMessage({ready:true});Atomics.wait(new Int32Array(workerData.gate),0,0);
      try { const serials=[];for(let i=0;i<5;i++)serials.push(store.create({name:'并发'+i,category:'显示屏',location:'上海'},workerData.user).serialNumber);parentPort.postMessage({serials}); }
      catch(error){parentPort.postMessage({code:error.code,message:error.message});}finally{store.close();}})();`;
  const workers = [member, other].map(user => new Worker(workerSource, { eval: true, workerData: {
    module: new URL('../server/equipment-store.mjs', import.meta.url).href, dbPath, gate, user } }));
  t.after(async () => { await Promise.all(workers.map(worker => worker.terminate())); });
  await Promise.all(workers.map(worker => once(worker, 'message')));
  const results = workers.map(worker => once(worker, 'message'));
  Atomics.store(new Int32Array(gate), 0, 1); Atomics.notify(new Int32Array(gate), 0);
  const replies = (await Promise.all(results)).map(([reply]) => reply);
  assert.ok(replies.every(reply => Array.isArray(reply.serials)), JSON.stringify(replies));
  const numbers = replies.flatMap(reply => reply.serials).sort();
  assert.deepEqual(numbers, Array.from({ length: 10 }, (_, index) => String(index + 1).padStart(8, '0')));
  assert.equal(store.list().length, 10);
});

test('photo persistence exposes only metadata and shares device versions and member audit records', t => {
  const { store, dbPath } = fixture(t);
  const created = store.create(draft({ name: '带照片设备' }), member);
  assert.equal(store.getPhoto(created.id), null);
  const photographed = store.setPhoto(created.id, { version: 1, bytes: jpeg, width: 1, height: 1 }, other);
  assert.equal(photographed.version, 2);
  assert.deepEqual(photographed.photo, { url: `/api/equipment/${created.id}/photo?v=2`, width: 1, height: 1, bytes: jpeg.length, updatedAt: new Date(BASE).toISOString() });
  assert.equal(store.get(created.id).history[0].actorName, other.name);
  assert.equal(store.get(created.id).history[0].changes[0].field, 'photo');
  const raw = store.getPhoto(created.id);
  assert.deepEqual(raw.bytes, jpeg); assert.equal(raw.version, 2); assert.equal(raw.contentType, 'image/jpeg');
  raw.bytes[0] = 0; assert.deepEqual(store.getPhoto(created.id).bytes, jpeg);
  const reopened = createEquipmentStore({ dbPath }); t.after(() => reopened.close());
  assert.deepEqual(reopened.get(created.id).equipment, photographed);
  assert.deepEqual(reopened.getPhoto(created.id).bytes, jpeg);
  for (const publicValue of [store.list(), store.get(created.id)]) {
    assert.equal(JSON.stringify(publicValue).includes('"type":"Buffer"'), false);
    assert.equal(JSON.stringify(publicValue).includes(jpeg.toString('base64')), false);
  }
  assert.throws(() => store.update(created.id, { version: 1, name: '旧页面' }, member), { code: 'VERSION_CONFLICT' });
  assert.throws(() => store.removePhoto(created.id, { version: 1 }, member), { code: 'VERSION_CONFLICT' });
  const removed = store.removePhoto(created.id, { version: 2 }, member);
  assert.equal(removed.version, 3); assert.equal(removed.photo, null); assert.equal(store.getPhoto(created.id), null);
  assert.deepEqual(store.removePhoto(created.id, { version: 3 }, member), removed);
  assert.equal(store.get(created.id).history.length, 3);
});

test('photo replacement and removal roll back atomically on audit failure, stale versions or invalid inputs', t => {
  const { store, dbPath } = fixture(t);
  const created = store.create(draft({ name: '照片事务设备' }), member);
  const original = store.setPhoto(created.id, { version: 1, bytes: jpeg, width: 1, height: 1 }, member);
  const replacement = Buffer.from([...jpeg.subarray(0, -2), 7, 8, 0xff, 0xd9]);
  for (const value of [{ version: 1, bytes: replacement, width: 1, height: 1 },
    { version: 2, bytes: Buffer.from('not JPEG'), width: 1, height: 1 },
    { version: 2, bytes: jpeg, width: 1601, height: 1 }, { version: 2, bytes: jpeg, width: 1, height: 0 },
    { version: 2, bytes: jpeg, width: 1.5, height: 1 }, { version: 2, bytes: new Uint8Array(jpeg), width: 1, height: 1 },
    { version: 2, bytes: Buffer.alloc(512 * 1024 + 1), width: 1, height: 1 },
    { version: 2, bytes: jpeg, width: 1, height: 1, url: '/forged' }]) {
    assert.throws(() => store.setPhoto(created.id, value, other));
  }
  assert.throws(() => store.setPhoto(created.id, { version: 2, bytes: jpeg, width: 1, height: 1 }, null), { status: 401 });
  assert.throws(() => store.removePhoto(created.id, { version: 2 }, null), { status: 401 });
  assert.throws(() => store.removePhoto(created.id, { version: '2' }, other), { status: 422 });
  assert.throws(() => store.getPhoto(randomUUID()), { status: 404 });
  const db = new DatabaseSync(dbPath); t.after(() => db.close());
  db.exec("CREATE TRIGGER equipment_photo_audit_failure BEFORE INSERT ON equipment_changes BEGIN SELECT RAISE(ABORT,'simulated audit failure'); END");
  assert.throws(() => store.setPhoto(created.id, { version: 2, bytes: replacement, width: 2, height: 1 }, other));
  assert.throws(() => store.removePhoto(created.id, { version: 2 }, other));
  assert.deepEqual(store.get(created.id).equipment, original); assert.deepEqual(store.getPhoto(created.id).bytes, jpeg);
  assert.equal(store.get(created.id).history.length, 2);
  db.exec('DROP TRIGGER equipment_photo_audit_failure');
  const updated = store.setPhoto(created.id, { version: 2, bytes: replacement, width: 2, height: 1 }, other);
  assert.equal(updated.version, 3); assert.deepEqual(store.getPhoto(created.id).bytes, replacement);
  assert.throws(() => db.prepare('UPDATE equipment_photos SET bytes=?').run(Buffer.alloc(524289)), /CHECK constraint/);
});

test('live backup includes JPEG bytes, photo metadata, serial allocation and its matching device history', async t => {
  const { store, dbPath } = fixture(t);
  const created = store.create(draft({ name: '照片备份设备' }), member);
  const photographed = store.setPhoto(created.id, { version: 1, bytes: jpeg, width: 1, height: 1 }, other);
  const target = `${dbPath}.photo-backup`;
  await backupTeamDatabase(dbPath, target);
  const restored = createEquipmentStore({ dbPath: target }); t.after(() => restored.close());
  assert.deepEqual(restored.get(created.id), store.get(created.id));
  assert.deepEqual(restored.getPhoto(created.id).bytes, jpeg);
  assert.deepEqual(restored.list(), [photographed]);
  assert.equal(restored.create(draft({ name: '恢复后新增' }), member).serialNumber, '00000002');
});

test('a concurrent image replacement and ordinary edit share one device CAS and cannot overwrite each other', { timeout: 15000 }, async t => {
  const { store, dbPath } = fixture(t);
  const created = store.create(draft({ name: '照片并发设备' }), member);
  const gate = new SharedArrayBuffer(4);
  const workerSource = `const {parentPort,workerData}=require('node:worker_threads');
    (async()=>{const {createEquipmentStore}=await import(workerData.module);const store=createEquipmentStore({dbPath:workerData.dbPath});
      parentPort.postMessage({ready:true});Atomics.wait(new Int32Array(workerData.gate),0,0);
      try{const equipment=workerData.photo?store.setPhoto(workerData.id,{version:1,bytes:Buffer.from(workerData.bytes),width:1,height:1},workerData.user):store.update(workerData.id,{version:1,currentUser:'正在使用'},workerData.user);parentPort.postMessage({version:equipment.version,photo:workerData.photo});}
      catch(error){parentPort.postMessage({code:error.code,status:error.status});}finally{store.close();}})();`;
  const workers = [false, true].map(photo => new Worker(workerSource, { eval: true, workerData: {
    module: new URL('../server/equipment-store.mjs', import.meta.url).href, dbPath, id: created.id, gate, photo, bytes: jpeg, user: member } }));
  t.after(async () => { await Promise.all(workers.map(worker => worker.terminate())); });
  await Promise.all(workers.map(worker => once(worker, 'message')));
  const results = workers.map(worker => once(worker, 'message'));
  Atomics.store(new Int32Array(gate), 0, 1); Atomics.notify(new Int32Array(gate), 0);
  const replies = (await Promise.all(results)).map(([reply]) => reply);
  assert.equal(replies.filter(reply => reply.version === 2).length, 1);
  assert.equal(replies.filter(reply => reply.code === 'VERSION_CONFLICT' && reply.status === 409).length, 1);
  const detail = store.get(created.id);
  assert.equal(detail.history.length, 2);
  if (replies.find(reply => reply.version === 2).photo) {
    assert.equal(detail.equipment.currentUser, ''); assert.deepEqual(store.getPhoto(created.id).bytes, jpeg);
  } else {
    assert.equal(detail.equipment.currentUser, '正在使用'); assert.equal(store.getPhoto(created.id), null);
  }
});


test('equipment company is assigned from the member and only super administrators can choose or change it', t => {
  const { store } = fixture(t);
  const superAdmin = { id: 'super', name: '超级管理员', role: 'admin', isSuperAdmin: true, company: null };
  const ordinaryAdmin = { ...member, role: 'admin' };
  const created = store.create(draft({ name: '所属公司设备' }), member);
  assert.equal(created.company, member.company);
  assert.throws(() => store.create(draft({ name: '伪造公司', company: 'B公司' }), member), { status: 403 });
  assert.throws(() => store.create(draft({ name: '未分配成员' }), { ...member, company: null }), { status: 403, code: 'COMPANY_REQUIRED' });
  assert.throws(() => store.create(draft({ name: '角色不能提升权限', company: 'C公司' }), ordinaryAdmin), { status: 403 });
  assert.throws(() => store.create(draft({ name: '缺少公司' }), superAdmin), { status: 422 });
  assert.throws(() => store.create(draft({ name: '无效公司', company: '任意公司' }), superAdmin), { status: 422 });
  assert.equal(store.create(draft({ name: '超管设备', company: '西浦' }), superAdmin).company, '西浦');
  for (const user of [member, other, ordinaryAdmin]) assert.throws(() => store.update(created.id, { version: 1, company: 'B公司' }, user), { status: 403 });
  assert.deepEqual(store.update(created.id, { version: 1, company: 'A公司' }, member), created);
  assert.throws(() => store.update(created.id, { version: 1, company: '' }, superAdmin), { status: 422 });
  const moved = store.update(created.id, { version: 1, company: 'C公司' }, superAdmin);
  assert.equal(moved.company, 'C公司'); assert.equal(moved.version, 2);
  assert.equal(moved.id, created.id); assert.equal(moved.serialNumber, created.serialNumber); assert.equal(moved.code, created.code);
  assert.deepEqual(store.get(created.id).history[0].changes, [{ field: 'company', oldValue: 'A公司', newValue: 'C公司' }]);
  assert.throws(() => store.update(created.id, { version: 1, company: 'B公司' }, superAdmin), { status: 409, code: 'VERSION_CONFLICT' });
  const edited = store.update(created.id, { version: 2, currentUser: '使用人', location: '太仓' }, member);
  assert.equal(edited.company, 'C公司'); assert.equal(edited.version, 3);
});

test('company migration preserves old assigned numbers and empty companies until a super administrator assigns one', t => {
  const { store, dbPath } = fixture(t);
  const created = store.create(draft({ name: '上一版设备', currentUser: '使用人', responsiblePerson: '责任人' }), member);
  const db = new DatabaseSync(dbPath); t.after(() => db.close());
  db.exec('ALTER TABLE equipment DROP COLUMN company');
  const reopened = createEquipmentStore({ dbPath }); t.after(() => reopened.close());
  const legacy = reopened.get(created.id).equipment;
  assert.deepEqual(legacy, { ...created, company: '' });
  const returned = reopened.update(created.id, { version: 1, currentUser: '' }, member);
  assert.equal(returned.company, ''); assert.equal(returned.responsiblePerson, '责任人');
  const photo = reopened.setPhoto(created.id, { version: 2, bytes: jpeg, width: 1, height: 1 }, member);
  assert.equal(photo.company, '');
  const superAdmin = { ...member, role: 'admin', isSuperAdmin: true };
  const assigned = reopened.update(created.id, { version: 3, company: 'B公司' }, superAdmin);
  assert.equal(assigned.company, 'B公司'); assert.deepEqual(assigned.photo, { ...photo.photo, url: `/api/equipment/${created.id}/photo?v=4` });
  assert.throws(() => reopened.setPhoto(created.id, { version: 3, bytes: jpeg, width: 1, height: 1 }, member), { status: 409 });
  db.exec("CREATE TRIGGER company_history_failure BEFORE INSERT ON equipment_changes BEGIN SELECT RAISE(ABORT, 'simulated audit failure'); END");
  assert.throws(() => reopened.update(created.id, { version: 4, company: 'C公司' }, superAdmin));
  assert.deepEqual(reopened.get(created.id).equipment, assigned);
});
