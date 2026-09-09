# RackTop 公网中继 0.3.0

初始部署日期：2026-09-08；0.3.0 源码更新日期：2026-09-09（北京时间）。

公网中继已部署到 Evoxt VM 908342。该服务提供经过身份验证的双向 WebSocket 字节通道；RackTop 1.26.0-linux.8 已接入共享协议，访客需要使用包含本功能的 RackTop 客户端。

## 地址与部署位置

| 项目 | 配置 |
| --- | --- |
| IPv4 API | `https://136.0.110.161` |
| IPv6 API | `https://[2400:8d60:3::1:fb1c:d642]` |
| 健康检查 | [https://136.0.110.161/healthz](https://136.0.110.161/healthz)，正常返回 `{"status":"ok"}` |
| WebSocket | `wss://136.0.110.161` 加创建连接后返回的角色路径 |
| 服务器程序 | `/opt/racktop-relay` |
| 服务 | `racktop-relay.service`，用户 `racktop-relay` |
| 内部监听 | `127.0.0.1:8787`；Nginx 对外提供双栈 443 |
| 证书验证入口 | 双栈 80 的 `/.well-known/acme-challenge/`；其他 HTTP 路径返回 404 |
| 主人应用凭据 | 服务器 `/etc/racktop-relay/owner-token`，权限 0600；源码包和本文均不包含其内容 |

`connection.json` 仅供后续开发接入参考，并非当前 RackTop 已支持的导入格式。

## 已完成与接入边界

已完成：正式 IP TLS 证书、Nginx、低权限中继、主人鉴权、分角色连接令牌、双向传输、容量与流量限制、过期及断开清理、开机启动、证书自动续期。0.3.0 增加仅供资源主人查看的访客公网出口 IP 元数据。

服务仅连接已认证的 host/guest 配对，不接受目的主机、SSH 命令或任意代理地址。服务日志不记录业务数据、请求正文、令牌或访客 IP；公网健康接口和聚合统计仍只暴露运行状态与计数。

WebSocket 内的业务数据由客户端负责端到端 TLS。公网实测已证明内层 TLS 能正常通过中继，并拒绝错误证书；RackTop 使用固定主人证书与 Ed25519 设备签名完成一次性配对，并在每次请求时检查资源授权。外层 WSS 本身只保证客户端到中继的加密。

共享方网关与访客客户端接通了监控、独立终端和文件传输；短时邀请码兑换后绑定设备，设备可在授权期内重新连接。A100 的 SSH 凭据继续留在共享者电脑，不交给中继或访客。

## 0.3 路由、设备重连与连接地址

- `GET /v1/owner`：验证主人 Bearer 凭据；不消费请求或声明主人在线。
- `POST /v1/routes`：主人注册 `{routeId,routeToken,expiresAt}`；最长 7 天，最多 64 个路由。刷新必须携带原路由令牌。
- `GET /v1/pending`：主人读取 `{tickets:[...]}` 并更新在线心跳；客户端每秒轮询。0.3.0 的 host ticket 可以包含规范化后的可选 `guestIp`，旧主人客户端会忽略该新增字段。
- `POST /v1/routes/:id/connect`：访客以该路由的 Bearer 令牌请求新房间；主人离线超过 10 秒则拒绝分配。返回 guest ticket，host ticket 经 pending 提供。guest ticket 不包含 `guestIp`。
- `DELETE /v1/routes/:id`：主人撤销入口，并关闭该路由所有房间。
- 新房间等待配对最长 30 秒，连接寿命同时受房间 24 小时与路由到期时间限制。每路由连接突发 3 次、每分钟 12 次。

重启后主人客户端自动重新注册路由。设备重连复用路由，房间、TLS 连接与设备挑战每次重新建立，终端输入不自动重放。

`guestIp` 只采信来自本机 loopback 反向代理连接的单个合法 `X-Forwarded-For`。生产 Nginx 使用 `$remote_addr` 覆盖访客自行提交的同名请求头；多值、空值和非法地址均被忽略，IPv4-mapped IPv6 会规范化为 IPv4。该值只短暂存在内存中的主人待处理票据，不返回访客、不进入健康接口或统计、不写日志或持久化。它表示连接时的公网出口地址；NAT 下多台设备可能显示同一地址，不能作为用户身份或精确位置。

## 原房间协议（保留兼容）

1. 共享方调用 `POST /v1/rooms`，携带 `Authorization: Bearer <owner-token>`。请求正文为空或精确的 `{}`。禁止 Origin、query 参数、WebSocket 子协议头，以及自行指定转发目标。
2. 创建成功返回 HTTP 201：`roomId`、`hostToken`、`guestToken`、`hostPath`、`guestPath`、`expiresAt`（Unix 毫秒）、`sessionMaxAgeMs`。客户端应将令牌当作敏感凭据，不放入 URL 或日志。
3. 两端分别升级到返回的路径，例如 `/v1/rooms/<roomId>/host` 与 `/v1/rooms/<roomId>/guest`，各自以 Authorization 头提交对应令牌。主人长期凭据不能作为角色令牌使用，也不能给访客。
4. 两端连接后，各收到一条文本消息 `{"type":"ready"}`。收到此消息前不能发送业务数据；之后仅允许非空二进制消息。客户端应先建立并验证内层 TLS，再交换邀请秘密和业务请求。
5. 每个角色只允许一个连接；重复连接返回 409。任一端断开会关闭另一端并销毁房间，旧路径与令牌不能恢复会话。需要由共享方创建新房间重新配对，不能自动重放终端输入。

错误状态：未认证 401、未知路由 404、达到容量上限 429、非法请求 400。WebSocket 1008 表示协议或速率限制，1009 表示消息过大，1013 表示缓冲或写入超时。服务重启会清空内存中的房间，主人的应用凭据保留。

## 小团队默认限制

| 项目 | 上限或行为 |
| --- | --- |
| 房间/连接 | 16 个房间、32 条角色 WebSocket |
| 配对等待 | 创建后 10 分钟 |
| 配对后会话 | 最长 24 小时 |
| 单条业务消息 | 64 KiB，禁止空消息与文本消息 |
| 每房间吞吐 | 双向共享 4 MiB/s，1 MiB 突发预算 |
| 缓冲 | 每房间最多 1 MiB，在途写入最多 1024 次，包含控制帧开销 |
| 写超时 | 10 秒，超时关闭双方 |
| 心跳 | 每 20 秒；下一轮仍未收到 Pong 则关闭 |
| 控制帧 | 每个角色 Ping/Pong 合计 20 次/秒，最多突发 20 次 |
| 服务内存 | systemd 上限 384 MiB，Node 堆上限 192 MiB |

带宽限制是超限拒绝，并非服务器自动平滑排队。客户端上传/下载必须分块、处理背压并节流，同时给交互操作留出余量。16 个房间包括正在等待配对的房间，并不等于 16 个独立用户。

## 证书与维护

Let’s Encrypt 证书覆盖两个公网 IP，使用 `shortlived` profile。首次证书有效期至 2026-09-14 08:12:56 UTC（北京时间 16:12:56）；正常续期后日期会更新，不应依赖此初始日期。

`racktop-certbot-renew.timer` 每 6 小时检查一次，加入最多 30 分钟随机延迟，并补跑错过的触发。成功续期后执行 `nginx -t` 和 reload。必须保持 80 的 ACME 路径可从公网访问。

服务器安装 Certbot 5.8.0 于独立 Python 环境 `/opt/racktop-certbot`，避免使用 Ubuntu 仓库不支持 IP 签发的旧版本。完整依赖版本在 `deploy/certbot-requirements.txt`。

在服务器上检查：

```bash
systemctl status racktop-relay nginx --no-pager
systemctl list-timers racktop-certbot-renew.timer --all
journalctl -u racktop-relay -u racktop-certbot-renew.service -n 50 --no-pager
/opt/racktop-certbot/bin/certbot certificates
```

重启中继会关闭当前所有房间：

```bash
systemctl restart racktop-relay
```

停止共享入口：

```bash
systemctl stop racktop-relay
```

暂停后恢复：`systemctl start racktop-relay`。服务器原有 SSH 管理方式可继续使用；本轮未添加长期 SSH 管理公钥。

## 测试

0.3.0 源码测试在本机 Node 20 为 30/30 通过，新增覆盖 IPv4、IPv6、IPv4-mapped IPv6、非法及多值转发头、非受信连接和访客响应隔离；服务器部署后的复验另行记录。0.2.0 曾在本机 Node 20 和服务器 Node 22.22.1 以 27/27 通过身份验证、角色抢占、过期清理、二进制顺序、限制、慢连接及控制帧边界。

真实公网 smoke 为 6/6 通过：健康检查、无凭据 401、角色令牌交换拒绝、WSS 双向各 256 KiB、内层 TLS 双向各 256 KiB、错误内层证书拒绝，共验证 1,048,576 字节。使用标准外层证书校验，没有关闭 TLS 验证。

测试程序通过 stdin 读取主人应用凭据，不回显、不保存。可从能安全登录服务器的电脑运行：

```bash
ssh root@136.0.110.161 'cat /etc/racktop-relay/owner-token' |
  node scripts/smoke.mjs https://136.0.110.161
```

请在源码目录执行，并使用已验证的 SSH 主机身份。该命令不会打印应用令牌；不要把令牌手工放入命令行参数或分享给访客。

证书首次申请演练和自动续期演练均成功，续期时的 Nginx reload hook 已实际执行。RackTop 1.26.0-linux.8 已通过实际公网中继访问 A100 的监控、终端、262181 字节文件往返与 SHA-256 校验、同设备重连、撤销后断开并拒绝重连。两端 Rust 客户端运行在同一电脑上，经真实公网中继；尚未进行两位同事、两台不同网络电脑的实机验收，也未进行 VM 整机重启测试。

## 在新 VM 复现

部署配置固定使用本次两个 IP，迁移时需先修改地址并重新申请证书。运行前安装依赖可使用 `npm ci --ignore-scripts --omit=optional`，。

1. 将本目录放到服务器 `/opt/racktop-relay`，以 root 执行 `bash deploy/bootstrap.sh`。它仅用于新 VM 的首次准备，会将 Nginx 切到仅供证书验证的配置；不要将其作为运行中服务的更新脚本。
2. 执行下列命令，首次先追加 `--dry-run` 验证，成功后再移除以签发正式证书：

```bash
/opt/racktop-certbot/bin/certbot certonly \
  --non-interactive --agree-tos --required-profile shortlived \
  --preferred-challenges http --webroot --webroot-path /var/www/letsencrypt \
  --cert-name racktop-relay-ip \
  --ip-address 136.0.110.161 \
  --ip-address 2400:8d60:3::1:fb1c:d642
```

3. `node --test test/relay.test.mjs`，通过后执行 `bash deploy/activate.sh`。该步骤创建无登录权限的服务账号和随机应用令牌，并启动服务。
4. 验证公网 smoke 和 `/opt/racktop-certbot/bin/certbot renew --cert-name racktop-relay-ip --dry-run --run-deploy-hooks --no-random-sleep-on-renew`。

参考：[Let’s Encrypt IP 证书与 Certbot 指南](https://letsencrypt.org/2026/03/11/shorter-certs-certbot)、[证书 profile](https://letsencrypt.org/docs/profiles/)、[Certbot 参数手册](https://eff-certbot.readthedocs.io/en/stable/man/certbot.html)、[ws 官方实现](https://github.com/websockets/ws)。
