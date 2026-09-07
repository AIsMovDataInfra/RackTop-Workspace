import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { createStore, parseDate } from '../server/store.mjs';

const admin = { id: 'admin', name: '管理员', role: 'admin' };
const lin = { id: 'lin', name: '小林', role: 'member' };
const zhou = { id: 'zhou', name: '小周', role: 'member' };
const base = Date.parse('2026-09-08T04:00:00Z');
const iso = delta => new Date(base + delta * 60_000).toISOString();
function fixture(t, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'racktop-team-store-'));
  let clock = base;
  const path = join(directory, 'test.sqlite');
  const store = createStore({ dbPath: path, now: () => clock, ...options });
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const resource = store.createResource({ cluster: '训练集群', name: 'Atlas', gpuModel: 'A100', gpuCount: 4 }, admin);
  const booking = (overrides = {}) => ({ resourceId: resource.id, scope: 'gpus', gpuIndices: [0], startAt: iso(10), endAt: iso(70), purpose: '模型训练', ...overrides });
  return { store, path, resource, booking, setClock: value => { clock = value; } };
}
function fails(fn, status, code) {
  assert.throws(fn, error => error.status === status && (!code || error.code === code));
}

test('same GPU overlaps conflict, different GPUs and adjacent windows work; machine is exclusive', t => {
  const { store, booking } = fixture(t);
  const first = store.createReservation(booking(), lin);
  fails(() => store.createReservation(booking({ gpuIndices: [0, 1] }), zhou), 409, 'RESERVATION_CONFLICT');
  fails(() => store.createReservation(booking({ scope: 'machine', gpuIndices: [] }), zhou), 409);
  assert.equal(store.createReservation(booking({ gpuIndices: [1] }), zhou).scope, 'gpus');
  assert.equal(store.createReservation(booking({ startAt: first.endAt, endAt: iso(90) }), lin).startAt, first.endAt);
  const whole = store.createReservation(booking({ scope: 'machine', gpuIndices: [], startAt: iso(100), endAt: iso(130) }), lin);
  fails(() => store.createReservation(booking({ gpuIndices: [3], startAt: whole.startAt, endAt: whole.endAt }), zhou), 409);
});

test('cancel releases slots, CAS rejects stale writes, owner and admin permissions are enforced', t => {
  const { store, booking } = fixture(t);
  const first = store.createReservation(booking(), lin);
  fails(() => store.updateReservation(first.id, { version: 1, purpose: '越权' }, zhou), 403);
  fails(() => store.cancelReservation(first.id, { version: 1 }, zhou), 403);
  const changed = store.updateReservation(first.id, { version: 1, purpose: '新用途' }, lin);
  assert.equal(changed.version, 2);
  fails(() => store.updateReservation(first.id, { version: 1, purpose: '过期' }, admin), 409, 'VERSION_CONFLICT');
  const cancelled = store.cancelReservation(first.id, { version: 2 }, admin);
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.version, 3);
  store.createReservation(booking(), zhou);
  assert.equal(store.listReservations({}, lin).length, 2);
  assert.equal(store.listReservations({ mine: true }, lin).length, 1);
});

test('ongoing extension keeps its original start and checks conflicts; finish preserves planned end', t => {
  const { store, booking, setClock } = fixture(t);
  const first = store.createReservation(booking({ startAt: iso(0), endAt: iso(40) }), lin);
  store.createReservation(booking({ startAt: iso(60), endAt: iso(120) }), zhou);
  setClock(base + 20 * 60_000);
  fails(() => store.updateReservation(first.id, { version: 1, startAt: iso(21) }, lin), 422);
  fails(() => store.updateReservation(first.id, { version: 1, endAt: iso(90) }, lin), 409);
  assert.equal(store.getReservation(first.id).version, 1);
  const extended = store.updateReservation(first.id, { version: 1, endAt: iso(60) }, lin);
  assert.equal(extended.startAt, iso(0));
  const finished = store.finishReservation(first.id, { version: 2 }, lin);
  assert.equal(finished.status, 'completed');
  assert.equal(finished.endAt, iso(20));
  assert.equal(finished.plannedEndAt, iso(60));
  store.createReservation(booking({ startAt: iso(20), endAt: iso(60) }), zhou);
  fails(() => store.finishReservation(first.id, { version: 3 }, lin), 409);
});

test('resource edits require admin, active bookings protect GPU count, disabled and CPU resources validated', t => {
  const { store, resource, booking } = fixture(t);
  fails(() => store.createResource({ cluster: 'x', name: 'x', gpuModel: 'x', gpuCount: 4 }, lin), 403);
  fails(() => store.updateResource(resource.id, { enabled: false }, lin), 403);
  store.createReservation(booking(), lin);
  fails(() => store.updateResource(resource.id, { gpuCount: 2 }, admin), 409, 'RESOURCE_HAS_RESERVATIONS');
  assert.equal(store.updateResource(resource.id, { name: 'Atlas II' }, admin).name, 'Atlas II');
  store.updateResource(resource.id, { enabled: false }, admin);
  fails(() => store.createReservation(booking({ gpuIndices: [2] }), lin), 422);
  const cpu = store.createResource({ cluster: '开发', name: 'CPU', gpuModel: '', gpuCount: 0 }, admin);
  fails(() => store.createReservation(booking({ resourceId: cpu.id }), lin), 422);
  assert.equal(store.createReservation(booking({ resourceId: cpu.id, scope: 'machine', gpuIndices: [] }), lin).scope, 'machine');
});

test('resource names are unique within each cluster ignoring ASCII case, with non-destructive migration', t => {
  const { store, resource, path } = fixture(t);
  fails(() => store.createResource({ cluster: resource.cluster, name: 'ATLAS', gpuModel: 'A100', gpuCount: 4 }, admin), 409, 'RESOURCE_DUPLICATE');
  const other = store.createResource({ cluster: '另一个集群', name: 'Atlas', gpuModel: 'A100', gpuCount: 4 }, admin);
  fails(() => store.updateResource(other.id, { cluster: resource.cluster, name: 'atlas' }, admin), 409, 'RESOURCE_DUPLICATE');
  assert.equal(store.getResource(other.id).cluster, '另一个集群');
  const legacy = new DatabaseSync(path);
  legacy.exec("DROP INDEX resources_unique_name; INSERT INTO resources SELECT 'legacy-duplicate',cluster,name,gpu_model,gpu_count,notes,enabled,created_at,updated_at FROM resources WHERE name='Atlas' LIMIT 1;");
  legacy.close();
  assert.throws(() => createStore({ dbPath: path }), /未删除或合并/);
  assert.equal(store.listResources().length, 3);
});

test('invalid dates, arrays, duration, owner spoofing, resource and query input fail closed', t => {
  const { store, booking } = fixture(t);
  for (const startAt of ['2026-02-30T12:00:00Z', '2026-09-08T12:00', '2026-09-08T25:00:00Z', '2026-09-08T12:00:00+15:00', '', null]) fails(() => store.createReservation(booking({ startAt }), lin), 422);
  assert.equal(parseDate('2026-09-08T12:00:00+08:00'), base);
  for (const gpuIndices of [[-1], [4], [0, 0], ['0'], [0.5], [], null]) fails(() => store.createReservation(booking({ gpuIndices }), lin), 422);
  for (const override of [{ startAt: iso(-2) }, { endAt: iso(0) }, { endAt: iso(8 * 24 * 60) }, { startAt: iso(91 * 24 * 60), endAt: iso(91 * 24 * 60 + 10) }, { purpose: 'x'.repeat(501) }, { ownerId: 'admin' }, { resourceId: '../secret' }]) fails(() => store.createReservation(booking(override), lin), 422);
  fails(() => store.createReservation(booking({ resourceId: 'nonexistent' }), lin), 404);
  fails(() => store.listReservations({ from: iso(30), to: iso(10) }, lin), 422);
  fails(() => store.listReservations({ mine: 'perhaps' }, lin), 422);
  assert.equal(store.listReservations({}, lin).length, 0);
});

test('independent connections preserve state, and persisted demo seed is explicit and idempotent', t => {
  const { store, path, booking } = fixture(t);
  const first = store.createReservation(booking(), lin);
  const other = createStore({ dbPath: path, now: () => base });
  t.after(() => other.close());
  assert.equal(other.getReservation(first.id).purpose, first.purpose);
  fails(() => other.createReservation(booking(), zhou), 409);
  other.updateReservation(first.id, { version: 1, purpose: '第二连接更新' }, admin);
  fails(() => store.cancelReservation(first.id, { version: 1 }, lin), 409);
  store.seedDemo();
  assert.equal(store.listResources().length, 1, 'existing production resources are preserved');
  const empty = createStore({ dbPath: ':memory:', now: () => base });
  assert.equal(empty.listResources().length, 0);
  empty.seedDemo(); empty.seedDemo();
  assert.equal(empty.listResources().length, 3);
  assert.ok(empty.listResources().every(resource => resource.name.includes('演示')));
  empty.close();
});

test('two independent processes competing for one GPU commit exactly one reservation', async t => {
  const { store, path, resource } = fixture(t);
  const moduleUrl = new URL('../server/store.mjs', import.meta.url).href;
  const source = `import {createStore} from ${JSON.stringify(moduleUrl)};
    const s=createStore({dbPath:process.argv[1],now:()=>Number(process.argv[3])});
    process.send('ready'); process.once('message',()=>{try {s.createReservation({resourceId:process.argv[2],scope:'gpus',gpuIndices:[0],startAt:new Date(Number(process.argv[3])+60000).toISOString(),endAt:new Date(Number(process.argv[3])+3600000).toISOString(),purpose:'race'},{id:'race-'+process.pid,name:'竞争测试',role:'member'});process.send({status:201});} catch(e){process.send({status:e.status,code:e.code});} finally {s.close();process.disconnect();}});`;
  const children = [0, 1].map(() => spawn(process.execPath, ['--input-type=module', '-e', source, path, resource.id, String(base)], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] }));
  t.after(() => { for (const child of children) if (child.exitCode === null) child.kill(); });
  const ready = child => new Promise((resolveReady, reject) => { child.once('message', message => message === 'ready' ? resolveReady() : reject(new Error('Unexpected child message'))); child.once('error', reject); child.once('exit', code => { if (code) reject(new Error(`Worker exited ${code}`)); }); });
  await Promise.all(children.map(ready));
  const responses = children.map(child => new Promise(resolveMessage => child.once('message', resolveMessage)));
  for (const child of children) child.send('go');
  const outcomes = await Promise.all(responses);
  assert.deepEqual(outcomes.map(result => result.status).sort(), [201, 409]);
  assert.equal(store.listReservations({}, lin).length, 1);
});

test('outbox is transactional, disabled messages never replay, failures retry and reminders deduplicate', t => {
  const { store, path, booking, setClock } = fixture(t, { notificationsConfigured: true });
  const first = store.createReservation(booking({ startAt: iso(0), endAt: iso(30) }), lin);
  fails(() => store.createReservation(booking(), zhou), 409);
  const events = store.claimOutbox();
  assert.equal(events.length, 1);
  assert.equal(events[0].event.type, 'created');
  store.retryOutbox(events[0].id, '模拟网络失败');
  assert.equal(store.claimOutbox().length, 0);
  setClock(base + 11_000);
  const retried = store.claimOutbox();
  assert.equal(retried.length, 1);
  assert.equal(retried[0].attempts, 1);
  store.completeOutbox(retried[0].id);
  store.enqueueEnding(); store.enqueueEnding();
  const reminders = store.claimOutbox();
  assert.equal(reminders.length, 1);
  assert.equal(reminders[0].event.type, 'ending');
  store.completeOutbox(reminders[0].id);
  store.enqueueEnding(); assert.equal(store.claimOutbox().length, 0);
  store.updateReservation(first.id, { version: 1, endAt: iso(29) }, lin);
  store.enqueueEnding();
  setClock(base + 40 * 60_000);
  assert.ok(store.claimOutbox().every(item => item.event.type !== 'ending'), 'expired reminders are suppressed');
  const disabled = createStore({ dbPath: ':memory:', now: () => base });
  const resource = disabled.createResource({ cluster: 'c', name: 'n', gpuModel: '', gpuCount: 0 }, admin);
  disabled.createReservation(booking({ resourceId: resource.id, scope: 'machine', gpuIndices: [] }), lin);
  assert.equal(disabled.claimOutbox().length, 0);
  disabled.close();
  const reopened = createStore({ dbPath: path, now: () => base + 40 * 60_000, notificationsConfigured: true });
  assert.equal(reopened.getReservation(first.id).version, 2);
  reopened.close();
});
