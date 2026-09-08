import { assignFixtureCompany } from './helpers/account-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { createTeamServer } from '../server/server.mjs';

const PUBLIC = 'http://127.0.0.1:1421';
async function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'racktop-photo-http-'));
  const config = { mode: 'account', host: '127.0.0.1', port: 0, publicUrl: PUBLIC, dbPath: join(directory, 'team.sqlite') };
  let app = createTeamServer(config), port = (await app.start()).port;
  t.after(async () => { await app.close(); rmSync(directory, { recursive: true, force: true }); });
  const call = (path, { method = 'GET', body, session, headers = {} } = {}) => new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const req = request({ host: '127.0.0.1', port, path, method, headers: {
      host: new URL(PUBLIC).host, origin: PUBLIC,
      ...(data === undefined ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) }),
      ...(session ? { cookie: session.cookie, 'x-csrf-token': session.csrfToken } : {}), ...headers,
    } }, res => {
      const chunks = []; res.on('data', c => chunks.push(c));
      res.on('end', () => { const bytes = Buffer.concat(chunks); let body; try { body = JSON.parse(bytes.toString()); } catch { body = undefined; }
        resolve({ status: res.statusCode, headers: res.headers, bytes, body }); });
    });
    req.on('error', reject); req.end(data);
  });
  const anon = await call('/api/session');
  const start = { cookie: anon.headers['set-cookie'][0].split(';')[0], csrfToken: anon.body.csrfToken };
  const registered = await call('/api/auth/register', { method: 'POST', session: start, body: { username: '拍', name: '照片验收', password: '照' } });
  assert.equal(registered.status, 201);
  assignFixtureCompany(config.dbPath, registered.body.user);
  const session = { cookie: registered.headers['set-cookie'][0].split(';')[0], csrfToken: registered.body.csrfToken };
  const created = await call('/api/equipment', { method: 'POST', session, body: { name: '测试摄像头', category: '摄像头模组', location: '上海' } });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  return { call, session, equipment: created.body.equipment,
    async restart() { await app.close(); app = createTeamServer(config); port = (await app.start()).port; } };
}
async function photo() {
  const bytes = await sharp({ create: { width: 2400, height: 1800, channels: 3, background: '#217a9b' } })
    .withMetadata({ orientation: 6 }).jpeg({ quality: 95 }).toBuffer();
  return `data:image/jpeg;base64,${bytes.toString('base64')}`;
}

test('photos require membership, normalize server-side and persist across restart', async t => {
  const { call, session, equipment, restart } = await fixture(t);
  const path = `/api/equipment/${equipment.id}/photo`;
  assert.equal((await call(path)).status, 401);
  assert.equal((await call(path, { session })).status, 404);
  const uploaded = await call(path, { method: 'POST', session, body: { version: 1, dataUrl: await photo() } });
  assert.equal(uploaded.status, 200, JSON.stringify(uploaded.body));
  assert.equal(uploaded.body.equipment.version, 2);
  assert.equal(uploaded.body.equipment.serialNumber, equipment.serialNumber);
  const stored = await call(uploaded.body.equipment.photo.url, { session });
  assert.equal(stored.status, 200); assert.equal(stored.headers['content-type'], 'image/jpeg');
  assert.equal(stored.headers['cache-control'], 'no-store'); assert.equal(stored.headers['x-content-type-options'], 'nosniff');
  const info = await sharp(stored.bytes).metadata();
  assert.equal(info.format, 'jpeg'); assert.equal(info.width, 1200); assert.equal(info.height, 1600);
  assert.equal(info.exif, undefined); assert.ok(stored.bytes.length <= 512 * 1024);
  assert.equal(uploaded.body.equipment.photo.bytes, stored.bytes.length);
  await restart();
  const after = await call(path, { session }); assert.deepEqual(after.bytes, stored.bytes);
  const list = await call('/api/equipment', { session }); assert.equal(list.body.equipment[0].photo.bytes, stored.bytes.length);
  assert.ok(list.bytes.length < 4096, 'list must not embed image content');
});

test('forged uploads, stale versions and missing CSRF leave the existing photo unchanged', async t => {
  const { call, session, equipment } = await fixture(t);
  const path = `/api/equipment/${equipment.id}/photo`, dataUrl = await photo();
  assert.equal((await call(path, { method: 'POST', body: { version: 1, dataUrl } })).status, 401);
  assert.equal((await call(path, { method: 'POST', session, headers: { 'x-csrf-token': 'wrong' }, body: { version: 1, dataUrl } })).status, 403);
  assert.equal((await call(path, { method: 'POST', session, body: { version: 1, dataUrl, path: '/etc/passwd' } })).status, 422);
  assert.equal((await call(path, { method: 'POST', session, body: { version: 1, dataUrl } })).status, 200);
  const original = await call(path, { session });
  assert.equal((await call(path, { method: 'POST', session, body: { version: 1, dataUrl } })).status, 409);
  assert.equal((await call(path, { method: 'DELETE', session, body: { version: 1 } })).status, 409);
  assert.equal((await call(path, { method: 'POST', session, body: { version: 2, dataUrl: 'data:image/jpeg;base64,AAAA' } })).status, 415);
  assert.equal((await call(path, { method: 'POST', session, body: { version: 2, dataUrl: 'x'.repeat(2 * 1024 * 1024) } })).status, 413);
  assert.deepEqual((await call(path, { session })).bytes, original.bytes);
  assert.equal((await call(path + '?token=unexpected', { session })).status, 422);
});

test('photo replacement and text updates share one version; logout revokes photo reads', async t => {
  const { call, session, equipment } = await fixture(t);
  const path = `/api/equipment/${equipment.id}/photo`, dataUrl = await photo();
  const results = await Promise.all([
    call(path, { method: 'POST', session, body: { version: 1, dataUrl } }),
    call(`/api/equipment/${equipment.id}`, { method: 'PATCH', session, body: { version: 1, currentUser: '临时使用人' } }),
  ]);
  assert.deepEqual(results.map(r => r.status).sort(), [200, 409]);
  let latest = (await call(`/api/equipment/${equipment.id}`, { session })).body.equipment;
  if (!latest.photo) latest = (await call(path, { method: 'POST', session, body: { version: latest.version, dataUrl } })).body.equipment;
  const removed = await call(path, { method: 'DELETE', session, body: { version: latest.version } });
  assert.equal(removed.status, 200); assert.equal(removed.body.equipment.photo, null);
  assert.equal((await call(path, { session })).status, 404);
  const again = await call(path, { method: 'POST', session, body: { version: removed.body.equipment.version, dataUrl } }); assert.equal(again.status, 200);
  assert.equal((await call('/api/auth/logout', { method: 'POST', session, body: {} })).status, 200);
  assert.equal((await call(path, { session })).status, 401);
  assert.equal((await call('/api/equipment', { session })).status, 401);
});
