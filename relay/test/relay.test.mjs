import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, writeFileSync, chmodSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket from 'ws';
import { createRelay, readOwnerTokenFile } from '../src/relay.mjs';

const OWNER = randomBytes(32).toString('base64url');
const BAD = randomBytes(32).toString('base64url');
const TIMEOUT = 3000;

async function fixture(t, options = {}) {
  const relay = createRelay({ ownerToken: OWNER, closeGraceMs: 40, ...options });
  const address = await relay.listen(0);
  t.after(() => relay.close());
  const httpBase = `http://127.0.0.1:${address.port}`;
  const wsBase = `ws://127.0.0.1:${address.port}`;
  const request = (path, options) => fetch(httpBase + path,
    { signal: AbortSignal.timeout(TIMEOUT), ...options });
  async function room() {
    const response = await request('/v1/rooms', {
      method: 'POST', headers: { Authorization: `Bearer ${OWNER}` },
    });
    assert.equal(response.status, 201);
    return response.json();
  }
  async function peer(path, token, extra = {}) {
    const ws = new WebSocket(wsBase + path, {
      headers: { Authorization: `Bearer ${token}` }, ...extra,
    });
    const queue = [];
    const waiting = [];
    ws.on('error', () => {});
    ws.on('message', (data, isBinary) => {
      const value = { data, isBinary };
      const resolve = waiting.shift();
      if (resolve) resolve(value); else queue.push(value);
    });
    ws.next = () => queue.length ? Promise.resolve(queue.shift()) : new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Message timeout')), TIMEOUT);
      waiting.push(value => { clearTimeout(timer); resolve(value); });
    });
    await once(ws, 'open', { signal: AbortSignal.timeout(TIMEOUT) });
    return ws;
  }
  async function rejected(path, token, extra = {}) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsBase + path, {
        headers: token ? { Authorization: `Bearer ${token}` } : {}, ...extra,
      });
      const timer = setTimeout(() => { ws.terminate(); reject(new Error('Handshake timeout')); }, TIMEOUT);
      ws.on('error', () => {});
      ws.on('open', () => { clearTimeout(timer); ws.terminate(); reject(new Error('Unexpected upgrade')); });
      ws.on('unexpected-response', (_req, response) => {
        clearTimeout(timer); response.resume(); ws.terminate(); resolve(response.statusCode);
      });
    });
  }
  async function pair(r) {
    const host = await peer(r.hostPath, r.hostToken);
    const guest = await peer(r.guestPath, r.guestToken);
    for (const ws of [host, guest]) {
      const ready = await ws.next();
      assert.equal(ready.isBinary, false);
      assert.deepEqual(JSON.parse(ready.data.toString()), { type: 'ready' });
    }
    return { host, guest };
  }
  return { relay, request, room, peer, rejected, pair };
}

const closed = ws => once(ws, 'close', { signal: AbortSignal.timeout(TIMEOUT) });
async function eventually(predicate) {
  const deadline = Date.now() + TIMEOUT;
  while (!predicate()) {
    if (Date.now() > deadline) assert.fail('State did not settle');
    await delay(5);
  }
}

test('owner credential file must be regular, 0600, correctly formatted, and not a symlink', () => {
  const directory = mkdtempSync(join(tmpdir(), 'racktop-relay-test-'));
  try {
    const path = join(directory, 'owner');
    writeFileSync(path, `${OWNER}\n`, { mode: 0o600 });
    assert.equal(readOwnerTokenFile(path), OWNER);
    chmodSync(path, 0o644);
    assert.throws(() => readOwnerTokenFile(path), /0600/);
    chmodSync(path, 0o600);
    const link = join(directory, 'link');
    symlinkSync(path, link);
    assert.throws(() => readOwnerTokenFile(link));
    writeFileSync(path, 'weak');
    assert.throws(() => readOwnerTokenFile(path), /format/);
  } finally { rmSync(directory, { recursive: true }); }
});

test('health is minimal; room creation requires owner auth and rejects configuration injection', async t => {
  const f = await fixture(t);
  const health = await f.request('/healthz');
  assert.deepEqual(await health.json(), { status: 'ok' });
  for (const token of [undefined, BAD]) {
    const response = await f.request('/v1/rooms', {
      method: 'POST', headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    assert.equal(response.status, 401);
  }
  const ownerHeaders = { Authorization: `Bearer ${OWNER}` };
  for (const body of ['{"host":"127.0.0.1","port":22}', '{"url":"http://169.254.169.254"}', '[]']) {
    assert.equal((await f.request('/v1/rooms', { method: 'POST', headers: ownerHeaders, body })).status, 400);
  }
  assert.equal((await f.request('/v1/rooms?token=' + OWNER,
    { method: 'POST', headers: ownerHeaders })).status, 400);
  assert.equal((await f.request('/v1/rooms', {
    method: 'POST', headers: { ...ownerHeaders, Origin: 'https://evil.invalid' },
  })).status, 400);
  assert.equal((await f.request('/v1/rooms', {
    method: 'POST', headers: ownerHeaders, body: 'x'.repeat(257),
  })).status, 413);
  const r = await f.room();
  assert.match(r.roomId, /^[A-Za-z0-9_-]{32}$/);
  assert.notEqual(r.hostToken, r.guestToken);
  assert.ok(!r.hostPath.includes(r.hostToken) && !r.guestPath.includes(r.guestToken));
  assert.equal(f.relay.stats().rooms, 1);
});

test('WS role credentials, Origin and query rejection; duplicate slots cannot take over', async t => {
  const f = await fixture(t);
  const r = await f.room();
  assert.equal(await f.rejected(r.hostPath), 401);
  assert.equal(await f.rejected(r.hostPath, BAD), 401);
  assert.equal(await f.rejected(r.hostPath, r.guestToken), 401);
  assert.equal(await f.rejected(r.hostPath, r.hostToken, { origin: 'https://evil.invalid' }), 400);
  assert.equal(await f.rejected(`${r.hostPath}?token=${r.hostToken}`, r.hostToken), 400);
  assert.equal(await f.rejected('/proxy/127.0.0.1/22', r.hostToken), 400);
  const host = await f.peer(r.hostPath, r.hostToken);
  assert.equal(await f.rejected(r.hostPath, r.hostToken), 409);
  assert.equal(host.readyState, WebSocket.OPEN);
});

test('simultaneous same-role upgrades admit exactly one socket', async t => {
  const f = await fixture(t);
  const r = await f.room();
  const results = await Promise.allSettled([
    f.peer(r.hostPath, r.hostToken), f.peer(r.hostPath, r.hostToken),
  ]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  const failure = results.find(result => result.status === 'rejected');
  assert.match(failure.reason.message, /409/);
  assert.equal(f.relay.stats().connections, 1);
});

test('both peers receive ready then ordered, unchanged binary in both directions', async t => {
  const f = await fixture(t);
  const r = await f.room();
  const { host, guest } = await f.pair(r);
  const payload = randomBytes(64 * 1024);
  host.send(payload);
  const received = await guest.next();
  assert.equal(received.isBinary, true);
  assert.deepEqual(received.data, payload);
  guest.send(Buffer.from([0, 255, 128, 10]));
  assert.deepEqual((await host.next()).data, Buffer.from([0, 255, 128, 10]));
  for (let i = 0; i < 8; i++) host.send(Buffer.from([i]));
  for (let i = 0; i < 8; i++) assert.deepEqual((await guest.next()).data, Buffer.from([i]));
});

test('unpaired data and text after ready close and invalidate rooms', async t => {
  const f = await fixture(t);
  const r = await f.room();
  const early = await f.peer(r.hostPath, r.hostToken);
  const earlyClose = closed(early);
  early.send(Buffer.from('early'));
  assert.equal((await earlyClose)[0], 1008);
  assert.equal(await f.rejected(r.hostPath, r.hostToken), 404);
  const next = await f.room();
  const { host, guest } = await f.pair(next);
  const closures = [closed(host), closed(guest)];
  host.send('not binary');
  assert.deepEqual((await Promise.all(closures)).map(value => value[0]), [1008, 1008]);
  assert.equal(f.relay.stats().rooms, 0);
});

test('peer close cleans both sides; pairing TTL and paired session lifetime are independent', async t => {
  const f = await fixture(t, { roomTtlMs: 100, sessionMaxAgeMs: 150 });
  const r = await f.room();
  const { host, guest } = await f.pair(r);
  const closures = [closed(host), closed(guest)];
  host.close();
  await Promise.all(closures);
  await eventually(() => f.relay.stats().connections === 0);
  assert.equal(f.relay.stats().rooms, 0);
  const pending = await f.room();
  const lonely = await f.peer(pending.hostPath, pending.hostToken);
  assert.equal((await closed(lonely))[0], 1001);
  assert.equal(await f.rejected(pending.guestPath, pending.guestToken), 404);
  const expired = await f.room();
  const pair = await f.pair(expired);
  assert.deepEqual((await Promise.all([closed(pair.host), closed(pair.guest)])).map(value => value[0]), [1001, 1001]);
  assert.equal(f.relay.stats().rooms, 0);
});

test('room and connection limits reject overflow and release capacity', async t => {
  const f = await fixture(t, { maxRooms: 1, maxConnections: 1 });
  const r = await f.room();
  assert.equal((await f.request('/v1/rooms', {
    method: 'POST', headers: { Authorization: `Bearer ${OWNER}` },
  })).status, 429);
  const host = await f.peer(r.hostPath, r.hostToken);
  assert.equal(await f.rejected(r.guestPath, r.guestToken), 429);
  const done = closed(host); host.close(); await done;
  await eventually(() => f.relay.stats().connections === 0);
  const next = await f.room();
  assert.notEqual(next.roomId, r.roomId);
});

test('oversize messages close both peers without forwarding', async t => {
  const f = await fixture(t, { maxPayload: 64 });
  const { host, guest } = await f.pair(await f.room());
  const closures = [closed(host), closed(guest)];
  host.send(Buffer.alloc(65));
  assert.deepEqual((await Promise.all(closures)).map(value => value[0]), [1009, 1009]);
});

test('combined room rate budget applies to both directions', async t => {
  const f = await fixture(t, { bytesPerSecond: 1, burstBytes: 32 });
  const { host, guest } = await f.pair(await f.room());
  host.send(Buffer.alloc(20));
  await guest.next();
  const closures = [closed(host), closed(guest)];
  guest.send(Buffer.alloc(20));
  assert.deepEqual((await Promise.all(closures)).map(value => value[0]), [1008, 1008]);
});

test('bounded write queue refuses a payload exceeding available buffer', async t => {
  const f = await fixture(t, { maxBufferedBytes: 64 });
  const { host, guest } = await f.pair(await f.room());
  const closures = [closed(host), closed(guest)];
  host.send(Buffer.alloc(65));
  assert.deepEqual((await Promise.all(closures)).map(value => value[0]), [1013, 1013]);
});

test('missing pong times out room and connected counterpart', async t => {
  const f = await fixture(t, { heartbeatMs: 40 });
  const r = await f.room();
  const host = await f.peer(r.hostPath, r.hostToken, { autoPong: false });
  const guest = await f.peer(r.guestPath, r.guestToken);
  await host.next(); await guest.next();
  const closures = await Promise.all([closed(host), closed(guest)]);
  assert.deepEqual(closures.map(value => value[0]), [1001, 1001]);
});

test('normal ping receives exactly one matching pong, including empty and 125-byte payloads', async t => {
  const f = await fixture(t);
  const { host } = await f.pair(await f.room());
  let replies = 0;
  host.on('pong', () => replies++);
  for (const payload of [Buffer.alloc(0), randomBytes(125)]) {
    const reply = once(host, 'pong', { signal: AbortSignal.timeout(TIMEOUT) });
    host.ping(payload);
    assert.deepEqual((await reply)[0], payload);
  }
  await delay(10);
  assert.equal(replies, 2);
  assert.equal(f.relay.stats().rooms, 1);
});

test('excess empty ping closes both peers rather than producing unlimited pong writes', async t => {
  const f = await fixture(t);
  const { host, guest } = await f.pair(await f.room());
  const closures = [closed(host), closed(guest)];
  for (let i = 0; i < 40; i++) host.ping();
  const results = await Promise.all(closures);
  assert.deepEqual(results.map(value => value[0]), [1008, 1008]);
  assert.equal(results[1][1].toString(), 'Control frame rate limit');
  assert.equal(f.relay.stats().rooms, 0);
});

test('unsolicited pong shares the same bounded control-frame budget', async t => {
  const f = await fixture(t, { controlFramesPerSecond: 1, controlBurst: 2 });
  const { host, guest } = await f.pair(await f.room());
  const closures = [closed(host), closed(guest)];
  host.ping();
  host.pong();
  host.pong();
  assert.deepEqual((await Promise.all(closures)).map(value => value[0]), [1008, 1008]);
});

async function stallHostTransport(f, r, t) {
  let transport;
  f.relay.server.on('upgrade', (req, socket) => {
    if (req.url === r.hostPath) transport = socket;
  });
  const pair = await f.pair(r);
  const realWrite = transport.write;
  transport.write = () => false;
  t.after(() => { transport.write = realWrite; });
  return pair;
}

test('a stalled pong write uses the write timeout and closes the counterpart', async t => {
  const f = await fixture(t, { writeTimeoutMs: 40 });
  const { host, guest } = await stallHostTransport(f, await f.room(), t);
  const closures = [closed(host), closed(guest)];
  host.ping();
  const [, guestClose] = await Promise.all(closures);
  assert.equal(guestClose[0], 1013);
  assert.equal(guestClose[1].toString(), 'Write timeout');
  await eventually(() => f.relay.stats().connections === 0);
});

test('empty pong replies consume pending-write capacity even with zero payload bytes', async t => {
  const f = await fixture(t, { maxPendingWrites: 2 });
  const { host, guest } = await stallHostTransport(f, await f.room(), t);
  const closures = [closed(host), closed(guest)];
  host.ping(); host.ping(); host.ping();
  const [, guestClose] = await Promise.all(closures);
  assert.equal(guestClose[0], 1013);
  assert.equal(guestClose[1].toString(), 'Backpressure limit');
  await eventually(() => f.relay.stats().connections === 0);
});

test('pong payload and frame overhead count toward the byte buffer cap', async t => {
  const f = await fixture(t, { maxBufferedBytes: 64 });
  const { host, guest } = await f.pair(await f.room());
  const closures = [closed(host), closed(guest)];
  host.ping(Buffer.alloc(64));
  const results = await Promise.all(closures);
  assert.deepEqual(results.map(value => value[0]), [1013, 1013]);
  assert.equal(results[1][1].toString(), 'Backpressure limit');
});

test('a stalled transport write reaches timeout and releases the entire room', async t => {
  const f = await fixture(t, { writeTimeoutMs: 40 });
  const r = await f.room();
  let guestTransport;
  f.relay.server.on('upgrade', (req, socket) => {
    if (req.url === r.guestPath) guestTransport = socket;
  });
  const { host, guest } = await f.pair(r);
  // Simulate a TCP write which never flushes, independent of OS kernel buffer size.
  const realWrite = guestTransport.write;
  guestTransport.write = () => false;
  t.after(() => { guestTransport.write = realWrite; });
  const closures = [closed(host), closed(guest)];
  host.send(Buffer.from('blocked'));
  const [hostClose] = await Promise.all(closures);
  assert.equal(hostClose[0], 1013);
  await eventually(() => f.relay.stats().connections === 0);
  assert.equal(f.relay.stats().rooms, 0);
});

test('restarts invalidate old rooms and configured caps cannot exceed hard ceilings', async t => {
  const first = await fixture(t);
  const room = await first.room();
  const second = await fixture(t);
  assert.equal(await second.rejected(room.hostPath, room.hostToken), 404);
  for (const options of [{ maxRooms: 17 }, { maxConnections: 33 }, { roomTtlMs: 600001 }, { sessionMaxAgeMs: 86400001 }]) {
    assert.throws(() => createRelay({ ownerToken: OWNER, ...options }), /Invalid limit/);
  }
});

const newRoute = (expiresAt = Date.now() + 60_000) => ({
  routeId: randomBytes(24).toString('base64url'), routeToken: randomBytes(32).toString('base64url'), expiresAt,
});
const ownerRequest = (method = 'GET', body) => ({
  method, headers: { Authorization: `Bearer ${OWNER}` }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
const guestRequest = route => ({ method: 'POST', headers: { Authorization: `Bearer ${route.routeToken}` } });

test('rendezvous registration and tickets are owner-only; credentials cannot be replaced', async t => {
  const f = await fixture(t);
  const route = newRoute();
  assert.equal((await f.request('/v1/routes', { method: 'POST', body: JSON.stringify(route) })).status, 401);
  assert.equal((await f.request('/v1/routes', ownerRequest('POST', route))).status, 200);
  assert.equal((await f.request('/v1/routes', ownerRequest('POST', route))).status, 200);
  assert.equal((await f.request('/v1/routes', ownerRequest('POST', { ...route, routeToken: BAD }))).status, 409);
  assert.equal((await f.request('/v1/pending', { headers: { Authorization: `Bearer ${route.routeToken}` } })).status, 401);
  assert.equal((await f.request(`/v1/routes/${route.routeId}`, {
    method: 'DELETE', headers: { Authorization: `Bearer ${route.routeToken}` },
  })).status, 401);
  assert.equal((await f.request(`/v1/routes/${route.routeId}/connect`, {
    method: 'POST', headers: { Authorization: `Bearer ${BAD}` },
  })).status, 401);
  assert.equal((await f.request('/v1/routes', ownerRequest('POST', { ...route, target: '127.0.0.1:22' }))).status, 400);
  assert.equal((await f.request('/v1/routes', ownerRequest('POST', { ...route, routeToken: [route.routeToken] }))).status, 400);
});

test('owner verification authenticates without consuming tickets or declaring owner online', async t => {
  const f = await fixture(t);
  const route = newRoute();
  await f.request('/v1/routes', ownerRequest('POST', route));
  for (const token of [undefined, BAD, route.routeToken]) {
    assert.equal((await f.request('/v1/owner', {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    })).status, 401);
  }
  const response = await f.request('/v1/owner', ownerRequest());
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: 'ok' });
  assert.equal((await f.request(`/v1/routes/${route.routeId}/connect`, guestRequest(route))).status, 503);
  await f.request('/v1/pending', ownerRequest());
  assert.equal((await f.request(`/v1/routes/${route.routeId}/connect`, guestRequest(route))).status, 201);
  assert.equal(f.relay.stats().pending, 1);
  assert.equal((await f.request('/v1/owner', ownerRequest())).status, 200);
  assert.equal(f.relay.stats().pending, 1);
  assert.equal((await (await f.request('/v1/pending', ownerRequest())).json()).tickets.length, 1);
});

test('same route creates a fresh room after disconnect without reissuing invitation', async t => {
  const f = await fixture(t);
  const route = newRoute();
  await f.request('/v1/routes', ownerRequest('POST', route));
  await f.request('/v1/pending', ownerRequest());
  let previousRoom;
  for (let i = 0; i < 2; i++) {
    const response = await f.request(`/v1/routes/${route.routeId}/connect`, guestRequest(route));
    assert.equal(response.status, 201);
    const guestTicket = await response.json();
    assert.equal(guestTicket.hostToken, undefined);
    assert.equal(guestTicket.hostPath, undefined);
    assert.notEqual(guestTicket.roomId, previousRoom);
    previousRoom = guestTicket.roomId;
    const { tickets } = await (await f.request('/v1/pending', ownerRequest())).json();
    assert.equal(tickets.length, 1);
    assert.equal(tickets[0].routeId, route.routeId);
    assert.equal(tickets[0].guestToken, undefined);
    assert.equal(tickets[0].roomId, guestTicket.roomId);
    const { host, guest } = await f.pair({ ...tickets[0], ...guestTicket });
    const close = [closed(host), closed(guest)]; host.close(); await Promise.all(close);
  }
  assert.equal(f.relay.stats().routes, 1);
  assert.equal(f.relay.stats().rooms, 0);
});

test('offline owner blocks guest allocation and pending queue expires with room', async t => {
  const f = await fixture(t, { ownerOfflineMs: 40, routeRoomTtlMs: 80 });
  const route = newRoute();
  await f.request('/v1/routes', ownerRequest('POST', route));
  assert.equal((await f.request(`/v1/routes/${route.routeId}/connect`, guestRequest(route))).status, 503);
  await f.request('/v1/pending', ownerRequest());
  assert.equal((await f.request(`/v1/routes/${route.routeId}/connect`, guestRequest(route))).status, 201);
  assert.equal(f.relay.stats().pending, 1);
  await delay(100);
  assert.equal(f.relay.stats().pending, 0);
  assert.equal(f.relay.stats().rooms, 0);
  assert.equal((await f.request(`/v1/routes/${route.routeId}/connect`, guestRequest(route))).status, 503);
});

test('route revocation and expiry close associated sessions and remove pending tickets', async t => {
  const f = await fixture(t);
  for (const expire of [false, true]) {
    const route = newRoute(Date.now() + (expire ? 120 : 60_000));
    await f.request('/v1/routes', ownerRequest('POST', route));
    await f.request('/v1/pending', ownerRequest());
    const guestTicket = await (await f.request(`/v1/routes/${route.routeId}/connect`, guestRequest(route))).json();
    const { tickets } = await (await f.request('/v1/pending', ownerRequest())).json();
    const { host, guest } = await f.pair({ ...tickets[0], ...guestTicket });
    const closures = [closed(host), closed(guest)];
    if (!expire) assert.equal((await f.request(`/v1/routes/${route.routeId}`, ownerRequest('DELETE'))).status, 200);
    assert.deepEqual((await Promise.all(closures)).map(value => value[0]), [1008, 1008]);
    assert.equal((await f.request(`/v1/routes/${route.routeId}/connect`, guestRequest(route))).status, 404);
    assert.equal(f.relay.stats().pending, 0);
  }
});

test('route/room quotas and guest request rate are bounded without refresh resetting rate', async t => {
  const f = await fixture(t, { maxRoutes: 1, routeConnectBurst: 1 });
  const route = newRoute();
  await f.request('/v1/routes', ownerRequest('POST', route));
  assert.equal((await f.request('/v1/routes', ownerRequest('POST', newRoute()))).status, 429);
  assert.equal((await f.request('/v1/routes', ownerRequest('POST', { ...route, expiresAt: Date.now() + 8 * 86400_000 }))).status, 400);
  await f.request('/v1/pending', ownerRequest());
  assert.equal((await f.request(`/v1/routes/${route.routeId}/connect`, guestRequest(route))).status, 201);
  await f.request('/v1/routes', ownerRequest('POST', route));
  assert.equal((await f.request(`/v1/routes/${route.routeId}/connect`, guestRequest(route))).status, 429);
  await f.request(`/v1/routes/${route.routeId}`, ownerRequest('DELETE'));
  assert.equal(f.relay.stats().pending, 0);
  assert.equal(f.relay.stats().rooms, 0);
  assert.equal(f.relay.stats().routes, 0);
});

test('owner can restore the same route credentials after a relay restart', async t => {
  const first = await fixture(t);
  const route = newRoute();
  await first.request('/v1/routes', ownerRequest('POST', route));
  const second = await fixture(t);
  assert.equal((await second.request(`/v1/routes/${route.routeId}/connect`, guestRequest(route))).status, 404);
  await second.request('/v1/routes', ownerRequest('POST', route));
  await second.request('/v1/pending', ownerRequest());
  assert.equal((await second.request(`/v1/routes/${route.routeId}/connect`, guestRequest(route))).status, 201);
});
