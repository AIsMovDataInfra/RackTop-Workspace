import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createStore } from '../server/store.mjs';

const base = Date.parse('2026-09-12T12:00:00Z');
const admin = { id: 'admin-a', name: '管理员', role: 'admin', company: 'A公司' };
const superAdmin = { id: 'root-admin', name: '超管', role: 'admin', isSuperAdmin: true, company: null };
const member = { id: 'reader-a', name: '成员', role: 'member', company: 'A公司' };
const server = (extra = {}) => ({ id: 'managed-one', name: '受管计算节点', company: 'A公司', version: 1, enabled: true, ...extra });
const gpu = (number = 1, extra = {}) => ({ uuid: `GPU-00000000-0000-4000-8000-${String(number).padStart(12, '0')}`, index: number - 1, name: 'NVIDIA Test', memoryTotalMb: 81920, utilization: 0, memoryUsedMb: 0, users: [], hasProcesses: false, ...extra });
const report = (extra = {}) => ({ serverVersion: 1, observedAt: base, status: 'online', inventoryComplete: true, processQueryOk: true, gpuUsageValid: true, gpus: [gpu()], ...extra });
const hardware = values => values.map(({ uuid, index, name, memoryTotalMb }) => ({ uuid, index, name, memoryTotalMb }));
const fail = (fn, code) => assert.throws(fn, error => error.code === code);
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'racktop-telemetry-store-')), path = join(dir, 'team.sqlite');
  let clock = base;
  const store = createStore({ dbPath: path, now: () => clock, enforceCompanies: true });
  const db = new DatabaseSync(path);
  t.after(() => { db.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  const sync = (data = report(), managed = server(), user = admin) => store.syncManagedTelemetry(data, user, managed);
  return { store, db, sync, setClock: value => { clock = value; } };
}
function booking(resource) {
  return { resourceId: resource.id, scope: 'gpus', gpuIds: [resource.gpus[0].id], inventoryVersion: resource.inventoryVersion,
    startAt: new Date(base + 60_000).toISOString(), endAt: new Date(base + 3_600_000).toISOString(), purpose: '合成训练' };
}

test('first failed or stale observation does not invent a CPU node or resource', t => {
  const { sync, store } = fixture(t);
  assert.equal(sync(report({ status: 'unknown', inventoryComplete: false, processQueryOk: false, gpuUsageValid: false, gpus: [] })), null);
  assert.equal(sync(report({ observedAt: base - 90_001 })), null);
  fail(() => sync(report({ gpus: [] })), 'INVALID_INPUT');
  fail(() => sync(report({ gpus: [gpu(1, { uuid: 'NPU-0' })] })), 'GPU_IDENTITY_UNAVAILABLE');
  assert.deepEqual(store.listResources(admin), []);
});

test('complete telemetry creates stable GPU inventory and returns only minimal current usage', t => {
  const { sync, store, db } = fixture(t);
  const resource = sync(report({ gpus: [gpu(1, { users: ['unknown'], hasProcesses: true })] }));
  assert.equal(resource.cluster, 'GPU集群'); assert.equal(resource.company, 'A公司');
  assert.equal(resource.usage.state, 'busy'); assert.deepEqual(resource.usage.gpus[0].users, []);
  assert.equal(resource.usage.gpus[0].state, 'busy'); assert.equal(resource.gpus.length, 1);
  assert.deepEqual(Object.keys(resource.usage.gpus[0]).sort(), ['id', 'uuid', 'index', 'state', 'users', 'utilization', 'memoryUsedMb'].sort());
  assert.deepEqual(Object.keys(resource.gpus[0]).sort(), ['id', 'uuid', 'index', 'model', 'memoryTotalMb'].sort());
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM managed_resource_bindings').get().n, 1);
  assert.equal(store.listResources(member)[0].id, resource.id);
  assert.deepEqual(store.listResources({ ...member, company: 'B公司' }), []);
});

test('free requires complete valid metrics and process query; positive usage remains busy without a known user', t => {
  const { sync, setClock } = fixture(t);
  let at = base;
  const next = extra => { setClock(++at); return sync(report({ observedAt: at, ...extra })); };
  assert.equal(next({}).usage.state, 'free');
  for (const field of ['inventoryComplete', 'processQueryOk', 'gpuUsageValid']) assert.equal(next({ [field]: false }).usage.state, 'unknown', field);
  assert.equal(next({ gpus: [gpu(1, { utilization: null })] }).usage.state, 'unknown');
  assert.equal(next({ gpus: [gpu(1, { memoryUsedMb: null })] }).usage.state, 'unknown');
  for (const fields of [{ utilization: 0.1 }, { memoryUsedMb: 0.1 }, { hasProcesses: true }]) {
    assert.equal(next({ processQueryOk: false, gpuUsageValid: false, gpus: [gpu(1, fields)] }).usage.state, 'busy');
  }
  const known = next({ gpus: [gpu(1, { users: ['root', 'alice', 'alice'], hasProcesses: true })] });
  assert.deepEqual(known.usage.gpus[0].users, ['alice', 'root']);
});

test('expired reports clear current people and metrics, and future sender clock does not extend freshness', t => {
  const { sync, store, setClock } = fixture(t);
  const resource = sync(report({ observedAt: base + 60_000, gpus: [gpu(1, { users: ['alice'], hasProcesses: true, utilization: 90, memoryUsedMb: 4000 })] }));
  assert.equal(resource.usage.state, 'busy');
  setClock(base + 90_001);
  const expired = store.getResource(resource.id, admin);
  assert.equal(expired.usage.state, 'unknown'); assert.equal(expired.usage.observedAt, null);
  assert.deepEqual(expired.usage.gpus[0].users, []); assert.equal(expired.usage.gpus[0].utilization, null);
  assert.equal(expired.gpus.length, 1);
});

test('duplicate and older reports cannot replace state or refresh the receive clock', t => {
  const { sync, db, store, setClock } = fixture(t);
  const resource = sync(report({ gpus: [gpu(1, { utilization: 50 })] }));
  const before = db.prepare('SELECT * FROM resource_usage').get();
  setClock(base + 30_000);
  sync(report()); sync(report({ observedAt: base - 1 }));
  assert.deepEqual(db.prepare('SELECT * FROM resource_usage').get(), before);
  assert.equal(store.getResource(resource.id, admin).usage.state, 'busy');
});

test('same hardware across SSH identities deduplicates, while a failed source cannot cover another live source', t => {
  const { sync, db, setClock, store } = fixture(t);
  const resource = sync(report({ gpus: [gpu(1, { utilization: 50 }), gpu(2)] }));
  const before = db.prepare('SELECT * FROM resource_inventory').get();
  const alias = server({ id: 'managed-other-login', name: '不要改名' });
  const second = sync(report({ gpus: [gpu(2, { index: 0 }), gpu(1, { index: 1, utilization: 40 })] }), alias);
  assert.equal(second.id, resource.id); assert.equal(second.name, resource.name);
  assert.deepEqual(db.prepare('SELECT * FROM resource_inventory').get(), before);
  setClock(base + 30_000);
  const unknown = report({ observedAt: base + 30_000, status: 'unknown', inventoryComplete: false, processQueryOk: false, gpuUsageValid: false, gpus: [] });
  assert.equal(sync(unknown, alias).usage.state, 'busy');
  assert.equal(sync(unknown).usage.state, 'unknown');
  assert.equal(store.listResources(admin).length, 1);
});

test('only superadmin may claim unassigned exact hardware and all old identity, names, disabled state and bookings remain', t => {
  const { sync, store, db } = fixture(t);
  let resource = store.syncResource({ sourceId: 'legacy-personal', serverId: 'legacy-login', cluster: '旧集群', name: '旧资源名称', notes: '保留备注', gpus: hardware([gpu()]), observedAt: base, status: 'online' }, superAdmin);
  const inventory = db.prepare('SELECT * FROM resource_inventory').get();
  resource = store.updateResource(resource.id, { enabled: false }, superAdmin);
  // A legacy unassigned booking predates company enforcement; preserve it on first assignment.
  db.prepare(`INSERT INTO reservations(id,resource_id,owner_id,owner_name,scope,gpu_indices,gpu_ids,inventory_version,start_at,end_at,purpose,status,created_at,updated_at,company,resource_name_snapshot,cluster_snapshot)
    VALUES('legacy-reservation',?,'legacy-user','历史成员','gpus','[0]',?,1,?,?,'历史用途','confirmed',?,?,'',?,?)`).run(resource.id, JSON.stringify([resource.gpus[0].id]), base - 60_000, base + 60_000, base, base, resource.name, resource.cluster);
  fail(() => sync(), 'SUPERADMIN_REQUIRED');
  assert.equal(store.getResource(resource.id, superAdmin).company, '');
  const claimed = sync(report(), server(), superAdmin);
  assert.equal(claimed.id, resource.id); assert.equal(claimed.company, 'A公司'); assert.equal(claimed.companyVersion, resource.companyVersion + 1);
  for (const key of ['name', 'cluster', 'notes', 'enabled', 'gpus', 'inventoryVersion']) assert.deepEqual(claimed[key], resource[key], key);
  assert.deepEqual(db.prepare('SELECT * FROM resource_inventory').get(), inventory);
  const old = store.getReservation('legacy-reservation', member);
  assert.equal(old.company, 'A公司'); assert.equal(old.ownerName, '历史成员'); assert.equal(old.resourceName, resource.name);
  fail(() => store.createReservation(booking(claimed), member), 'INVALID_INPUT');
});

test('new complete hardware descriptors refresh indices without moving stable GPU bookings or inventory authority', t => {
  const { sync, store, db, setClock } = fixture(t);
  const resource = sync(report({ gpus: [gpu(), gpu(2)] }));
  const booked = store.createReservation(booking(resource), member);
  const before = db.prepare('SELECT * FROM resource_inventory').get();
  const savedBooking = db.prepare('SELECT * FROM reservations').get();
  setClock(base + 10_000);
  const updated = sync(report({ observedAt: base + 10_000, gpus: [gpu(2, { index: 0 }), gpu(1, { index: 1, name: 'NVIDIA Current', memoryTotalMb: 80000 })] }));
  assert.equal(updated.inventoryVersion, resource.inventoryVersion + 1);
  assert.equal(updated.gpus.find(value => value.uuid === resource.gpus[0].uuid).id, resource.gpus[0].id);
  assert.deepEqual(store.getReservation(booked.id, member).gpuIndices, [1]);
  assert.deepEqual(db.prepare('SELECT * FROM reservations').get(), savedBooking);
  assert.equal(db.prepare('SELECT authority_source FROM resource_inventory').get().authority_source, before.authority_source);
  assert.equal(updated.name, resource.name); assert.equal(updated.cluster, resource.cluster);
  assert.equal(updated.observedAt, new Date(base + 10_000).toISOString());
  const refreshed = db.prepare('SELECT * FROM resource_inventory').get();
  setClock(base + 20_000);
  sync(report({ observedAt: base + 20_000, inventoryComplete: false, gpuUsageValid: false, gpus: [gpu(1, { index: 0, utilization: 50 })] }));
  assert.deepEqual(db.prepare('SELECT * FROM resource_inventory').get(), refreshed);
});

test('cross-company UUID claims and partial aliases reject without assigning or merging resources', t => {
  const { sync, store } = fixture(t);
  const resource = sync(report({ gpus: [gpu(), gpu(2)] }));
  fail(() => sync(report({ gpus: [gpu(), gpu(2)] }), server({ id: 'other-org', company: 'B公司' }), superAdmin), 'RESOURCE_COMPANY_CONFLICT');
  fail(() => sync(report(), server({ id: 'partial' })), 'TOPOLOGY_CONFLICT');
  assert.equal(store.getResource(resource.id, admin).inventoryState, 'synced');
  assert.equal(store.listResources(superAdmin).length, 1);
});

test('changed bound inventory records conflict but preserves stable GPUs and existing reservations', t => {
  const { sync, store, setClock } = fixture(t);
  const resource = sync(report({ gpus: [gpu(), gpu(2)] }));
  const booked = store.createReservation(booking(resource), member);
  setClock(base + 10_000);
  fail(() => sync(report({ observedAt: base + 10_000 })), 'INVENTORY_CHANGED');
  const changed = store.getResource(resource.id, admin);
  assert.equal(changed.inventoryState, 'conflict'); assert.deepEqual(changed.gpus, resource.gpus);
  assert.equal(changed.inventoryVersion, resource.inventoryVersion + 1);
  assert.equal(changed.usage.state, 'unknown'); assert.equal(store.getReservation(booked.id, member).ownerId, member.id);
  fail(() => store.createReservation(booking(changed), member), 'INVENTORY_CHANGED');
  fail(() => store.updateResource(resource.id, { acceptInventoryVersion: changed.inventoryVersion }, admin), 'RESOURCE_HAS_RESERVATIONS');
  fail(() => sync(report({ observedAt: base + 10_001, gpus: [gpu(3)] })), 'INVENTORY_CHANGED');
  assert.deepEqual(store.getResource(resource.id, admin).gpus, resource.gpus);
});

test('actual busy is independent from future reservation conflicts and completion', t => {
  const { sync, store } = fixture(t);
  const resource = sync(report({ gpus: [gpu(1, { hasProcesses: true })] }));
  const reserved = store.createReservation(booking(resource), member);
  assert.equal(reserved.status, 'confirmed');
  fail(() => store.createReservation(booking(resource), { ...member, id: 'another-member' }), 'RESERVATION_CONFLICT');
  assert.equal(store.getResource(resource.id, member).usage.state, 'busy');
  assert.equal(store.cancelReservation(reserved.id, { version: 1 }, member).status, 'cancelled');
  assert.equal(store.getResource(resource.id, member).usage.state, 'busy');
});

test('strict telemetry contract rejects extra secret/process fields and invalid values before persistence', t => {
  const { sync, db } = fixture(t);
  fail(() => sync(report(), server(), member), 'FORBIDDEN');
  for (const extra of [{ password: 'synthetic-only' }, { company: 'B公司' }, { processQueryOk: 1 }, { observedAt: base + 60_001 }, { serverVersion: 2 }]) {
    assert.throws(() => sync(report(extra)));
  }
  for (const extra of [{ command: 'synthetic-command' }, { pid: 123 }, { username: 'not-a-DTO-field' }, { utilization: -1 }, { utilization: 101 }, { utilization: undefined }, { memoryUsedMb: 90000 }, { users: ['a\nb'], hasProcesses: true }, { users: ['alice'], hasProcesses: false }]) {
    assert.throws(() => sync(report({ gpus: [gpu(1, extra)] })));
  }
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM resource_usage').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM resources').get().n, 0);
});
