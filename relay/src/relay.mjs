import http from 'node:http';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { constants, openSync, fstatSync, readFileSync, closeSync } from 'node:fs';
import { isIP } from 'node:net';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { WebSocket, WebSocketServer } from 'ws';

const MiB = 1024 * 1024;
const DEFAULTS = Object.freeze({
  maxRooms: 16, maxConnections: 32, maxPayload: 64 * 1024,
  maxBufferedBytes: MiB, bytesPerSecond: 4 * MiB, burstBytes: MiB,
  roomTtlMs: 10 * 60 * 1000, sessionMaxAgeMs: 24 * 60 * 60 * 1000,
  writeTimeoutMs: 10_000, heartbeatMs: 20_000, closeGraceMs: 1000,
  controlFramesPerSecond: 20, controlBurst: 20, maxPendingWrites: 1024,
  maxRoutes: 64, routeMaxAgeMs: 7 * 24 * 60 * 60 * 1000,
  ownerOfflineMs: 10_000, routeRoomTtlMs: 30_000,
  routeConnectBurst: 3, routeConnectsPerMinute: 12,
});
const TOKEN = /^[A-Za-z0-9_-]{32,128}$/;
const ROOM_PATH = /^\/v1\/rooms\/([A-Za-z0-9_-]{32})\/(host|guest)$/;
const hash = value => createHash('sha256').update(value).digest();
const secret = () => randomBytes(32).toString('base64url');
const arm = (fn, ms) => { const timer = setTimeout(fn, ms); timer.unref(); return timer; };

function normalizeIp(value) {
  if (typeof value !== 'string') return null;
  const address = value.trim();
  if (!address || address.includes(',')) return null;
  if (address.toLowerCase().startsWith('::ffff:')) {
    const mapped = address.slice(7);
    if (isIP(mapped) === 4) return mapped;
  }
  return isIP(address) ? address : null;
}

function isLoopback(address) {
  if (address === '::1') return true;
  if (isIP(address) !== 4) return false;
  const first = Number(address.split('.', 1)[0]);
  return first === 127;
}

// Nginx overwrites X-Forwarded-For with $remote_addr and is the only production
// peer of this loopback-bound service. Never trust a forwarded value arriving
// through any other network peer or a list assembled by arbitrary proxies.
export function forwardedGuestIp(remoteAddress, forwardedFor) {
  const peer = normalizeIp(remoteAddress);
  if (!peer || !isLoopback(peer) || typeof forwardedFor !== 'string') return null;
  return normalizeIp(forwardedFor);
}

// Open without following symlinks, then inspect the opened file to avoid a stat/open race.
export function readOwnerTokenFile(path) {
  if (!path) throw new Error('RELAY_OWNER_TOKEN_FILE is required');
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || (stat.mode & 0o777) !== 0o600 || stat.size > 4096) {
      throw new Error('Owner token must be a regular 0600 file');
    }
    const token = readFileSync(fd, 'utf8').trim();
    if (!TOKEN.test(token)) throw new Error('Owner token has invalid format');
    return token;
  } finally { closeSync(fd); }
}

function bearer(req) {
  let count = 0;
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    if (req.rawHeaders[i].toLowerCase() === 'authorization') count += 1;
  }
  if (count !== 1) return null;
  const match = /^Bearer ([A-Za-z0-9_-]{32,128})$/.exec(req.headers.authorization ?? '');
  return match?.[1] ?? null;
}

function authorized(req, digest) {
  const token = bearer(req);
  return token !== null && timingSafeEqual(hash(token), digest);
}

function safePath(req) {
  // No query parameters, Origin-based browser access, or absolute-form proxy requests.
  return !('origin' in req.headers) && /^\/[A-Za-z0-9_\/-]*$/.test(req.url ?? '');
}

function json(res, status, value) {
  res.writeHead(status, {
    'Content-Type': 'application/json', 'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(JSON.stringify(value));
}

function rejectUpgrade(socket, status) {
  const reason = http.STATUS_CODES[status] ?? 'Rejected';
  socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

/**
 * Opaque binary room relay. This module does not implement end-to-end encryption:
 * clients must run their authenticated inner TLS protocol over the binary stream.
 * Options may REDUCE production limits for tests; they cannot raise hard limits.
 */
export function createRelay(options = {}) {
  const ownerToken = options.ownerToken ?? readOwnerTokenFile(process.env.RELAY_OWNER_TOKEN_FILE);
  if (!TOKEN.test(ownerToken)) throw new Error('Owner token has invalid format');
  const ownerDigest = hash(ownerToken);
  const limits = {};
  for (const [key, maximum] of Object.entries(DEFAULTS)) {
    const value = options[key] ?? maximum;
    if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
      throw new Error(`Invalid limit: ${key}`);
    }
    limits[key] = value;
  }
  const rooms = new Map();
  const routes = new Map();
  let pending = [];
  let lastOwnerPoll = -Infinity;
  let shuttingDown = false;
  const wss = new WebSocketServer({
    noServer: true, clientTracking: true, perMessageDeflate: false, autoPong: false,
    maxPayload: limits.maxPayload, maxFragments: 128, maxBufferedChunks: 128,
  });
  const sockets = new Set();

  function removeRoom(room, code = 1000, reason = 'Room closed') {
    if (room.closed) return;
    room.closed = true;
    room.ready = false;
    clearTimeout(room.expiryTimer);
    rooms.delete(room.id);
    pending = pending.filter(ticket => ticket.roomId !== room.id);
    for (const timer of room.writeTimers) clearTimeout(timer);
    room.writeTimers.clear();
    for (const ws of [room.host, room.guest]) {
      if (!ws) continue;
      if (ws.readyState === WebSocket.OPEN) ws.close(code, reason);
      if (ws.readyState !== WebSocket.CLOSED) {
        const timer = arm(() => ws.terminate(), limits.closeGraceMs);
        ws.once('close', () => clearTimeout(timer));
      }
    }
  }

  function removeRoute(route) {
    routes.delete(route.id);
    clearTimeout(route.expiryTimer);
    for (const room of [...rooms.values()]) {
      if (room.routeId === route.id) removeRoom(room, 1008, 'Route revoked or expired');
    }
  }

  function newRoom(route) {
    const id = randomBytes(24).toString('base64url');
    const hostToken = secret();
    const guestToken = secret();
    const expiresAt = route
      ? Math.min(Date.now() + limits.routeRoomTtlMs, route.expiresAt)
      : Date.now() + limits.roomTtlMs;
    const room = {
      id, routeId: route?.id ?? null, hostDigest: hash(hostToken), guestDigest: hash(guestToken),
      host: null, guest: null, closed: false, ready: false, expiresAt,
      pendingBytes: 0, writeTimers: new Set(), credit: limits.burstBytes,
      refilledAt: performance.now(),
    };
    room.expiryTimer = arm(() => removeRoom(room, 1001, 'Pairing expired'), expiresAt - Date.now());
    rooms.set(id, room);
    return {
      roomId: id, hostToken, guestToken,
      hostPath: `/v1/rooms/${id}/host`, guestPath: `/v1/rooms/${id}/guest`,
      expiresAt, sessionMaxAgeMs: limits.sessionMaxAgeMs,
    };
  }

  function readBody(req, res, maximum, callback) {
    let body = '';
    let failed = false;
    req.setEncoding('utf8');
    req.on('data', chunk => {
      if (failed) return;
      body += chunk;
      if (Buffer.byteLength(body) > maximum) {
        failed = true;
        json(res, 413, { error: 'Body too large' });
      }
    });
    req.on('error', () => { failed = true; });
    req.on('end', () => {
      if (failed || res.destroyed) return;
      if (shuttingDown) { json(res, 503, { error: 'Unavailable' }); return; }
      callback(body);
    });
  }

  // Every application-generated frame uses the same bounded write path, including
  // pong replies and server heartbeats. Count frame overhead and pending writes:
  // a tiny/empty frame must not create unaccounted timers and callback objects.
  function send(room, ws, data, binary, kind = 'message') {
    if (room.closed) return;
    const payloadSize = Buffer.byteLength(data);
    const size = payloadSize + (payloadSize > 65535 ? 10 : payloadSize > 125 ? 4 : 2);
    const transportBuffered = (room.host?.bufferedAmount ?? 0) + (room.guest?.bufferedAmount ?? 0);
    if (ws.readyState !== WebSocket.OPEN ||
        room.writeTimers.size >= limits.maxPendingWrites ||
        room.pendingBytes + size > limits.maxBufferedBytes ||
        transportBuffered + size > limits.maxBufferedBytes) {
      removeRoom(room, 1013, 'Backpressure limit');
      return;
    }
    room.pendingBytes += size;
    const timer = arm(() => removeRoom(room, 1013, 'Write timeout'), limits.writeTimeoutMs);
    room.writeTimers.add(timer);
    try {
      const done = error => {
        clearTimeout(timer);
        room.writeTimers.delete(timer);
        room.pendingBytes -= size;
        if (error) removeRoom(room, 1011, 'Transport error');
      };
      if (kind === 'ping') ws.ping(data, false, done);
      else if (kind === 'pong') ws.pong(data, false, done);
      else ws.send(data, { binary, compress: false }, done);
    } catch {
      clearTimeout(timer);
      room.writeTimers.delete(timer);
      room.pendingBytes -= size;
      removeRoom(room, 1011, 'Transport error');
    }
  }

  function attach(room, role, ws) {
    room[role] = ws;
    ws.isAlive = true;
    let controlCredit = limits.controlBurst;
    let controlRefilledAt = performance.now();
    function acceptControl() {
      if (room.closed) return false;
      const now = performance.now();
      controlCredit = Math.min(limits.controlBurst,
        controlCredit + (now - controlRefilledAt) * limits.controlFramesPerSecond / 1000);
      controlRefilledAt = now;
      if (controlCredit < 1) {
        removeRoom(room, 1008, 'Control frame rate limit');
        return false;
      }
      controlCredit -= 1;
      return true;
    }
    ws.on('ping', data => {
      if (acceptControl()) send(room, ws, data, false, 'pong');
    });
    ws.on('pong', () => { if (acceptControl()) ws.isAlive = true; });
    ws.on('error', error => removeRoom(room,
      error.code === 'WS_ERR_UNSUPPORTED_MESSAGE_LENGTH' ? 1009 : 1011,
      error.code === 'WS_ERR_UNSUPPORTED_MESSAGE_LENGTH' ? 'Message too large' : 'Transport error'));
    ws.on('close', () => removeRoom(room, 1000, 'Peer disconnected'));
    ws.on('message', (data, isBinary) => {
      if (room.closed) return;
      if (!room.ready || !isBinary) {
        removeRoom(room, 1008, room.ready ? 'Binary messages required' : 'Wait for ready');
        return;
      }
      if (data.length === 0) {
        removeRoom(room, 1008, 'Empty messages forbidden');
        return;
      }
      const now = performance.now();
      room.credit = Math.min(limits.burstBytes,
        room.credit + (now - room.refilledAt) * limits.bytesPerSecond / 1000);
      room.refilledAt = now;
      if (data.length > room.credit) {
        removeRoom(room, 1008, 'Room rate limit');
        return;
      }
      room.credit -= data.length;
      send(room, room[role === 'host' ? 'guest' : 'host'], data, true);
    });
    if (room.host && room.guest) {
      clearTimeout(room.expiryTimer);
      room.expiryTimer = arm(() => removeRoom(room, 1001, 'Session expired'), limits.sessionMaxAgeMs);
      room.ready = true;
      send(room, room.host, '{"type":"ready"}', false);
      send(room, room.guest, '{"type":"ready"}', false);
    }
  }

  const server = http.createServer({ maxHeaderSize: 8192 }, (req, res) => {
    if (shuttingDown) { json(res, 503, { error: 'Unavailable' }); return; }
    if (!safePath(req)) { json(res, 400, { error: 'Invalid request' }); return; }
    if (req.method === 'GET' && req.url === '/healthz') {
      json(res, 200, { status: 'ok' }); return;
    }
    if (req.method === 'GET' && req.url === '/v1/owner') {
      if (!authorized(req, ownerDigest)) { json(res, 401, { error: 'Unauthorized' }); return; }
      // Credential verification must neither drain tickets nor mark an owner online.
      json(res, 200, { status: 'ok' }); return;
    }
    if (req.method === 'POST' && req.url === '/v1/routes') {
      if (!authorized(req, ownerDigest)) {
        json(res, 401, { error: 'Unauthorized' }); req.resume(); return;
      }
      readBody(req, res, 1024, body => {
        let value;
        try { value = JSON.parse(body); } catch { json(res, 400, { error: 'Invalid route' }); return; }
        const now = Date.now();
        if (!value || typeof value !== 'object' || Array.isArray(value)
            || typeof value.routeId !== 'string' || typeof value.routeToken !== 'string'
            || Object.keys(value).sort().join(',') !== 'expiresAt,routeId,routeToken'
            || !/^[A-Za-z0-9_-]{32}$/.test(value.routeId) || !TOKEN.test(value.routeToken)
            || !Number.isSafeInteger(value.expiresAt) || value.expiresAt <= now
            || value.expiresAt > now + limits.routeMaxAgeMs) {
          json(res, 400, { error: 'Invalid route' }); return;
        }
        let route = routes.get(value.routeId);
        if (route && !timingSafeEqual(route.tokenDigest, hash(value.routeToken))) {
          json(res, 409, { error: 'Route credentials conflict' }); return;
        }
        if (!route && routes.size >= limits.maxRoutes) {
          json(res, 429, { error: 'Route limit' }); return;
        }
        if (!route) route = {
          id: value.routeId, tokenDigest: hash(value.routeToken),
          credit: limits.routeConnectBurst, refilledAt: performance.now(),
        };
        clearTimeout(route.expiryTimer);
        route.expiresAt = value.expiresAt;
        route.expiryTimer = arm(() => removeRoute(route), route.expiresAt - now);
        routes.set(route.id, route);
        json(res, 200, { status: 'ok' });
      });
      return;
    }
    if (req.method === 'GET' && req.url === '/v1/pending') {
      if (!authorized(req, ownerDigest)) { json(res, 401, { error: 'Unauthorized' }); return; }
      lastOwnerPoll = performance.now();
      const tickets = pending.filter(ticket => rooms.has(ticket.roomId));
      pending = [];
      json(res, 200, { tickets }); return;
    }
    const routeMatch = /^\/v1\/routes\/([A-Za-z0-9_-]{32})(\/connect)?$/.exec(req.url);
    if (routeMatch && req.method === 'DELETE' && !routeMatch[2]) {
      if (!authorized(req, ownerDigest)) { json(res, 401, { error: 'Unauthorized' }); return; }
      const route = routes.get(routeMatch[1]);
      if (route) removeRoute(route);
      json(res, 200, { status: 'ok' }); return;
    }
    if (routeMatch && req.method === 'POST' && routeMatch[2]) {
      const route = routes.get(routeMatch[1]);
      if (!route) { json(res, 404, { error: 'Route unavailable' }); req.resume(); return; }
      if (!authorized(req, route.tokenDigest)) {
        json(res, 401, { error: 'Unauthorized' }); req.resume(); return;
      }
      const guestIp = forwardedGuestIp(req.socket.remoteAddress, req.headers['x-forwarded-for']);
      readBody(req, res, 256, body => {
        if (body.trim() !== '' && body.trim() !== '{}') {
          json(res, 400, { error: 'Body must be empty or {}' }); return;
        }
        if (routes.get(route.id) !== route || route.expiresAt <= Date.now()) {
          json(res, 410, { error: 'Route expired' }); return;
        }
        const now = performance.now();
        if (now - lastOwnerPoll > limits.ownerOfflineMs) {
          json(res, 503, { error: 'Owner offline' }); return;
        }
        route.credit = Math.min(limits.routeConnectBurst,
          route.credit + (now - route.refilledAt) * limits.routeConnectsPerMinute / 60_000);
        route.refilledAt = now;
        if (route.credit < 1 || rooms.size >= limits.maxRooms || pending.length >= limits.maxRooms) {
          json(res, 429, { error: 'Connection limit' }); return;
        }
        route.credit -= 1;
        const ticket = newRoom(route);
        // Only this short-lived owner queue retains the host bearer token and
        // optional proxy-attested guest address. Neither is returned to guests.
        pending.push({ routeId: route.id, roomId: ticket.roomId,
          hostPath: ticket.hostPath, hostToken: ticket.hostToken, expiresAt: ticket.expiresAt,
          ...(guestIp ? { guestIp } : {}) });
        json(res, 201, { roomId: ticket.roomId, guestPath: ticket.guestPath,
          guestToken: ticket.guestToken, expiresAt: ticket.expiresAt });
      });
      return;
    }
    if (req.method !== 'POST' || req.url !== '/v1/rooms') {
      json(res, 404, { error: 'Not found' }); return;
    }
    if (!authorized(req, ownerDigest)) {
      json(res, 401, { error: 'Unauthorized' }); req.resume(); return;
    }
    let body = '';
    let tooLarge = false;
    req.setEncoding('utf8');
    req.on('data', chunk => {
      if (tooLarge) return;
      body += chunk;
      if (Buffer.byteLength(body) > 256) {
        tooLarge = true;
        json(res, 413, { error: 'Body too large' });
      }
    });
    req.on('end', () => {
      if (tooLarge || res.destroyed) return;
      // There are deliberately no client-defined destinations or creation settings.
      if (body.trim() !== '' && body.trim() !== '{}') {
        json(res, 400, { error: 'Body must be empty or {}' }); return;
      }
      if (shuttingDown) { json(res, 503, { error: 'Unavailable' }); return; }
      if (rooms.size >= limits.maxRooms) { json(res, 429, { error: 'Room limit' }); return; }
      json(res, 201, newRoom());
    });
    req.on('error', () => { /* No request contents or credentials are logged. */ });
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5000;
  server.maxRequestsPerSocket = 100;
  server.maxConnections = 96;
  server.on('connection', socket => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.once('close', () => sockets.delete(socket));
  });
  server.on('clientError', (_error, socket) => rejectUpgrade(socket, 400));
  server.on('upgrade', (req, socket, head) => {
    if (shuttingDown) { rejectUpgrade(socket, 503); return; }
    if (req.method !== 'GET' || !safePath(req) || 'sec-websocket-protocol' in req.headers) {
      rejectUpgrade(socket, 400); return;
    }
    const match = ROOM_PATH.exec(req.url);
    if (!match) { rejectUpgrade(socket, 404); return; }
    const [, id, role] = match;
    const room = rooms.get(id);
    if (!room || room.closed) { rejectUpgrade(socket, 404); return; }
    if (!authorized(req, room[`${role}Digest`])) { rejectUpgrade(socket, 401); return; }
    if (!room.ready && Date.now() >= room.expiresAt) {
      removeRoom(room, 1001, 'Pairing expired'); rejectUpgrade(socket, 410); return;
    }
    if (room[role]) { rejectUpgrade(socket, 409); return; }
    if (wss.clients.size >= limits.maxConnections) { rejectUpgrade(socket, 429); return; }
    // handleUpgrade is synchronous here: no async verifier can race the slot check.
    wss.handleUpgrade(req, socket, head, ws => attach(room, role, ws));
  });
  const heartbeat = setInterval(() => {
    for (const room of rooms.values()) {
      for (const ws of [room.host, room.guest]) {
        if (!ws || room.closed) continue;
        if (!ws.isAlive) { removeRoom(room, 1001, 'Heartbeat timeout'); break; }
        ws.isAlive = false;
        send(room, ws, Buffer.alloc(0), false, 'ping');
      }
    }
  }, limits.heartbeatMs);
  heartbeat.unref();

  return {
    server,
    // Aggregate counts only; never expose tokens or room objects through diagnostics.
    stats: () => ({ rooms: rooms.size, connections: wss.clients.size, routes: routes.size, pending: pending.length }),
    async listen(port = 8787) {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve(); });
      });
      return server.address();
    },
    async close() {
      shuttingDown = true;
      clearInterval(heartbeat);
      for (const route of [...routes.values()]) removeRoute(route);
      for (const room of [...rooms.values()]) removeRoom(room, 1001, 'Service stopping');
      for (const ws of wss.clients) ws.terminate();
      for (const socket of sockets) socket.destroy();
      await new Promise(resolve => wss.close(resolve));
      if (server.listening) await new Promise(resolve => server.close(resolve));
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const relay = createRelay();
    await relay.listen();
    console.log('RackTop relay listening on 127.0.0.1:8787');
    let stopping = false;
    const stop = () => {
      if (stopping) return;
      stopping = true;
      relay.close().then(() => process.exit(0), () => process.exit(1));
    };
    process.on('SIGTERM', stop);
    process.on('SIGINT', stop);
  } catch {
    console.error('RackTop relay startup failed; check configuration and token file permissions');
    process.exitCode = 1;
  }
}
