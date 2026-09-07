# RackTop 团队预约 API

接口实现位于 `team-web/server/`，使用 Node.js 24+、单服务进程和本地 SQLite。正式默认模式为 `account`（用户名＋密码），另保留本机 `demo` 与可选 `feishu`。本次计划公网入口是 `https://136.0.110.161`，路径均以根级 `/api` 开始；是否已经上线以交付报告为准。

## 传输、身份与错误

请求与响应使用 JSON，写请求必须使用 `Content-Type: application/json`，请求体最大 64 KiB。Host 必须匹配服务配置，所有写入必须携带与 `TEAM_PUBLIC_URL` 完全一致的 `Origin`。网页使用同源 Cookie，先获取 `/api/session`，再在所有写请求携带 `X-CSRF-Token`。

桌面使用 `Authorization: Bearer <设备令牌>`，同样必须携带正确 Origin，不使用网页 Cookie 或 CSRF。只有创建设备登录时提交密码，令牌有效 30 天，桌面应仅将令牌存入操作系统钥匙串。不要在 URL 查询参数或日志中传令牌、密码或认领码。无效 Bearer 不会回退为已登录网页身份。

成功响应结构见各接口。错误格式为：

```json
{"error":{"code":"INVALID_INPUT","message":"输入无效"}}
```

状态码：`401` 未登录／登录失效，`403` 来源、CSRF、权限或认领码拒绝，`404` 不存在，`409` 冲突／旧版本，`413` 请求过大，`415` 媒体类型错误，`422` 输入无效，`429` 限流，`503` 暂时繁忙。`RESERVATION_CONFLICT` 可附 `conflicts: Reservation[]`（最多 50 项）。内部异常与上游秘密不会回显。

时间响应为带时区的 UTC ISO8601，页面展示 Asia/Shanghai。同步采集时间额外接受 Unix 毫秒整数。文本、数组与 ID 均有长度限制，未知 JSON 字段拒绝。

## 数据结构

- `User`：`{id,username?,name,role:'admin'|'member'}`。`username` 属于 account 模式；没有邮箱或邮件验证字段。账号 UUID 由服务端分配，固定姓名不是授权凭据，客户端不能自报 `role` 或 `ownerId`。
- `Gpu`：`{id,uuid,index,model,memoryTotalMb}`。`id` 是服务端稳定 ID，`uuid` 是规范化为小写的真实 NVIDIA 完整硬件 UUID，`index` 是当前显示编号；预约不要用编号代替稳定身份。
- `Resource`：`{id,cluster,name,gpuModel,gpuCount,notes,enabled,gpus,inventoryVersion,inventoryState,lastSeenAt,observedAt,status,pendingGpus}`。清单状态为 `manual|synced|conflict`，在线状态为 `online|offline|unknown`；超过 90 秒的采集显示 unknown。手工资源 `gpus=[]`，CPU 资源 `gpuCount=0`。待确认清单的 GPU 没有已确认的稳定 ID。
- `Reservation`：`{id,resourceId,resourceName,cluster,ownerId,ownerName,scope,gpuIndices,gpuIds,inventoryVersion,startAt,endAt,purpose,status,createdAt,updatedAt,version,plannedEndAt}`。`scope=machine|gpus`，`status=confirmed|cancelled|completed`。提前结束时保存原结束时间 `plannedEndAt`；没有该值时为 null。界面按时间推导未开始／进行中／已到期。

## 账号与会话

| 请求 | 输入／返回 |
| --- | --- |
| `GET /api/session` | 返回会话；首次网页访问创建匿名 CSRF 会话。有效设备 Bearer 可查询自身身份，无效设备令牌返回 401。 |
| `POST /api/auth/register` | `{username,name,password,bootstrapToken?,rememberMe?}` → `201 Session`，注册成功自动登录。 |
| `POST /api/auth/login` | `{username,password,rememberMe?}` → `200 Session`，轮换 Cookie 和 CSRF。 |
| `POST /api/auth/logout` | `{}` → 匿名 `Session`，注销当前网页登录。 |
| `POST /api/auth/change-password` | `{oldPassword,newPassword}` → 新 `Session`；仅网页登录，须当前密码和 CSRF，撤销该账号所有旧会话／设备令牌。 |
| `POST /api/auth/device-login` | `{username,password,deviceName}` → `{token,expiresAt,user}`。无需预先创建 Cookie，但须正确 Origin；携带本网页 Cookie 的调用仍需 CSRF。 |
| `POST /api/auth/device-logout` | 使用设备 Bearer，输入 `{}` → `{ok:true}`，立即撤销该令牌。 |

`Session`：`{user:User|null,csrfToken:string|null,authMode:'account',accountRegistration:true,rememberMe:boolean,feishuConfigured:false,notifications:{configured:boolean},timezone:'Asia/Shanghai'}`。

用户名去除两端空格并转小写，匹配 `[a-z0-9_-]{3,32}`；姓名 1–60 字符、规范化后唯一、注册后固定。密码为 12–128 个 Unicode 字符且不裁剪空格。`rememberMe` 只能为布尔值；省略或 false 时网页登录 8 小时，true 为 30 天。改密保留当前网页登录时长偏好并重新计时。匿名会话 10 分钟过期。

管理员必须用服务端 `TEAM_BOOTSTRAP_TOKEN` 一次性认领，不能通过“第一个注册”或名字获得权限。可用 `TEAM_ADMIN_USERNAME` 保留首次管理员用户名；没有正确码不能抢注该用户名。首页 `/#setup=<认领码>` 只负责向注册表单提供码，服务端在事务中消费并持久化认领状态。用户自己设置账号和密码；服务端没有默认管理员密码。首版没有找回密码或管理员重置密码 API。

错误包括 `INVALID_USERNAME`、`INVALID_NAME`、`INVALID_PASSWORD`、`ACCOUNT_EXISTS`、`INVALID_CREDENTIALS`、`BOOTSTRAP_REQUIRED`、`BOOTSTRAP_REJECTED`、`CSRF_REJECTED`、`DEVICE_LIMIT`、`RATE_LIMITED`。密码使用带随机盐的 scrypt，数据库只保存会话与设备令牌哈希；最多 2 个并发密码计算，不无限排队。最多 500 个账号、500 个匿名会话、2500 个总会话、每账号 8 个网页会话与 8 个设备令牌。

## 公开浏览白名单

只有 account 模式允许以下业务 GET 在没有 Cookie 时公开访问，不会为每次公开读取创建新会话：

| 路径 | 匿名可见内容 |
| --- | --- |
| `GET /api/resources` | 仅 `enabled=true`；公开 `id,cluster,name,gpuModel,gpuCount,enabled,gpus,inventoryVersion,inventoryState,lastSeenAt,observedAt,status`，`notes` 置空，不返回 `pendingGpus` 或同步绑定字段。GPU 公开字段为 `id,uuid,index,model,memoryTotalMb`。 |
| `GET /api/reservations` | 仅启用资源的预约；公开资源、显示姓名、时间、范围、GPU、状态和版本。`ownerId`、`purpose` 置空。 |
| `GET /api/reservations/:id` | 与列表相同投影；资源已停用时返回 404。 |
| `GET /api/health` | `{ok:true}`，无内部信息，所有模式均可用。 |

预约列表支持 `from`、`to`、`mine`，拒绝重复和未知参数；匿名 `mine=true` 返回 401，`mine=false` 可用。缺省窗口为过去 7 天至未来 30 天，最大查询跨度 366 天，最多 1000 条。资源和预约的公开投影使用字段白名单；新内部字段不会自动公开。

已登录成员可读取完整团队资源和排期，包括停用资源、备注和预约用途。因此备注和用途不应用来保存秘密。所有业务写入仍需登录，公开显示姓名并不允许匿名修改或取消同名预约。

## 资源与桌面同步

| 请求 | 输入／权限 |
| --- | --- |
| `GET /api/resources` | `{resources:Resource[]}`；匿名按上面的白名单脱敏。 |
| `POST /api/resources` | 管理员；`{cluster,name,gpuModel,gpuCount,notes?}` → `201 {resource}`，创建手工资源。CPU 数量为 0。 |
| `PATCH /api/resources/:id` | 管理员；`{cluster?,name?,gpuModel?,gpuCount?,notes?,enabled?,acceptInventoryVersion?}` → `{resource}`。同步资源不能手工改写 GPU 数量和型号。 |
| `POST /api/resources/sync` | 管理员 Cookie＋CSRF 或管理员设备 Bearer；见下方载荷 → `{resource}`。普通成员设备返回 403。 |

同步载荷：

```text
{
  sourceId: string,
  serverId: string,
  resourceId?: string,
  cluster: string,
  name: string,
  notes?: string,
  observedAt: Unix毫秒整数或带时区ISO8601,
  status: 'online' | 'offline' | 'unknown',
  gpus: [{uuid, index, name, memoryTotalMb}]
}
```

`sourceId` 是桌面同步来源 ID，`serverId` 是本地连接的稳定 ID，均不能包含 SSH 密码或私钥；`resourceId` 可明确绑定现有资源。桌面仅上传选中的资源清单和连接状态，不上传 SSH 地址、用户名、认证信息或进程列表。同步响应为 `{resource:{...Resource,binding:{sourceId,serverId,authoritative}}}`；`binding` 位于 `resource` 内，供本地保存绑定关系，不出现在公共资源列表。

每份清单最多 64 张 GPU，UUID 与编号不可重复；只接受完整且非全零的 NVIDIA `GPU-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`，不支持伪造编号、MIG UUID 或 NPU 编号。服务端格式验证不能证明恶意管理员报告的硬件真实存在，信任边界仍是已授权的管理员设备。

首次绑定要求在线且采集在 90 秒内，不能比服务端时间超前超过 1 分钟。同一完整硬件集可从其他 SSH 账号关联到原资源，别名不能覆盖权威来源；部分清单、多个已有资源混合或错误显式绑定返回 `TOPOLOGY_CONFLICT`。两个账号只能看到同机互不相交的 GPU 集合时，服务无法自动识别物理机相同，应使用能看到完整清单的权威连接。

离线上报保留硬件，只更新连接信息；过期上报不能回滚清单，收到数据的时间不代替采集时间。卡数变化、换卡或缺卡返回 `409 INVENTORY_CHANGED`，同时持久保存 `pendingGpus` 与 `inventoryState=conflict`，原硬件和预约不删除。管理员通过 `PATCH` 的 `acceptInventoryVersion` 确认**当前版本**；只要还有 `confirmed` 且结束时间在未来的预约就拒绝，需先协调、取消或提前结束。已有未来预约的手工资源也不能直接绑定新硬件，因为无法推断历史 GPU 编号对应的真实卡。

## 预约接口与冲突

| 请求 | 输入／返回 |
| --- | --- |
| `GET /api/reservations?from=ISO&to=ISO&mine=true` | `{reservations:Reservation[]}`；mine=true 仅当前账号。 |
| `POST /api/reservations` | `{resourceId,scope,gpuIndices?,gpuIds?,inventoryVersion?,requestId?,startAt,endAt,purpose}` → `201 {reservation}`。 |
| `GET /api/reservations/:id` | `{reservation}`；匿名按公开白名单，登录成员可查看完整记录。 |
| `PATCH /api/reservations/:id` | 本人或管理员；`{version,startAt?,endAt?,purpose?,scope?,gpuIndices?,gpuIds?,inventoryVersion?}` → `{reservation}`，资源 ID 不可更换。 |
| `POST /api/reservations/:id/cancel` | 本人或管理员；`{version}` → `{reservation}`。 |
| `POST /api/reservations/:id/finish` | 本人或管理员的进行中预约；`{version}` → `{reservation}`。 |

手工资源用 `gpuIndices`，整机传 `[]`。同步资源必须传最新 `inventoryVersion` 和 `gpuIds`；同步整机预约也传 `gpuIds:[]`。指定 GPU 使用稳定 ID，不依赖数字编号。修改或续约同步资源时也要提交最新清单版本，应从当前 `Resource.inventoryVersion` 读取，不能始终沿用预约创建时的版本；GPU 编号重排后预约保留稳定身份，但资源清单版本可能已增加。

可选 `requestId` 只在创建使用。同一账号、同一 requestId、完全相同的输入重试会返回原预约；改变输入返回 `IDEMPOTENCY_CONFLICT`。更换姓名不会创建新身份；当前版本不提供改名接口。

确认冲突条件是同资源且 `existing.start < new.end && existing.end > new.start`，同时任一预约为整机，或 GPU 身份集合相交。同步资源比较稳定 GPU ID；手工资源比较编号。`BEGIN IMMEDIATE` 保护检查与写入，跨连接、跨进程并发同样生效。

相邻区间允许；只把 confirmed 纳入占用。创建允许小于 60 秒的当前时间偏差，单次最长 7 天，开始和结束均限未来 90 天内。已经开始的预约不能改变开始时间，只能在未结束时修改未来结束时间。`version` 提供并发修改保护；旧版本、清单变更和已有冲突需要刷新或人工协调。取消／提前结束释放未来排期，不会结束训练进程，预约到期也不能用于判定实际 GPU 空闲。

## 内部认证契约与可选模式

`createAccountAuth(config)` 与旧 `createAuth(config)` 均提供：

```text
{ resolve(req), handle(req,res,url,body), verifyWrite(req,session), sessionPayload(req), close() }
```

account 模式配置包含 `publicUrl,host,dbPath,now?,nodeEnv?,adminUsername?,bootstrapToken?,trustProxy?,notificationsConfigured?`。解析的账号会话包括 `user,csrfToken,kind:'browser'|'device',expiresAt`。认证处理器自行保护认证写操作，普通业务写入再由 HTTP 层调用 `verifyWrite`。`TEAM_TRUST_PROXY=true` 只允许 loopback 监听且只信任本地代理覆写的有效 `X-Real-IP`；代理不得传递客户端伪造值。

旧 `createAuth` 保留 demo／feishu：

- demo 仅非生产 loopback，`POST /api/auth/demo {userId}` 选择预置演示成员，仍需匿名 CSRF，不得作为生产登录。
- feishu 需要 HTTPS、应用配置、允许租户和管理员平台 ID；`GET /api/auth/feishu/start` 开始 OAuth，`GET /api/auth/feishu/callback` 完成。start 只接受单个有效 `reservation` ID，存入服务端一次性状态，成功后返回对应详情；不接受任意跳转 URL。
- 飞书用户与 account 用户不会自动合并；不能用显示姓名替代平台身份。飞书模式没有匿名业务浏览。

## 网页深链与桌面登录边界

网页首页支持单个 `?resource=<id>` 或 `?reservation=<id>` 参数；ID 限 1–100 个字母、数字、下划线或短横线，重复或不合法参数不作为目标。`resource` 在资源加载后定位并高亮对应机器，不会自动预约或强制弹出登录；资源已停用或不存在时显示不可用提示。`reservation` 打开预约详情，并遵守匿名脱敏规则。

用户名模式下，访客点击机器或 GPU 预约时先登录，成功后保留选定资源、GPU 和起止时间。`/#setup=<一次性码>` 与普通资源深链用途不同：前者只为首次管理员注册提供认领码，读取后移除 fragment，不能用它调用业务 API，也不作为持续登录令牌。

桌面首页可以匿名读取公开排期；管理员调用 `device-login` 后才可 `resources/sync`，普通成员设备令牌不能同步或修改资源目录。设备登录在操作系统钥匙串中保存，网页 Cookie 不传给桌面。预约确认仅建立排期记录，任何账号、设备令牌或预约 ID 都不授予 SSH 登录、终端、文件访问或 GPU 操作系统隔离权限。

## 运维与通知

计划部署 Node.js 24.20.0 在 `/opt/racktop-team/node/bin/node`，构建目录 `/opt/racktop-team/current`，root 专用环境文件 `/etc/racktop-team/service.env`，低权限 `racktop-team` 服务的数据为 `/var/lib/racktop-team/team.sqlite`。目录 0700，数据库与秘密配置 0600。使用流程见 [README.md](README.md)，部署与一次性资源导入见 [deploy/README.md](deploy/README.md)；实际上线以交付报告为准。

预约站点使用根 `/api`；既有共享中继的 `/v1/…` 与 `/healthz` 在 Nginx 中继续指向中继，WebSocket、HTTPS 与证书续期路由必须保留。预约健康检查独立使用 `/api/health`。

`createNotifier(config).send(event)` 支持 created／updated／cancelled／finished／ending 群消息，使用可选 `FEISHU_WEBHOOK_URL` 与 `FEISHU_WEBHOOK_SECRET`。没有配置就不发送。SQLite outbox 使预约提交不依赖即时消息成功；后台失败重试，可能重复，不承诺个人私信或恰好一次。凭据只放服务端环境，客户端秘密只放 OS keyring，不把密码、令牌或 SSH 私钥写入预约用途、资源备注、文档或日志。
