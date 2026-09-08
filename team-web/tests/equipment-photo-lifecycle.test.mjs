import { assignFixtureCompany } from './helpers/account-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import sharp from 'sharp';
import { createTeamServer } from '../server/server.mjs';

const PUBLIC = 'http://127.0.0.1:1421';
async function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'racktop-photo-lifecycle-'));
  const dbPath = join(directory, 'team.sqlite');
  const app = createTeamServer({ mode: 'account', host: '127.0.0.1', port: 0, publicUrl: PUBLIC, dbPath });
  const { port } = await app.start();
  t.after(async () => { await app.close(); rmSync(directory, { recursive: true, force: true }); });
  const begin = (path, body, session) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    let req;
    const promise = new Promise((resolve, reject) => {
      req = request({ host: '127.0.0.1', port, path, method: body === undefined ? 'GET' : 'POST', headers: {
        host: new URL(PUBLIC).host, origin: PUBLIC,
        ...(data === undefined ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) }),
        ...(session ? { cookie: session.cookie, 'x-csrf-token': session.csrfToken } : {}),
      } }, res => {
        const chunks = []; res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => resolve({ status: res.statusCode,
          cookie: res.headers['set-cookie']?.[0]?.split(';')[0], body: JSON.parse(Buffer.concat(chunks).toString()) }));
      });
      req.on('error', reject); req.end(data);
    });
    return { req, promise };
  };
  const call = (...args) => begin(...args).promise;
  const anon = await call('/api/session');
  const signed = await call('/api/auth/register', { username: 'lifecycle', name: '生命周期测试', password: '临时测试' },
    { cookie: anon.cookie, csrfToken: anon.body.csrfToken });
  assert.equal(signed.status, 201);
  assignFixtureCompany(dbPath, signed.body.user);
  const session = { cookie: signed.cookie, csrfToken: signed.body.csrfToken };
  const created = await call('/api/equipment', { name: '照片处理设备', category: '摄像头模组', location: '上海' }, session);
  assert.equal(created.status, 201);
  const bytes = await sharp({ create: { width: 320, height: 240, channels: 3, background: '#214568' } }).jpeg().toBuffer();
  const dataUrl = `data:image/jpeg;base64,${bytes.toString('base64')}`;
  return { app, dbPath, session, equipment: created.body.equipment, begin, call, dataUrl };
}

function pauseDecoder(t) {
  const original = sharp.prototype.metadata;
  let enter, release;
  const entered = new Promise(resolve => { enter = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  // Pause a real decode after metadata is read, without adding test hooks to the
  // production route or replacing its normalization and authorization logic.
  t.mock.method(sharp.prototype, 'metadata', function (...args) {
    return original.apply(this, args).then(async metadata => { enter(); await gate; return metadata; });
  });
  return { entered, release };
}

function assertUnchanged(dbPath, id) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    assert.equal(db.prepare('SELECT version FROM equipment WHERE id=?').get(id).version, 1);
    assert.equal(db.prepare('SELECT count(*) AS n FROM equipment_photos WHERE equipment_id=?').get(id).n, 0);
    assert.equal(db.prepare('SELECT count(*) AS n FROM equipment_changes WHERE equipment_id=?').get(id).n, 1);
  } finally { db.close(); }
}

test('shutdown waits for disconnected photo handlers before closing auth and SQLite', { timeout: 10000 }, async t => {
  const { app, dbPath, session, equipment, begin, dataUrl } = await fixture(t);
  const decoder = pauseDecoder(t);
  const originalClose = app.auth.close.bind(app.auth), originalResolve = app.auth.resolve.bind(app.auth);
  let authClosed = false, authReadsAfterClose = 0;
  t.mock.method(app.auth, 'close', () => { authClosed = true; originalClose(); });
  t.mock.method(app.auth, 'resolve', req => { if (authClosed) authReadsAfterClose++; return originalResolve(req); });
  try {
    const upload = begin(`/api/equipment/${equipment.id}/photo`, { version: 1, dataUrl }, session);
    const aborted = upload.promise.catch(error => error);
    await decoder.entered;
    upload.req.destroy(new Error('test client disconnected'));
    const socketsClosed = once(app.server, 'close');
    const closing = app.close();
    assert.equal(app.close(), closing, 'repeated close calls await the same operation');
    await socketsClosed;
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(authClosed, false, 'socket closure must not dispose state used by an in-flight handler');
    decoder.release(); await closing; await aborted;
    assert.equal(authClosed, true); assert.equal(authReadsAfterClose, 0);
    assertUnchanged(dbPath, equipment.id);
  } finally { decoder.release(); }
});

test('shutdown ends connected uploads with 503 and does not save a photo or hang close', { timeout: 10000 }, async t => {
  const { app, dbPath, session, equipment, begin, dataUrl } = await fixture(t);
  const decoder = pauseDecoder(t);
  try {
    const upload = begin(`/api/equipment/${equipment.id}/photo`, { version: 1, dataUrl }, session);
    await decoder.entered;
    const closing = app.close();
    decoder.release();
    const response = await upload.promise;
    assert.equal(response.status, 503);
    await closing;
    assertUnchanged(dbPath, equipment.id);
  } finally { decoder.release(); }
});

test('logout during asynchronous photo compression prevents the pending write', { timeout: 10000 }, async t => {
  const { dbPath, session, equipment, begin, call, dataUrl } = await fixture(t);
  const decoder = pauseDecoder(t);
  try {
    const upload = begin(`/api/equipment/${equipment.id}/photo`, { version: 1, dataUrl }, session);
    await decoder.entered;
    assert.equal((await call('/api/auth/logout', {}, session)).status, 200);
    decoder.release();
    assert.equal((await upload.promise).status, 401);
    assertUnchanged(dbPath, equipment.id);
    assert.equal((await call(`/api/equipment/${equipment.id}/photo`, undefined, session)).status, 401);
  } finally { decoder.release(); }
});

test('revoking company access during photo normalization denies the pending write and future reads', { timeout: 10000 }, async t => {
  const { dbPath, session, equipment, begin, call, dataUrl } = await fixture(t);
  const decoder = pauseDecoder(t);
  try {
    const upload = begin(`/api/equipment/${equipment.id}/photo`, { version: 1, dataUrl }, session);
    await decoder.entered;
    const db = new DatabaseSync(dbPath);
    try { db.prepare("UPDATE account_users SET company = NULL, version = version + 1 WHERE username = 'lifecycle'").run(); }
    finally { db.close(); }
    decoder.release();
    const result = await upload.promise;
    assert.equal(result.status, 403); assert.equal(result.body.error.code, 'COMPANY_REQUIRED');
    assertUnchanged(dbPath, equipment.id);
    for (const path of [`/api/equipment/${equipment.id}/photo`, '/api/equipment', '/api/resources', '/api/reservations']) {
      const denied = await call(path, undefined, session);
      assert.equal(denied.status, 403); assert.equal(denied.body.error.code, 'COMPANY_REQUIRED');
    }
    assert.equal((await call('/api/session', undefined, session)).body.user.company, null);
  } finally { decoder.release(); }
});
