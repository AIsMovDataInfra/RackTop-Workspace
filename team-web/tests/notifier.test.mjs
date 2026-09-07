import test from 'node:test';
import assert from 'node:assert/strict';
import { createNotifier } from '../server/notifier.mjs';

const CONFIG = { feishuWebhookUrl: 'https://open.feishu.cn/open-apis/bot/v2/hook/test-hook', publicUrl: 'https://team.example.test' };
const EVENT = { type: 'created', resource: { name: '计算节点 A', cluster: '研究集群', password: 'never-send-resource-password' },
  reservation: { id: 'res-example', ownerName: '小林', scope: 'gpus', gpuIndices: [0, 2],
    startAt: '2026-09-08T01:00:00.000Z', endAt: '2026-09-08T03:00:00.000Z', purpose: '模型训练',
    token: 'never-send-reservation-token', ownerId: 'never-send-internal-id' } };

test('unconfigured notifications do not send or claim success', async () => {
  let calls = 0;
  const notifier = createNotifier({ fetch: () => { calls += 1; } });
  assert.equal(await notifier.send(EVENT), false);
  assert.equal(calls, 0);
  assert.throws(() => createNotifier({ feishuWebhookSecret: 'secret' }), /FEISHU_WEBHOOK_URL/);
});

test('only official HTTPS webhook URLs are allowed, with no credentials/query/redirect destinations', () => {
  for (const feishuWebhookUrl of [
    'http://open.feishu.cn/open-apis/bot/v2/hook/x',
    'https://evil.test/open-apis/bot/v2/hook/x',
    'https://open.feishu.cn.evil.test/open-apis/bot/v2/hook/x',
    'https://open.feishu.cn:444/open-apis/bot/v2/hook/x',
    'https://name:secret@open.feishu.cn/open-apis/bot/v2/hook/x',
    'https://open.feishu.cn/open-apis/bot/v2/hook/x?redirect=https://evil.test',
    'https://open.feishu.cn/open-apis/bot/v2/hook/x#fragment',
    'https://open.feishu.cn/open-apis/bot/v2/hook/x/other',
    'https://127.0.0.1/open-apis/bot/v2/hook/x',
    'https://open.feishu.cn/anything',
  ]) assert.throws(() => createNotifier({ ...CONFIG, feishuWebhookUrl }), /FEISHU_WEBHOOK_URL/);
});

test('signed messages use official empty-message HMAC and only selected reservation fields', async () => {
  let request;
  const notifier = createNotifier({ ...CONFIG, feishuWebhookSecret: 'example-secret', now: () => 1599360473000,
    fetch: async (url, options) => { request = { url, ...options }; return Response.json({ code: 0 }); } });
  assert.equal(await notifier.send(EVENT), true);
  assert.equal(request.url, CONFIG.feishuWebhookUrl);
  assert.equal(request.method, 'POST');
  assert.equal(request.redirect, 'error');
  const body = JSON.parse(request.body);
  assert.equal(body.timestamp, '1599360473');
  // Independent Python hashlib/hmac test vector, not recomputed with implementation code.
  assert.equal(body.sign, 'Gqzo3d51m9P8CAgrn86JBZIipyhJhGOpHQbUT4HViD0=');
  assert.equal(body.msg_type, 'text');
  assert.match(body.content.text, /研究集群 \/ 计算节点 A（GPU 0, 2）/);
  assert.match(body.content.text, /小林/);
  assert.match(body.content.text, /2026\/09\/08 09:00 — 2026\/09\/08 11:00（北京时间）/);
  assert.match(body.content.text, /https:\/\/team.example.test\/\?reservation=res-example/);
  assert.ok(!request.body.includes('never-send'));
  assert.ok(!request.body.includes('example-secret'));
});

test('unsigned messages omit signing fields and support all ordinary event types', async () => {
  const bodies = [];
  const notifier = createNotifier({ ...CONFIG, fetch: async (_url, options) => {
    bodies.push(JSON.parse(options.body)); return Response.json({ StatusCode: 0, StatusMessage: 'success' });
  } });
  for (const type of ['created', 'updated', 'cancelled', 'finished', 'ending']) assert.equal(await notifier.send({ ...EVENT, type }), true);
  for (const body of bodies) { assert.equal(body.timestamp, undefined); assert.equal(body.sign, undefined); }
  assert.match(bodies[4].content.text, /这不代表 GPU 已空闲/);
  assert.match(bodies[3].content.text, /提前结束/);
});

test('user text cannot inject group mentions and detail IDs remain URL encoded', async () => {
  let body;
  const notifier = createNotifier({ ...CONFIG, fetch: async (_url, options) => {
    body = JSON.parse(options.body); return Response.json({ code: 0 });
  } });
  await notifier.send({ ...EVENT, reservation: { ...EVENT.reservation, id: 'a&owner=evil',
    purpose: '<at user_id="all">所有人</at>\n伪造标题', ownerName: '<at user_id="ou_other">人</at>' } });
  assert.ok(!body.content.text.includes('<at'));
  assert.match(body.content.text, /reservation=a%26owner%3Devil/);
  assert.ok(!body.content.text.includes('\n伪造标题'));
});

test('nonzero, absent, null and contradictory provider status all fail; explicit successes pass', async () => {
  for (const result of [{ code: 19021 }, { StatusCode: 19024 }, { code: 0, StatusCode: 1 },
    { code: 1, StatusCode: 0 }, {}, { code: null }, { StatusCode: false }, { code: 'unknown' }]) {
    const notifier = createNotifier({ ...CONFIG, fetch: async () => Response.json(result) });
    await assert.rejects(notifier.send(EVENT), { code: 'NOTIFICATION_FAILED' });
  }
  for (const result of [{ code: 0 }, { StatusCode: 0 }, { code: 0, StatusCode: 0 }, { code: '0' }]) {
    const notifier = createNotifier({ ...CONFIG, fetch: async () => Response.json(result) });
    assert.equal(await notifier.send(EVENT), true);
  }
});

test('transport/HTTP/JSON/oversize failures are sanitized and redirects are refused', async () => {
  for (const fetchImpl of [
    async () => { throw new Error(`contains-secret ${CONFIG.feishuWebhookUrl}`); },
    async () => new Response('contains-secret', { status: 500 }),
    async () => new Response('not-json'),
    async () => new Response('x'.repeat(17 * 1024)),
    async () => ({ ok: true, redirected: true }),
  ]) {
    const notifier = createNotifier({ ...CONFIG, fetch: fetchImpl });
    await assert.rejects(notifier.send(EVENT), (error) => error.code === 'NOTIFICATION_FAILED'
      && !error.message.includes('secret') && !error.message.includes('hook'));
  }
});

test('notification requests enforce timeout and invalid events never call fetch', async () => {
  let aborted = false;
  const notifier = createNotifier({ ...CONFIG, timeoutMs: 100, fetch: async (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')); }, { once: true });
  }) });
  await assert.rejects(notifier.send(EVENT), { code: 'NOTIFICATION_FAILED' });
  assert.equal(aborted, true);
  let called = false;
  const invalid = createNotifier({ ...CONFIG, fetch: () => { called = true; } });
  await assert.rejects(invalid.send({ ...EVENT, type: 'other' }), { code: 'NOTIFICATION_FAILED' });
  await assert.rejects(invalid.send({ ...EVENT, reservation: { ...EVENT.reservation, startAt: 'not-a-date' } }), { code: 'NOTIFICATION_FAILED' });
  assert.equal(called, false);
});
