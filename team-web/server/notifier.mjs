import { createHmac } from 'node:crypto';

// Official Feishu tutorials document the custom-bot body and signing algorithm:
// https://www.feishu.cn/content/7271149634339422210
// https://www.feishu.cn/content/7298688341381546012
const EVENT_NAMES = Object.freeze({
  created: '新预约', updated: '预约已修改', cancelled: '预约已取消',
  finished: '预约已提前结束', ending: '预约即将到期',
});
const dateFormat = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hour12: false,
});

function failure() {
  // Do not expose a webhook URL, response content, or transport error to logs.
  return Object.assign(new Error('飞书群通知发送失败，将按服务配置重试。'), { code: 'NOTIFICATION_FAILED' });
}

function plain(value, maxLength) {
  // Feishu text supports <at> markup; prevent user-entered names/purpose from pinging a group.
  return String(value ?? '').replace(/[\x00-\x1f\x7f]/g, ' ').replaceAll('<', '＜').replaceAll('>', '＞').slice(0, maxLength);
}

function time(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw failure();
  return dateFormat.format(date);
}

function message(event, publicUrl) {
  const { type, reservation, resource } = event ?? {};
  if (!Object.hasOwn(EVENT_NAMES, type) || !reservation || !resource
    || typeof reservation.id !== 'string' || !reservation.id || reservation.id.length > 160) throw failure();
  const link = new URL('/', publicUrl);
  link.searchParams.set('reservation', reservation.id);
  const scope = reservation.scope === 'gpus' && Array.isArray(reservation.gpuIndices)
    ? `GPU ${reservation.gpuIndices.filter((value) => Number.isInteger(value) && value >= 0).slice(0, 64).join(', ')}` : '整机';
  return [
    `RackTop · ${EVENT_NAMES[type]}`,
    `资源：${plain(resource.cluster ?? reservation.cluster, 80)} / ${plain(resource.name ?? reservation.resourceName, 120)}（${scope}）`,
    `预约人：${plain(reservation.ownerName, 160)}`,
    `时间：${time(reservation.startAt)} — ${time(reservation.endAt)}（北京时间）`,
    `用途：${plain(reservation.purpose, 500)}`,
    ...(type === 'ending' ? ['提示：排期即将结束，请按实际情况及时续约或释放；这不代表 GPU 已空闲。'] : []),
    `详情：${link.href}`,
  ].join('\n');
}

function successCode(value) { return value === 0 || value === '0'; }

export function createNotifier(config = {}) {
  const raw = config.feishuWebhookUrl;
  if (raw === undefined || raw === null || raw === '') {
    if (config.feishuWebhookSecret) throw new Error('配置群机器人签名密钥时必须同时配置 FEISHU_WEBHOOK_URL');
    return { async send() { return false; } };
  }
  let webhook;
  try { webhook = new URL(raw); } catch { throw new Error('FEISHU_WEBHOOK_URL 不是有效的飞书群机器人地址'); }
  if (webhook.protocol !== 'https:' || webhook.hostname !== 'open.feishu.cn' || webhook.port
    || webhook.username || webhook.password || webhook.hash || webhook.search
    || !/^\/open-apis\/bot\/v2\/hook\/[A-Za-z0-9_-]+$/.test(webhook.pathname)) {
    throw new Error('FEISHU_WEBHOOK_URL 必须使用 open.feishu.cn 官方 HTTPS 群机器人地址');
  }
  let publicUrl;
  try { publicUrl = new URL(config.publicUrl); } catch { throw new Error('PUBLIC_URL 必须是有效的站点地址'); }
  if (!['http:', 'https:'].includes(publicUrl.protocol) || publicUrl.username || publicUrl.password
    || publicUrl.pathname !== '/' || publicUrl.search || publicUrl.hash) throw new Error('PUBLIC_URL 必须只包含站点协议、主机和端口');
  if (config.feishuWebhookSecret !== undefined && typeof config.feishuWebhookSecret !== 'string') {
    throw new Error('FEISHU_WEBHOOK_SECRET 必须是字符串');
  }
  const secret = config.feishuWebhookSecret ?? '';
  const fetchImpl = config.fetch ?? globalThis.fetch;
  const now = config.now ?? Date.now;
  const timeoutMs = Math.min(30_000, Math.max(100, config.timeoutMs ?? 8_000));

  async function send(event) {
    const body = { msg_type: 'text', content: { text: message(event, publicUrl) } };
    if (secret) {
      body.timestamp = String(Math.floor(now() / 1000));
      // The timestamp + newline + secret is the HMAC key; its message is empty.
      body.sign = createHmac('sha256', `${body.timestamp}\n${secret}`).update('').digest('base64');
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(webhook.href, { method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8' }, body: JSON.stringify(body),
        redirect: 'error', signal: controller.signal });
      if (!response.ok || response.redirected) throw failure();
      const reader = response.body?.getReader();
      if (!reader) throw failure();
      const chunks = [];
      let size = 0;
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 16 * 1024) { await reader.cancel(); throw failure(); }
        chunks.push(Buffer.from(value));
      }
      const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      // Feishu documents both code and StatusCode envelopes. Any reported failure wins.
      if (!result || (!Object.hasOwn(result, 'code') && !Object.hasOwn(result, 'StatusCode'))
        || (Object.hasOwn(result, 'code') && !successCode(result.code))
        || (Object.hasOwn(result, 'StatusCode') && !successCode(result.StatusCode))) throw failure();
      return true;
    } catch { throw failure(); } finally { clearTimeout(timer); }
  }
  return { send };
}
