import { createServer } from 'node:http';
import { readFile, realpath, stat } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { createStore, ApiError } from './store.mjs';
import { createAuth } from './auth.mjs';
import { createAccountAuth } from './account-auth.mjs';
import { createNotifier } from './notifier.mjs';

const directory = dirname(fileURLToPath(import.meta.url));
const mimeTypes = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2' };
const loopbacks = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
function list(value) { return (value ?? '').split(',').map(part => part.trim()).filter(Boolean); }

export function readConfig(env = process.env) {
  if (env.TEAM_TRUST_PROXY !== undefined && !['', 'true', 'false'].includes(env.TEAM_TRUST_PROXY)) throw new Error('TEAM_TRUST_PROXY 必须为 true 或 false');
  const mode = env.TEAM_AUTH_MODE || 'demo';
  const host = env.TEAM_HOST || '127.0.0.1';
  const port = Number(env.TEAM_PORT || 4318);
  const authorityHost = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  return {
    mode, host, port, publicUrl: env.TEAM_PUBLIC_URL || `http://${authorityHost}:${port}`,
    dbPath: env.TEAM_DB_PATH || resolve(directory, `../data/${mode === 'demo' ? 'demo' : 'team'}.sqlite`),
    distPath: resolve(directory, '../dist'),
    feishuAppId: env.FEISHU_APP_ID || '', feishuAppSecret: env.FEISHU_APP_SECRET || '',
    feishuTenantKeys: list(env.FEISHU_TENANT_KEYS), feishuAdminOpenIds: list(env.FEISHU_ADMIN_OPEN_IDS),
    feishuWebhookUrl: env.FEISHU_WEBHOOK_URL || '', feishuWebhookSecret: env.FEISHU_WEBHOOK_SECRET || '',
    notificationsConfigured: Boolean(env.FEISHU_WEBHOOK_URL),
    adminUsername: env.TEAM_ADMIN_USERNAME || '', bootstrapToken: env.TEAM_BOOTSTRAP_TOKEN || '',
    trustProxy: env.TEAM_TRUST_PROXY === 'true', nodeEnv: env.NODE_ENV,
  };
}

function validateConfig(config) {
  if (!['demo', 'feishu', 'account'].includes(config.mode)) throw new Error('TEAM_AUTH_MODE 必须为 demo、feishu 或 account');
  if (typeof config.host !== 'string' || !config.host || !Number.isInteger(config.port) || config.port < 0 || config.port > 65535) throw new Error('TEAM_HOST 或 TEAM_PORT 无效');
  if (typeof config.trustProxy !== 'boolean' || (config.trustProxy && !loopbacks.has(config.host))) throw new Error('受信任代理模式只能监听 loopback 地址');
  let publicUrl;
  try { publicUrl = new URL(config.publicUrl); } catch { throw new Error('TEAM_PUBLIC_URL 必须是有效绝对地址'); }
  if (!['http:', 'https:'].includes(publicUrl.protocol) || publicUrl.username || publicUrl.password || publicUrl.search || publicUrl.hash || publicUrl.pathname !== '/') throw new Error('TEAM_PUBLIC_URL 应为不含路径、账号或查询参数的站点地址');
  if (config.mode === 'demo' && (!loopbacks.has(config.host) || !loopbacks.has(publicUrl.hostname))) throw new Error('演示模式只能监听和使用 loopback 地址，不能公开部署');
  if (config.mode === 'feishu' && (publicUrl.protocol !== 'https:' || !config.feishuAppId || !config.feishuAppSecret || !config.feishuTenantKeys?.length)) throw new Error('正式部署必须配置 HTTPS 地址、飞书应用和企业租户白名单');
  if (config.mode === 'account' && publicUrl.protocol !== 'https:' && !loopbacks.has(publicUrl.hostname)) throw new Error('账号登录公网服务必须使用 HTTPS');
  return publicUrl;
}

// Explicit public projections prevent future store fields from accidentally becoming public.
function publicResource(value) {
  const { id, cluster, name, gpuModel, gpuCount, enabled, inventoryVersion, inventoryState, lastSeenAt, observedAt, status } = value;
  return { id, cluster, name, gpuModel, gpuCount, enabled, notes: '', inventoryVersion, inventoryState, lastSeenAt, observedAt, status,
    gpus: (value.gpus ?? []).map(({ id: gpuId, uuid, index, model, memoryTotalMb }) => ({ id: gpuId, uuid, index, model, memoryTotalMb })) };
}
function publicReservation(value) {
  const { id, resourceId, resourceName, cluster, ownerName, scope, gpuIndices, gpuIds, inventoryVersion,
    startAt, endAt, status, createdAt, updatedAt, version, plannedEndAt } = value;
  return { id, resourceId, resourceName, cluster, ownerName, ownerId: '', scope, gpuIndices, gpuIds, inventoryVersion,
    startAt, endAt, purpose: '', status, createdAt, updatedAt, version, plannedEndAt };
}

function securityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
}
function json(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}
function errorResponse(res, error) {
  if (res.headersSent) { res.destroy(); return; }
  const status = Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599 ? error.status : 500;
  const safe = status < 500;
  json(res, status, { error: { code: safe ? (error.code || 'REQUEST_FAILED') : (status === 503 ? 'SERVICE_UNAVAILABLE' : 'INTERNAL_ERROR'), message: safe ? error.message : (status === 503 ? '服务暂时繁忙，请稍后重试' : '服务暂时无法完成请求，请稍后重试'), ...(safe && error.conflicts ? { conflicts: error.conflicts } : {}) } });
}
async function readBody(req) {
  if (!['POST', 'PATCH', 'PUT', 'DELETE'].includes(req.method)) return undefined;
  const declared = Number(req.headers['content-length'] || 0);
  if (!Number.isFinite(declared) || declared > 64 * 1024) throw new ApiError(413, 'BODY_TOO_LARGE', '请求内容超过 64 KB');
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) throw new ApiError(415, 'UNSUPPORTED_MEDIA_TYPE', '请使用 application/json 请求格式');
  const chunks = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 64 * 1024) throw new ApiError(413, 'BODY_TOO_LARGE', '请求内容超过 64 KB');
    chunks.push(chunk);
  }
  let body;
  try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { throw new ApiError(400, 'INVALID_JSON', '请求不是有效 JSON'); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ApiError(422, 'INVALID_INPUT', '请求内容必须是 JSON 对象');
  return body;
}

export function createTeamServer(overrides = {}) {
  const config = { ...readConfig(), ...overrides };
  config.notificationsConfigured = overrides.notificationsConfigured ?? Boolean(config.feishuWebhookUrl);
  const publicUrl = validateConfig(config);
  const auth = config.auth || (config.mode === 'account' ? createAccountAuth(config) : createAuth(config));
  const notifier = config.notifier || createNotifier(config);
  const store = config.store || createStore({ dbPath: config.dbPath, now: config.now, notificationsConfigured: config.notificationsConfigured });
  if (config.mode === 'demo' && config.seedDemo !== false) store.seedDemo();
  let timer, closing = false, notificationRun = null;
  let listenAuthority;

  function checkOriginAndHost(req) {
    const host = req.headers.host;
    const allowed = new Set([publicUrl.host, listenAuthority]);
    if (typeof host !== 'string' || !allowed.has(host.toLowerCase())) throw new ApiError(403, 'INVALID_HOST', '请求的主机地址不受信任');
    const origin = req.headers.origin;
    if (origin !== undefined && origin !== publicUrl.origin) throw new ApiError(403, 'INVALID_ORIGIN', '请求来源不受信任');
    if (['POST', 'PATCH', 'PUT', 'DELETE'].includes(req.method) && origin !== publicUrl.origin) throw new ApiError(403, 'INVALID_ORIGIN', '写入请求需要同源 Origin');
  }

  async function serveStatic(req, res, url) {
    if (!['GET', 'HEAD'].includes(req.method)) throw new ApiError(405, 'METHOD_NOT_ALLOWED', '不支持的请求方法');
    let pathname;
    try { pathname = decodeURIComponent(url.pathname); } catch { throw new ApiError(400, 'INVALID_PATH', '请求路径无效'); }
    if (pathname.includes('\0') || pathname.includes('\\') || pathname.split('/').some(part => part === '..' || part.startsWith('.'))) throw new ApiError(400, 'INVALID_PATH', '请求路径无效');
    let root;
    try { root = await realpath(config.distPath); } catch { throw new ApiError(503, 'FRONTEND_NOT_BUILT', '网页尚未构建，请运行团队网页构建命令'); }
    let file = resolve(root, `.${pathname}`);
    let metadata;
    try { metadata = await stat(file); } catch (error) { if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error; }
    if (!metadata?.isFile()) {
      if (extname(pathname)) throw new ApiError(404, 'NOT_FOUND', '找不到文件');
      file = resolve(root, 'index.html');
    }
    const canonical = await realpath(file);
    const relativePath = relative(root, canonical);
    if (relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) throw new ApiError(403, 'INVALID_PATH', '文件路径超出网页目录');
    const bytes = await readFile(canonical);
    res.setHeader('Content-Type', mimeTypes[extname(canonical)] || 'application/octet-stream');
    res.setHeader('Content-Length', bytes.length);
    res.setHeader('Cache-Control', extname(canonical) === '.html' ? 'no-cache' : 'public, max-age=3600');
    res.statusCode = 200;
    res.end(req.method === 'HEAD' ? undefined : bytes);
  }

  async function handle(req, res) {
    securityHeaders(res);
    try {
      checkOriginAndHost(req);
      // Validate the raw target before WHATWG URL normalization removes dot segments.
      if (typeof req.url !== 'string' || req.url.length > 8192 || !req.url.startsWith('/') || req.url.startsWith('//')) throw new ApiError(400, 'INVALID_PATH', '请求路径无效');
      let rawPath;
      try { rawPath = decodeURIComponent(req.url.split('?')[0]); } catch { throw new ApiError(400, 'INVALID_PATH', '请求路径无效'); }
      if (rawPath.includes('\0') || rawPath.includes('\\') || rawPath.split('/').includes('..')) throw new ApiError(400, 'INVALID_PATH', '请求路径无效');
      const url = new URL(req.url, publicUrl);
      if (url.pathname === '/api/health' && req.method === 'GET') { json(res, 200, { ok: true }); return; }
      const body = await readBody(req);
      if (await auth.handle(req, res, url, body)) return;
      if (!url.pathname.startsWith('/api/')) { await serveStatic(req, res, url); return; }
      const session = auth.resolve(req);
      // A rejected device credential must not silently become a public visitor.
      if (req.headers.authorization !== undefined && !session?.user) throw new ApiError(401, 'UNAUTHENTICATED', '设备登录已过期，请重新登录');
      // Account mode has an intentionally public, read-only team schedule. No member
      // credentials, reservation purposes or resource notes leave this projection.
      if (!session?.user && config.mode === 'account' && req.method === 'GET') {
        if (url.pathname === '/api/resources') {
          json(res, 200, { resources: store.listResources().filter(r => r.enabled).map(publicResource) }); return;
        }
        if (url.pathname === '/api/reservations') {
          for (const key of url.searchParams.keys()) if (!['from', 'to', 'mine'].includes(key) || url.searchParams.getAll(key).length > 1) throw new ApiError(422, 'INVALID_INPUT', '查询参数无效');
          if (url.searchParams.get('mine') === 'true') throw new ApiError(401, 'UNAUTHENTICATED', '请先登录');
          const visible = new Set(store.listResources().filter(r => r.enabled).map(r => r.id));
          const list = store.listReservations(Object.fromEntries(url.searchParams), {id:'public-view',name:'访客',role:'member'}).filter(r => visible.has(r.resourceId));
          json(res, 200, { reservations: list.map(publicReservation) }); return;
        }
        const detail = /^\/api\/reservations\/([a-zA-Z0-9_-]{1,100})$/.exec(url.pathname);
        if (detail) {
          const value = store.getReservation(detail[1]);
          if (!store.getResource(value.resourceId).enabled) throw new ApiError(404, 'NOT_FOUND', '找不到预约');
          json(res, 200, { reservation: publicReservation(value) }); return;
        }
      }
      if (!session?.user) throw new ApiError(401, 'UNAUTHENTICATED', '请先登录');
      if (['POST', 'PATCH', 'PUT', 'DELETE'].includes(req.method)) auth.verifyWrite(req, session);
      const user = session.user;
      if (url.pathname === '/api/resources/sync' && req.method === 'POST') {
        json(res, 200, { resource: store.syncResource(body, user) }); return;
      }
      if (url.pathname === '/api/resources') {
        if (req.method === 'GET') { json(res, 200, { resources: store.listResources() }); return; }
        if (req.method === 'POST') { json(res, 201, { resource: store.createResource(body, user) }); return; }
      }
      const resourceMatch = /^\/api\/resources\/([a-zA-Z0-9_-]{1,100})$/.exec(url.pathname);
      if (resourceMatch && req.method === 'PATCH') { json(res, 200, { resource: store.updateResource(resourceMatch[1], body, user) }); return; }
      if (url.pathname === '/api/reservations') {
        if (req.method === 'GET') {
          for (const key of url.searchParams.keys()) if (!['from', 'to', 'mine'].includes(key) || url.searchParams.getAll(key).length > 1) throw new ApiError(422, 'INVALID_INPUT', '查询参数无效');
          json(res, 200, { reservations: store.listReservations(Object.fromEntries(url.searchParams), user) }); return;
        }
        if (req.method === 'POST') { json(res, 201, { reservation: store.createReservation(body, user) }); return; }
      }
      const reservationMatch = /^\/api\/reservations\/([a-zA-Z0-9_-]{1,100})(?:\/(cancel|finish))?$/.exec(url.pathname);
      if (reservationMatch) {
        const [, id, action] = reservationMatch;
        if (!action && req.method === 'GET') { json(res, 200, { reservation: store.getReservation(id) }); return; }
        if (!action && req.method === 'PATCH') { json(res, 200, { reservation: store.updateReservation(id, body, user) }); return; }
        if (action && req.method === 'POST') {
          const reservation = action === 'cancel' ? store.cancelReservation(id, body, user) : store.finishReservation(id, body, user);
          json(res, 200, { reservation }); return;
        }
      }
      throw new ApiError(404, 'NOT_FOUND', '接口不存在');
    } catch (error) { errorResponse(res, error); }
  }

  const server = createServer((req, res) => { void handle(req, res); });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5000;
  server.maxHeadersCount = 64;

  async function processNotifications() {
    if (closing || notificationRun) return notificationRun;
    notificationRun = (async () => {
      store.enqueueEnding();
      if (!config.notificationsConfigured) return;
      for (const item of store.claimOutbox(5)) {
        try {
          const sent = await notifier.send(item.event);
          if (sent) store.completeOutbox(item.id);
          else store.retryOutbox(item.id, '通知未配置，未发送', true);
        } catch { store.retryOutbox(item.id, '飞书通知发送失败，将自动重试'); }
      }
    })();
    try { await notificationRun; } finally { notificationRun = null; }
  }

  async function start() {
    if (closing) throw new Error('服务已关闭');
    await new Promise((resolveStart, reject) => {
      const onError = error => reject(error);
      server.once('error', onError);
      server.listen(config.port, config.host, () => { server.off('error', onError); resolveStart(); });
    });
    const address = server.address();
    const host = config.host.includes(':') && !config.host.startsWith('[') ? `[${config.host}]` : config.host;
    listenAuthority = `${host}:${address.port}`;
    timer = setInterval(() => { void processNotifications().catch(() => {}); }, config.notificationIntervalMs || 30_000);
    timer.unref();
    void processNotifications().catch(() => {});
    return { host: config.host, port: address.port, publicUrl: publicUrl.origin };
  }
  async function close() {
    if (closing) return;
    closing = true;
    clearInterval(timer);
    await new Promise(resolveClose => { server.close(() => resolveClose()); server.closeIdleConnections(); });
    if (notificationRun) await notificationRun.catch(() => {});
    auth.close(); store.close();
  }
  return { config, server, store, auth, start, close, processNotifications };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  let application;
  try {
    application = createTeamServer();
    const info = await application.start();
    console.log(`RackTop 团队预约已启动：${info.publicUrl}（${application.config.mode}）`);
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void application.close().then(() => process.exit(0)); });
  } catch {
    console.error('团队预约服务启动失败，请检查 TEAM_* / 飞书配置、端口和数据库权限。');
    if (application) await application.close();
    process.exitCode = 1;
  }
}
