#!/usr/bin/env node
/**
 * Public relay smoke probe. Usage: node scripts/smoke.mjs https://RELAY_IP < owner-token-file
 * Token input must be a pipe/file; it is never echoed or written by this script.
 * Requires Node >=20, ws, and the openssl executable. Outer HTTPS/WSS uses normal
 * CA/hostname verification. NODE_EXTRA_CA_CERTS is useful only for a local fixture.
 * Inner TLS identities below are disposable test identities, not RackTop users.
 * A pass proves relay transport feasibility, not an implemented RackTop E2E feature.
 */
import https from 'node:https';
import tls from 'node:tls';
import { Duplex } from 'node:stream';
import { randomBytes, createHash } from 'node:crypto';
import { mkdtemp, chmod, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { WebSocket } from 'ws';

const execute = promisify(execFile);
const CHUNK = 32 * 1024; // Below the relay's hard 64 KiB message limit, including TLS traffic.
const PAYLOAD_BYTES = 256 * 1024;
const STEP_TIMEOUT_MS = 8000;
const TOTAL_TIMEOUT_MS = 45_000;
const TOKEN = /^[A-Za-z0-9_-]{32,128}$/;
const SERVER_NAME = 'racktop-smoke.invalid';
const sockets = new Set();
const streams = new Set();
const requests = new Set();
const timers = new Set();
const abort = new AbortController();
let temporaryDirectory;
let testKey;
let stage = 'input';
let passed = 0;
let verifiedBytes = 0;

// All errors visible to callers are fixed labels. Never print Error.message,
// request objects, URLs returned by the service, headers, or certificate material.
function fault(code) { const error = new Error(code); error.safeCode = code; return error; }
function expect(value, code) { if (!value) throw fault(code); }
function announce(name, details = '') { passed++; console.log(`PASS ${name}${details ? ` ${details}` : ''}`); }
function bounded(work, duration = STEP_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    if (abort.signal.aborted) { reject(fault('TOTAL_TIMEOUT')); return; }
    let settled = false;
    const complete = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer); timers.delete(timer);
      abort.signal.removeEventListener('abort', onAbort);
      error ? reject(error) : resolve(value);
    };
    const onAbort = () => complete(fault('TOTAL_TIMEOUT'));
    const timer = setTimeout(() => complete(fault('STEP_TIMEOUT')), duration);
    timers.add(timer);
    abort.signal.addEventListener('abort', onAbort, { once: true });
    try { work(complete); } catch { complete(fault('OPERATION_FAILED')); }
  });
}

async function ownerTokenFromStdin() {
  expect(!process.stdin.isTTY, 'PIPE_OWNER_TOKEN_ON_STDIN');
  return bounded(done => {
    let input = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => {
      input += chunk;
      if (input.length > 1024) { process.stdin.pause(); done(fault('INVALID_OWNER_TOKEN')); }
    });
    process.stdin.once('error', () => done(fault('STDIN_FAILED')));
    process.stdin.once('end', () => {
      const value = input.trim(); input = '';
      done(TOKEN.test(value) ? null : fault('INVALID_OWNER_TOKEN'), value);
    });
  });
}

function request(base, path, { token, method = 'GET', body } = {}) {
  return bounded(done => {
    const headers = { Accept: 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(body);
    }
    const req = https.request(new URL(path, base), {
      method, headers, signal: abort.signal, rejectUnauthorized: true,
      timeout: STEP_TIMEOUT_MS,
    }, res => {
      let chunks = []; let size = 0;
      res.on('data', chunk => {
        size += chunk.length;
        if (size > 16 * 1024) { req.destroy(); done(fault('RESPONSE_TOO_LARGE')); return; }
        chunks.push(chunk);
      });
      res.once('error', () => done(fault('HTTP_RESPONSE_FAILED')));
      res.once('end', () => {
        let json;
        try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* Status is still usable. */ }
        chunks = [];
        done(null, { status: res.statusCode, json });
      });
    });
    requests.add(req);
    req.once('close', () => requests.delete(req));
    req.once('error', () => done(fault('HTTPS_FAILED')));
    req.once('timeout', () => { req.destroy(); done(fault('HTTPS_TIMEOUT')); });
    req.end(body);
  });
}

async function newRoom(base, ownerToken) {
  const { status, json: room } = await request(base, '/v1/rooms', { method: 'POST', token: ownerToken, body: '{}' });
  expect(status === 201 && room && typeof room === 'object', 'ROOM_CREATE_FAILED');
  expect(/^[A-Za-z0-9_-]{32}$/.test(room.roomId) && TOKEN.test(room.hostToken) && TOKEN.test(room.guestToken), 'INVALID_ROOM_RESPONSE');
  expect(room.hostToken !== room.guestToken, 'ROLE_TOKENS_IDENTICAL');
  expect(room.hostPath === `/v1/rooms/${room.roomId}/host` && room.guestPath === `/v1/rooms/${room.roomId}/guest`, 'INVALID_ROOM_PATHS');
  expect(Number.isFinite(room.expiresAt) && room.expiresAt > Date.now() && Number.isFinite(room.sessionMaxAgeMs) && room.sessionMaxAgeMs > 0, 'INVALID_ROOM_LIFETIME');
  return room;
}

function connect(base, path, token, rejection = false) {
  return bounded(done => {
    const url = new URL(path, base); url.protocol = 'wss:';
    const ws = new WebSocket(url, {
      headers: { Authorization: `Bearer ${token}` },
      rejectUnauthorized: true,
      perMessageDeflate: false,
      maxPayload: 64 * 1024,
      handshakeTimeout: STEP_TIMEOUT_MS,
      followRedirects: false,
    });
    sockets.add(ws);
    ws.on('error', () => {}); // Closed/destroyed transports must never emit uncaught errors.
    ws.once('close', () => sockets.delete(ws));
    const failed = () => done(fault('WSS_FAILED'));
    ws.once('error', failed);
    ws.once('unexpected-response', (_req, res) => {
      res.resume();
      if (rejection && (res.statusCode === 401 || res.statusCode === 403)) done(null, true);
      else done(fault('WSS_UPGRADE_REJECTED'));
      ws.terminate();
    });
    if (rejection) {
      ws.once('open', () => { done(fault('ROLE_ESCALATION_ACCEPTED')); ws.terminate(); });
      return;
    }
    const earlyClose = () => done(fault('CLOSED_BEFORE_READY'));
    ws.once('close', earlyClose);
    const ready = (data, binary) => {
      let message;
      try { if (!binary) message = JSON.parse(data.toString('utf8')); } catch { /* Invalid ready is rejected. */ }
      if (binary || message?.type !== 'ready') { done(fault('INVALID_READY')); return; }
      ws.off('message', ready); ws.off('error', failed); ws.off('close', earlyClose);
      done(null, ws);
    };
    ws.on('message', ready);
  });
}

async function pair(base, room) {
  return Promise.all([
    connect(base, room.hostPath, room.hostToken),
    connect(base, room.guestPath, room.guestToken),
  ]);
}
function terminatePair(pairValue) { for (const ws of pairValue) ws.terminate(); }

// A bounded byte stream on WebSocket, splitting every write into <=32 KiB
// binary messages. Avoid depending on TLS or stream write sizes for frame limits.
function binaryStream(ws) {
  const stream = new Duplex({
    readableHighWaterMark: 64 * 1024,
    writableHighWaterMark: 64 * 1024,
    read() { ws.resume(); },
    write(chunk, _encoding, callback) {
      let offset = 0;
      const next = error => {
        if (error) { callback(fault('WSS_WRITE_FAILED')); return; }
        if (offset >= chunk.length) { callback(); return; }
        if (ws.readyState !== WebSocket.OPEN) { callback(fault('WSS_CLOSED')); return; }
        const part = chunk.subarray(offset, offset + CHUNK); offset += part.length;
        ws.send(part, { binary: true, compress: false }, next);
      };
      next();
    },
    destroy(_error, callback) { ws.terminate(); callback(); },
  });
  streams.add(stream);
  stream.on('error', () => {});
  stream.once('close', () => streams.delete(stream));
  ws.on('message', (data, binary) => {
    if (!binary) { stream.destroy(fault('UNEXPECTED_TEXT')); return; }
    if (!stream.push(data)) ws.pause();
  });
  ws.once('error', () => stream.destroy(fault('WSS_STREAM_FAILED')));
  ws.once('close', () => stream.destroy(fault('WSS_STREAM_CLOSED')));
  return stream;
}

async function transfer(sender, receiver) {
  const payload = randomBytes(PAYLOAD_BYTES);
  const expected = createHash('sha256').update(payload).digest();
  const receiving = bounded(done => {
    const hash = createHash('sha256'); let received = 0;
    const clean = () => { receiver.off('data', data); receiver.off('error', fail); receiver.off('close', close); };
    const finish = error => { clean(); done(error, received); };
    const fail = () => finish(fault('TRANSFER_FAILED'));
    const close = () => finish(fault('TRANSFER_CLOSED'));
    const data = chunk => {
      received += chunk.length; hash.update(chunk);
      if (received > payload.length) finish(fault('EXCESS_TRANSFER_BYTES'));
      else if (received === payload.length) finish(hash.digest().equals(expected) ? null : fault('TRANSFER_HASH_MISMATCH'));
    };
    receiver.on('data', data); receiver.once('error', fail); receiver.once('close', close);
  });
  const sending = bounded(done => {
    let offset = 0;
    const next = error => {
      if (error) { done(fault('TRANSFER_WRITE_FAILED')); return; }
      if (offset >= payload.length) { done(null); return; }
      const part = payload.subarray(offset, offset + CHUNK); offset += part.length;
      sender.write(part, next);
    };
    next();
  });
  await Promise.all([receiving, sending]);
  verifiedBytes += payload.length;
}

async function generateIdentity(stem) {
  const keyPath = join(temporaryDirectory, `${stem}.key`);
  const certPath = join(temporaryDirectory, `${stem}.crt`);
  await execute('openssl', [
    'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256',
    '-nodes', '-sha256', '-days', '1', '-subj', `/CN=${SERVER_NAME}`,
    '-addext', `subjectAltName=DNS:${SERVER_NAME}`,
    '-keyout', keyPath, '-out', certPath,
  ], { timeout: STEP_TIMEOUT_MS, maxBuffer: 8192, signal: abort.signal, windowsHide: true });
  await chmod(keyPath, 0o600);
  return { key: await readFile(keyPath), cert: await readFile(certPath) };
}

function innerTLS(pairValue, identity, trustedCert) {
  const [host, guest] = pairValue.map(binaryStream);
  const server = new tls.TLSSocket(host, {
    isServer: true,
    secureContext: tls.createSecureContext({ key: identity.key, cert: identity.cert, minVersion: 'TLSv1.3' }),
  });
  server.on('error', () => {});
  streams.add(server); server.once('close', () => streams.delete(server));
  const client = tls.connect({
    socket: guest,
    ca: trustedCert,
    servername: SERVER_NAME,
    rejectUnauthorized: true,
    minVersion: 'TLSv1.3',
  });
  client.on('error', () => {});
  streams.add(client); client.once('close', () => streams.delete(client));
  return { server, client };
}

async function main() {
  expect(process.argv.length === 3, 'USAGE_HTTPS_BASE_AND_STDIN_TOKEN');
  expect(process.env.NODE_TLS_REJECT_UNAUTHORIZED !== '0', 'TLS_VERIFICATION_MUST_BE_ENABLED');
  let base;
  try { base = new URL(process.argv[2]); } catch { throw fault('INVALID_BASE_URL'); }
  expect(base.protocol === 'https:' && !base.username && !base.password && !base.search && !base.hash && base.pathname === '/', 'HTTPS_ORIGIN_REQUIRED');
  let ownerToken = await ownerTokenFromStdin();
  stage = 'health';
  const health = await request(base, '/healthz');
  expect(health.status === 200 && health.json?.status === 'ok', 'HEALTH_FAILED');
  announce('health');

  stage = 'unauthorized-room';
  const unauthorized = await request(base, '/v1/rooms', { method: 'POST', body: '{}' });
  expect(unauthorized.status === 401, 'UNAUTHORIZED_CREATION_ACCEPTED');
  announce('unauthorized-room', 'HTTP 401');

  stage = 'role-boundary';
  const rawRoom = await newRoom(base, ownerToken);
  await connect(base, rawRoom.hostPath, rawRoom.guestToken, true);
  await connect(base, rawRoom.guestPath, rawRoom.hostToken, true);
  announce('role-boundary', 'both swapped roles rejected');

  stage = 'wss-bidirectional';
  const rawPair = await pair(base, rawRoom);
  const [rawHost, rawGuest] = rawPair.map(binaryStream);
  await transfer(rawHost, rawGuest);
  await transfer(rawGuest, rawHost);
  terminatePair(rawPair);
  announce('wss-bidirectional', `${PAYLOAD_BYTES} bytes each direction; SHA-256 matched`);

  stage = 'inner-tls-identity';
  temporaryDirectory = await mkdtemp(join(tmpdir(), 'racktop-smoke-'));
  await chmod(temporaryDirectory, 0o700);
  const identity = await generateIdentity('server');
  testKey = identity.key;
  const otherIdentity = await generateIdentity('untrusted');
  otherIdentity.key.fill(0);

  stage = 'inner-tls-valid';
  const securePair = await pair(base, await newRoom(base, ownerToken));
  const good = innerTLS(securePair, identity, identity.cert);
  await bounded(done => {
    good.client.once('secureConnect', () => done(good.client.authorized ? null : fault('INNER_TLS_UNAUTHORIZED')));
    good.client.once('error', () => done(fault('INNER_TLS_HANDSHAKE_FAILED')));
  });
  await transfer(good.client, good.server);
  await transfer(good.server, good.client);
  good.client.destroy(); good.server.destroy(); terminatePair(securePair);
  announce('inner-tls-valid', `${PAYLOAD_BYTES} bytes each direction; trusted certificate + server name checked`);

  stage = 'inner-tls-wrong-certificate';
  const badPair = await pair(base, await newRoom(base, ownerToken));
  ownerToken = '';
  const bad = innerTLS(badPair, identity, otherIdentity.cert);
  await bounded(done => {
    bad.client.once('secureConnect', () => done(fault('WRONG_CERTIFICATE_ACCEPTED')));
    bad.client.once('error', error => {
      const certificateErrors = new Set([
        'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN',
        'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
        'CERT_SIGNATURE_FAILURE', 'ERR_TLS_CERT_ALTNAME_INVALID',
      ]);
      done(certificateErrors.has(error.code) ? null : fault('EXPECTED_CERTIFICATE_REJECTION'));
    });
  });
  bad.client.destroy(); bad.server.destroy(); terminatePair(badPair);
  announce('inner-tls-wrong-certificate', 'rejected');
  console.log(`PASS summary checks=${passed} verified_bytes=${verifiedBytes}`);
  console.log('INFO inner TLS used disposable probe identities; RackTop integration is not tested.');
}

const deadline = setTimeout(() => abort.abort(), TOTAL_TIMEOUT_MS);
process.once('SIGINT', () => abort.abort());
process.once('SIGTERM', () => abort.abort());
try {
  await main();
} catch (error) {
  // Only our constant safeCode values may be exposed. Third-party errors are opaque.
  const safe = typeof error?.safeCode === 'string' && /^[A-Z_]+$/.test(error.safeCode) ? error.safeCode : 'OPERATION_FAILED';
  console.error(`FAIL ${stage} ${safe}`);
  process.exitCode = 1;
} finally {
  abort.abort();
  clearTimeout(deadline);
  for (const timer of timers) clearTimeout(timer);
  for (const req of requests) req.destroy();
  for (const stream of streams) stream.destroy();
  for (const ws of sockets) ws.terminate();
  process.stdin.pause();
  testKey?.fill(0);
  if (temporaryDirectory) {
    try { await rm(temporaryDirectory, { recursive: true, force: true }); }
    catch { console.error('FAIL cleanup TEMPORARY_IDENTITY_CLEANUP_FAILED'); process.exitCode = 1; }
  }
}
