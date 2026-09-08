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

const member = { id: 'real-member-id', name: '登记人', role: 'member' };
const other = { id: 'real-editor-id', name: '另一位成员', role: 'member' };
const BASE = Date.parse('2026-09-08T04:00:00Z');
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'racktop-equipment-'));
  const dbPath = join(directory, 'team.sqlite');
  const store = createEquipmentStore({ dbPath, now: () => BASE });
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { store, dbPath };
}

test('equipment starts empty, persists in the booking database, and projects only public business fields', t => {
  const { store, dbPath } = fixture(t);
  assert.deepEqual(store.list(), []);
  const bookingStore = createStore({ dbPath }); t.after(() => bookingStore.close());
  assert.deepEqual(bookingStore.listResources(), []);
  const created = store.create({ name: '  A100 工作站  ', responsiblePerson: '小林', location: '301 室', notes: '<b>原样文本</b>' }, member);
  assert.match(created.id, /^[0-9a-f-]{36}$/); assert.match(created.code, /^RT-[0-9A-F]{8}$/);
  assert.equal(created.name, 'A100 工作站'); assert.equal(created.status, 'available'); assert.equal(created.model, '');
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
  const original = store.create({ name: '服务器' }, member);
  const updated = store.update(original.id, { version: 1, name: '新名字', status: 'retired', location: '仓库' }, other);
  assert.equal(updated.id, original.id); assert.equal(updated.code, original.code); assert.equal(updated.version, 2);
  assert.throws(() => store.update(original.id, { version: 1, notes: '旧页面的修改' }, member), { status: 409, code: 'VERSION_CONFLICT' });
  assert.deepEqual(store.update(original.id, { version: 2, name: '新名字' }, member), updated);
  const detail = store.get(original.id);
  assert.equal(detail.history.length, 2); assert.equal(detail.history[0].actorName, other.name);
  assert.deepEqual(detail.history[0].changes, [
    { field: 'name', oldValue: '服务器', newValue: '新名字' },
    { field: 'location', oldValue: '', newValue: '仓库' },
    { field: 'status', oldValue: 'available', newValue: 'retired' },
  ]);
  const db = new DatabaseSync(dbPath); t.after(() => db.close());
  assert.equal(db.prepare('SELECT creator_id,editor_id FROM equipment').get().creator_id, member.id);
  assert.equal(db.prepare('SELECT editor_id FROM equipment').get().editor_id, other.id);
});

test('the existing live SQLite backup captures equipment and its committed change history', async t => {
  const { store, dbPath } = fixture(t);
  const equipment = store.create({ name: '在线设备' }, member);
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
    assert.throws(() => store.create(value, member), { code: 'INVALID_INPUT' });
  }
  assert.throws(() => store.create({ name: 'x' }, null), { status: 401 });
  const created = store.create({ name: 'x' }, member);
  for (const value of [{ name: 'new' }, { version: '1', name: 'new' }, { version: 0, name: 'new' }, { version: 1 }, { version: 1, code: created.code }]) assert.throws(() => store.update(created.id, value, other), { code: 'INVALID_INPUT' });
  assert.throws(() => store.update(created.id, { version: 1, name: 'new' }, null), { status: 401 });
  assert.throws(() => store.get('../unsafe'), { status: 422 });
  assert.throws(() => store.get(randomUUID()), { status: 404 });
  assert.equal(store.get(created.id).history.length, 1);
});

test('equipment and history roll back together when audit insertion fails', t => {
  const { store, dbPath } = fixture(t);
  const created = store.create({ name: '原设备' }, member);
  const db = new DatabaseSync(dbPath); t.after(() => db.close());
  db.exec("CREATE TRIGGER equipment_history_failure BEFORE INSERT ON equipment_changes BEGIN SELECT RAISE(ABORT, 'simulated audit failure'); END");
  assert.throws(() => store.update(created.id, { version: 1, name: '不应保存' }, other));
  assert.throws(() => store.create({ name: '不应创建' }, other));
  assert.deepEqual(store.list(), [created]); assert.equal(store.get(created.id).history.length, 1);
});

test('public equipment history is limited to the newest 30 changes even with identical timestamps', t => {
  const { store } = fixture(t);
  const created = store.create({ name: '设备' }, member);
  for (let index = 1; index <= 35; index++) store.update(created.id, { version: index, notes: `记录 ${index}` }, other);
  const detail = store.get(created.id);
  assert.equal(detail.history.length, 30); assert.equal(detail.equipment.version, 36);
  assert.equal(detail.history[0].changes[0].newValue, '记录 35');
  assert.equal(detail.history[29].changes[0].newValue, '记录 6');
});

test('simultaneous independent SQLite writers accept only one version and one audit record', { timeout: 15000 }, async t => {
  const { store, dbPath } = fixture(t);
  const created = store.create({ name: '共享设备' }, member);
  const gate = new SharedArrayBuffer(4);
  const workerSource = `const { parentPort,workerData }=require('node:worker_threads');
    (async()=>{const {createEquipmentStore}=await import(workerData.module);const store=createEquipmentStore({dbPath:workerData.dbPath});
      parentPort.postMessage({ready:true});Atomics.wait(new Int32Array(workerData.gate),0,0);
      try{const equipment=store.update(workerData.id,{version:1,location:workerData.name},{id:workerData.name,name:workerData.name,role:'member'});parentPort.postMessage({version:equipment.version});}
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
