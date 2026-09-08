import { createServer } from 'node:http';
import { readFile, realpath, stat } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { createStore, ApiError } from './store.mjs';
import { createAuth } from './auth.mjs';
import { createAccountAuth } from './account-auth.mjs';
import { createNotifier } from './notifier.mjs';
import { createEquipmentStore } from './equipment-store.mjs';
import { compressEquipmentPhoto, validatePhotoBody } from './equipment-photo.mjs';

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

function securityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(self), microphone=(), geolocation=()');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
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
async function readBody(req, limit = 64 * 1024) {
  if (!['POST', 'PATCH', 'PUT', 'DELETE'].includes(req.method)) return undefined;
  const declared = Number(req.headers['content-length'] || 0);
  if (!Number.isFinite(declared) || declared > limit) throw new ApiError(413, 'BODY_TOO_LARGE', `请求内容超过 ${limit / 1024} KB`);
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) throw new ApiError(415, 'UNSUPPORTED_MEDIA_TYPE', '请使用 application/json 请求格式');
  const chunks = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new ApiError(413, 'BODY_TOO_LARGE', `请求内容超过 ${limit / 1024} KB`);
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
  const equipmentStore = createEquipmentStore({ dbPath: config.dbPath, now: config.now });
  if (config.mode === 'demo' && config.seedDemo !== false) store.seedDemo();
  let timer, closing = false, notificationRun = null, closeRun = null;
  const handlers = new Set();
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
      const photoMatch = /^\/api\/equipment\/([^/]+)\/photo$/.exec(url.pathname);
      // Reject unauthenticated uploads before buffering image data.
      if (photoMatch && ['POST', 'DELETE'].includes(req.method)) {
        const candidate = auth.resolve(req);
        if (!candidate?.user) throw new ApiError(401, 'UNAUTHENTICATED', '请先登录');
        if (!['member', 'admin'].includes(candidate.user.role)) throw new ApiError(403, 'FORBIDDEN', '仅团队成员可以使用此服务');
        auth.verifyWrite(req, candidate);
      }
      const body = await readBody(req, photoMatch && req.method === 'POST' ? 2 * 1024 * 1024 : 64 * 1024);
      if (await auth.handle(req, res, url, body)) return;
      if (!url.pathname.startsWith('/api/')) { await serveStatic(req, res, url); return; }
      const session = auth.resolve(req);
      // Every business route, including equipment and photos, requires membership.
      if (!session?.user) throw new ApiError(401, 'UNAUTHENTICATED', '请先登录');
      const user = session.user;
      if (!['member', 'admin'].includes(user.role)) throw new ApiError(403, 'FORBIDDEN', '仅团队成员可以使用此服务');
      if (['POST', 'PATCH', 'PUT', 'DELETE'].includes(req.method)) auth.verifyWrite(req, session);
      if (photoMatch) {
        for (const key of url.searchParams.keys()) {
          if (key !== 'v' || url.searchParams.getAll(key).length !== 1 || !/^[1-9][0-9]{0,15}$/.test(url.searchParams.get(key))) throw new ApiError(422, 'INVALID_INPUT', '照片查询参数无效');
        }
        const id = photoMatch[1];
        if (req.method === 'GET') {
          const photo = equipmentStore.getPhoto(id);
          if (!photo) throw new ApiError(404, 'PHOTO_NOT_FOUND', '设备尚未上传照片');
          res.statusCode = 200;
          res.setHeader('Content-Type', 'image/jpeg');
          res.setHeader('Cache-Control', 'no-store');
          res.setHeader('Content-Length', photo.bytes.length);
          res.end(photo.bytes); return;
        }
        if (req.method === 'POST') {
          validatePhotoBody(body);
          const current = equipmentStore.get(id).equipment;
          if (current.version !== body.version) throw new ApiError(409, 'VERSION_CONFLICT', '设备已被其他人修改，请刷新后重新编辑');
          const photo = await compressEquipmentPhoto(body.dataUrl);
          if (closing || res.destroyed) {
            // An open response must end so server.close can finish draining its
            // socket; disconnected requests simply stop before touching state.
            if (!res.destroyed) errorResponse(res, new ApiError(503, 'SERVER_CLOSING', '服务正在关闭，请稍后重试'));
            return;
          }
          // Compression yields to other requests; recheck both the grant and CAS.
          const active = auth.resolve(req);
          if (!active?.user || active.user.id !== user.id) throw new ApiError(401, 'UNAUTHENTICATED', '登录已失效，请重新登录');
          if (!['member', 'admin'].includes(active.user.role)) throw new ApiError(403, 'FORBIDDEN', '仅团队成员可以使用此服务');
          auth.verifyWrite(req, active);
          json(res, 200, { equipment: equipmentStore.setPhoto(id, { version: body.version, ...photo }, active.user) }); return;
        }
        if (req.method === 'DELETE') {
          validatePhotoBody(body, false);
          json(res, 200, { equipment: equipmentStore.removePhoto(id, body, user) }); return;
        }
        throw new ApiError(405, 'METHOD_NOT_ALLOWED', '照片仅支持查看、上传和移除');
      }
      const equipmentMatch = /^\/api\/equipment\/([^/]+)$/.exec(url.pathname);
      if (url.pathname === '/api/equipment' || equipmentMatch) {
        if ([...url.searchParams].length) throw new ApiError(422, 'INVALID_INPUT', '设备接口不支持查询参数');
        if (req.method === 'GET') {
          json(res, 200, equipmentMatch ? equipmentStore.get(equipmentMatch[1]) : { equipment: equipmentStore.list() }); return;
        }
        if (!equipmentMatch && req.method === 'POST') { json(res, 201, { equipment: equipmentStore.create(body, session.user) }); return; }
        if (equipmentMatch && req.method === 'PATCH') { json(res, 200, { equipment: equipmentStore.update(equipmentMatch[1], body, session.user) }); return; }
        throw new ApiError(405, 'METHOD_NOT_ALLOWED', '设备仅支持查看、新建和修改，请将停用设备标为已退役');
      }
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

  const server = createServer((req, res) => {
    const handler = handle(req, res);
    handlers.add(handler);
    // Both branches consume settlement; unlike an ignored .finally(), this
    // does not create an unhandled rejected promise if response writing fails.
    void handler.then(() => handlers.delete(handler), () => handlers.delete(handler));
  });
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
  function close() {
    if (closeRun) return closeRun;
    closing = true;
    clearInterval(timer);
    closeRun = (async () => {
      await new Promise(resolveClose => { server.close(() => resolveClose()); server.closeIdleConnections(); });
      // Closing sockets does not await asynchronous work from clients that
      // disconnected. Keep auth and SQLite alive until those handlers settle.
      while (handlers.size) await Promise.allSettled([...handlers]);
      if (notificationRun) await notificationRun.catch(() => {});
      auth.close(); equipmentStore.close(); store.close();
    })();
    return closeRun;
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
