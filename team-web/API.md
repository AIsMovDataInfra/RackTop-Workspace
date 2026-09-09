# AIsMov RackTop 团队工作台 API（2.0.0）

接口实现位于 `team-web/server/`，使用 Node.js 24+、单服务进程和本地 SQLite。正式默认模式为 `account`（用户名＋密码），另保留本机 `demo` 与可选 `feishu`。已部署的公网入口是 `https://136.0.110.161`，路径均以根级 `/api` 开始。

本版设备录入、成员公司管理、密码找回、头像、周报与设备申请使用 `account` 模式；`/api/workspace/*` 在其他模式返回 `403 ACCOUNT_REQUIRED`。`demo`／`feishu` 尚未提供公司身份，暂不支持新增设备；已登录用户仍可查看和维护已有设备的其他字段及照片。完整录入验收请使用独立的 `account` 测试库；当前线上账号模式不受此限制。

## 传输、身份与错误

普通接口使用 JSON；照片读取返回 JPEG 二进制。写请求必须使用 `Content-Type: application/json`，普通请求体最大 64 KiB，仅照片 POST 放宽到 2 MiB（解码前原始图片仍最多 1 MiB）。Host 必须匹配服务配置，所有写入必须携带与 `TEAM_PUBLIC_URL` 完全一致的 `Origin`。网页使用同源 Cookie，先获取 `/api/session`，再在所有写请求携带 `X-CSRF-Token`。

桌面使用 `Authorization: Bearer <设备令牌>`，同样必须携带正确 Origin，不使用网页 Cookie 或 CSRF。只有创建设备登录时提交密码，令牌有效 30 天，桌面应仅将令牌存入操作系统钥匙串。不要在 URL 查询参数或日志中传令牌、密码或认领码。无效 Bearer 不会回退为已登录网页身份。

成功响应结构见各接口。错误格式为：

```json
{"error":{"code":"INVALID_INPUT","message":"输入无效"}}
```

状态码：`401` 未登录／登录失效，`403` 来源、CSRF、权限或认领码拒绝，`404` 不存在，`409` 冲突／旧版本，`413` 请求过大，`415` 媒体类型错误，`422` 输入无效，`429` 限流，`503` 暂时繁忙。`RESERVATION_CONFLICT` 可附 `conflicts: Reservation[]`（最多 50 项）。内部异常与上游秘密不会回显。

时间响应为带时区的 UTC ISO8601，页面展示 Asia/Shanghai。同步采集时间额外接受 Unix 毫秒整数。业务文本、数组与 ID 有各自限制；账号用户名和密码规则见下一节。未知 JSON 字段拒绝。

## 数据结构

- `User`：account 模式返回 `{id,username,name,role:'admin'|'member',isSuperAdmin:boolean,company:Company|null,version:number,avatar:Avatar}`；demo／feishu 仍可省略账号专有字段。`Company` 只能为 `A公司`、`B公司`、`C公司`、`西浦`，null 表示尚未分配。`role:'admin'` 是资源管理员身份，只有 `isSuperAdmin:true` 才能管理成员。`Avatar` 为 `user|cat|dog|rocket|robot|flower|star`，旧记录默认 user。没有邮箱字段；客户端不能自报 `role`、`isSuperAdmin` 或 `ownerId`。
- `Member`：仅超级管理员成员接口返回 `{...User,createdAt,recoveryRequestedAt}`；后两项为 UTC ISO8601，尚无找回申请时 `recoveryRequestedAt=null`。只含账号业务信息，不返回密码、密码哈希、会话／设备令牌或内部管理审计记录。
- `Gpu`：`{id,uuid,index,model,memoryTotalMb}`。`id` 是服务端稳定 ID，`uuid` 是规范化为小写的真实 NVIDIA 完整硬件 UUID，`index` 是当前显示编号；预约不要用编号代替稳定身份。
- `Resource`：`{id,company,companyVersion,cluster,name,gpuModel,gpuCount,notes,enabled,gpus,inventoryVersion,inventoryState,lastSeenAt,observedAt,status,pendingGpus}`。`company` 为 Company 或旧未分配记录的空串，`companyVersion` 为正整数。清单状态为 `manual|synced|conflict`，在线状态为 `online|offline|unknown`；超过 90 秒的采集显示 unknown。手工资源 `gpus=[]`，CPU 资源 `gpuCount=0`。待确认清单的 GPU 没有已确认的稳定 ID。
- `Reservation`：`{id,company,resourceId,resourceName,cluster,ownerId,ownerName,scope,gpuIndices,gpuIds,inventoryVersion,startAt,endAt,purpose,status,createdAt,updatedAt,version,plannedEndAt}`。`scope=machine|gpus`，`status=confirmed|cancelled|completed`。提前结束时保存原结束时间 `plannedEndAt`；没有该值时为 null。界面按时间推导未开始／进行中／已到期。公司、资源名称与集群在预约建立时保存快照，资源后续跨公司调整不会将历史预约移动给新公司。

## 账号与会话

| 请求 | 输入／返回 |
| --- | --- |
| `GET /api/session` | 返回会话；首次网页访问创建匿名 CSRF 会话。有效设备 Bearer 可查询自身身份，无效设备令牌返回 401。 |
| `POST /api/auth/register` | `{name,password,username?,bootstrapToken?,rememberMe?}` → `201 Session`，注册成功自动登录，`company=null`，等待超级管理员分配公司；注册请求不能自选公司或超管身份。 |
| `POST /api/auth/login` | `{username,password,rememberMe?}` → `200 Session`，轮换 Cookie 和 CSRF。 |
| `POST /api/auth/logout` | `{}` → 匿名 `Session`，注销当前网页登录。 |
| `POST /api/auth/recovery-request` | `{username}` → `200 {ok:true}`；须先获取匿名或已登录网页 CSRF，会话无需已有用户。账号存在与否返回相同结构，不直接修改密码或发邮件。 |
| `POST /api/auth/profile` | `{version,avatar}` → 新 `Session`；修改本人内置头像，需有效会话和写入校验，不可修改公司/姓名，旧 version 返回 409。 |
| `POST /api/auth/change-password` | `{oldPassword,newPassword}` → 新 `Session`；仅网页登录，须当前密码和 CSRF，撤销该账号所有旧会话／设备令牌。 |
| `POST /api/auth/device-login` | `{username,password,deviceName}` → `{token,expiresAt,user}`。无需预先创建 Cookie，但须正确 Origin；携带本网页 Cookie 的调用仍需 CSRF。 |
| `POST /api/auth/device-logout` | 使用设备 Bearer，输入 `{}` → `{ok:true}`，立即撤销该令牌。 |

`Session`：`{user:User|null,csrfToken:string|null,authMode:'account',accountRegistration:true,rememberMe:boolean,feishuConfigured:false,notifications:{configured:boolean},timezone:'Asia/Shanghai'}`。

新客户端只提供 `name` 和密码，名称同时用作显示名与登录名；`name` 必须是字符串，去除两端空白后非空即可，不另设长度或字符格式限制、不做 NFC 等 Unicode 规范化；保留实际输入字符，不可重名且注册后固定。兼容旧客户端可继续提供 `username` 与 `name`，已有账号二者和 UUID 不被改写。登录仍提交 `username`（新账号填名称，旧账号填原用户名），登录键去除两端空格并转小写；`name`、兼容 `username` 和密码均不另设字段长度上限，但整次 JSON 请求仍受 64 KiB 上限约束。新密码须非空且不能全为空白，原样保存，不裁剪空格；登录继续兼容旧账号已设置的含空格密码。`rememberMe` 只能为布尔值；省略或 false 时网页登录 8 小时，true 为 360 天。改密保留当前网页登录时长偏好并重新计时。匿名会话 10 分钟过期。

超级管理员由部署端显式执行 `scripts/team-admin.mjs create` 创建，默认用户名为 `admin`，密码只从受保护的标准输入读取，没有代码内置密码，也不在服务启动时自动创建或重置。数据库只允许一个超级管理员；同名普通账号已存在时命令拒绝抢占或提权。重复 create 保留已有超级管理员密码；明确执行 reset 才会重置其密码并撤销旧会话。

原 `TEAM_BOOTSTRAP_TOKEN`／`TEAM_ADMIN_USERNAME` 和 `/#setup=<认领码>` 保留为一次性资源管理员认领路径；消费状态持久保存。它只授予 `role:'admin'`，不会授予超级管理员，也不自动分配公司。首个注册者或自报管理员姓名都不会获得额外权限。

找回申请仅记录 `recoveryRequestedAt`；首次尚未处理的申请使账号 version 递增，重复待处理申请不继续递增。每 IP 最多 10 次／15 分钟、每规范化用户名最多 3 次／小时。网页“忘记密码？”或 `?auth=recover` 提交后显示统一提示，由超级管理员核实身份后重置；未知账号不泄露存在性。重置成功或成员自己改密会清除申请并撤销旧网页会话与设备令牌。

错误包括 `INVALID_USERNAME`、`INVALID_NAME`、`INVALID_PASSWORD`、`ACCOUNT_EXISTS`、`INVALID_CREDENTIALS`、`BOOTSTRAP_REQUIRED`、`BOOTSTRAP_REJECTED`、`CSRF_REJECTED`、`DEVICE_LIMIT`、`RATE_LIMITED`。密码使用带随机盐的 scrypt，数据库只保存会话与设备令牌哈希；最多 2 个并发密码计算，不无限排队。最多 500 个未删除账号、500 个匿名会话、2500 个总会话、每账号 8 个网页会话与 8 个设备令牌。

## 超级管理员与成员管理

account 模式提供的 `/api/admin/members` 接口仅接受超级管理员身份；普通成员或只有 `role:'admin'` 的资源管理员返回 `403 SUPERADMIN_REQUIRED`。支持超级管理员网页 Cookie（写入需 CSRF）或设备 Bearer，仍要求正确 Origin。接口不接受任何查询参数。

| 请求 | 输入／返回 |
| --- | --- |
| `GET /api/admin/members` | `200 {members:Member[]}`，返回全部未删除账号，按创建时间、ID 排序，包含超级管理员。 |
| `POST /api/admin/members` | `{name,password,company,username?}` → `201 {member:Member}`；创建 `role:'member',isSuperAdmin:false` 员工，company 必选。 |
| `PATCH /api/admin/members/:id` | `{version,company}` → `200 {member:Member}`；只修改公司，不能清空或修改用户名、姓名、角色。公司相同则不递增版本。 |
| `POST /api/admin/members/:id/reset-password` | `{version,newPassword}` → `200 {member:Member}`；设置新密码，清除找回申请、递增版本并撤销该员工所有网页登录与设备令牌。 |
| `DELETE /api/admin/members/:id` | `{version}` → `200 {ok:true}`；撤销登录、删除登录凭据并将账号标记为已删除，保留历史业务记录。 |

修改／重置／删除必须携带当前正整数 version，过期返回 `409 VERSION_CONFLICT`。找回申请也会改变版本，管理员应刷新后核对再操作。重置／删除不能针对超级管理员或操作者自己，返回 `403 SUPER_ADMIN_PROTECTED`；超级管理员可在自己的“设置”中凭当前密码改密，遗忘时由部署端显式执行 `team-admin.mjs reset`。公司 PATCH 允许给超级管理员设置公司，但其业务资格不依赖公司。

删除会释放原用户名与显示姓名，新注册同名账号取得新的 UUID，不继承旧账号身份。原预约、设备、负责人／使用人文字和修改历史保留，不自动取消预约或删除设备。创建、公司修改、重置和删除与内部审计同事务提交；审计不保存密码。新增错误含 `INVALID_COMPANY`、`INVALID_AVATAR`、`INVALID_VERSION`、`MEMBER_NOT_FOUND`、`SUPERADMIN_REQUIRED`、`SUPER_ADMIN_PROTECTED`。

## 成员访问边界

所有模式的业务 API 都要求有效的 `member` 或 `admin` 身份，包含资源、预约、设备列表、详情、修改历史与照片。account 模式还要求超级管理员身份或有效公司；未分配公司的普通成员和资源管理员返回 `403 COMPANY_REQUIRED`，Cookie 与设备 Bearer 均受此限制。无会话、已过期会话或已撤销的设备令牌返回 401；不支持的角色返回 403。没有匿名业务读取白名单，不能通过扫码地址、资源 ID、显示姓名或旧图片 URL 跳过登录。

静态页面和资源文件仍可获取，用于显示登录／注册界面；`GET /api/session` 提供当前身份或匿名 CSRF 会话，`GET /api/health` 返回 `{ok:true}`。注册、登录等认证入口按上一节各自校验 Origin、CSRF、凭据与认领码。匿名能取得网页壳不代表能取得业务数据。

account 模式的普通成员和资源管理员只可读取本公司完整资源、排期、设备和照片，包括备注、预约用途与待确认 GPU 清单；直接请求其他公司详情返回 404。公司未知的旧资源或设备只对超管可见，分配后才开放。普通成员可创建自己的预约、维护本公司实物设备；资源创建、修改和同步仅限本公司管理员或超管，预约修改/取消/提前结束仍限本人或本公司管理员。只有超管能跨公司管理及读取成员名册。设备负责人或使用人姓名不是授权依据。

周报还检查作者或指定评审人身份，设备申请读接口仅超管可用，见工作台接口。未分配成员仍可查询 session、退出、选择头像、申请找回及凭当前密码改密，网页等待页每 30 秒或恢复焦点检查分配状态并保留原深链接。客户端遇到 `COMPANY_REQUIRED` 或 `SUPERADMIN_REQUIRED` 时应立即隐藏受限数据并重新查询 session；401 回到登录。身份公司变更由实时会话查询生效，不把旧公司的业务资料继续留在页面中。

预约列表支持 `from`、`to`、`mine`，拒绝重复和未知参数；`mine=true` 仅返回当前账号的预约。缺省窗口为过去 7 天至未来 30 天，最大查询跨度 366 天，最多 1000 条。

## 硬件设备台账

设备台账用于登记实物设备，与算力预约的 `Resource` 分开存储。新库不创建示例设备，也不自动把 SSH 连接转换成实物。设备档案、永久编号分配、修改历史和照片与账号、预约共用 `TEAM_DB_PATH` 指定的 SQLite 文件。

下列接口都需要有效业务成员身份（account 模式须已分配公司或为超级管理员）；所有写入还需要同源 Origin，网页 Cookie 调用需要 CSRF，设备 Bearer 调用遵守前述设备认证规则。

| 请求 | 输入／返回 |
| --- | --- |
| `GET /api/equipment` | `{equipment:Equipment[]}`，只含当前公司可见设备（超管跨公司），包括已退役设备，按更新时间倒序、八位编号排序。 |
| `POST /api/equipment` | 设备可写字段 → `201 {equipment:Equipment}`。 |
| `GET /api/equipment/:id` | `{equipment:Equipment,history:EquipmentChange[]}`。 |
| `PATCH /api/equipment/:id` | `{version,...修改字段}` → `200 {equipment:Equipment}`。 |

`Equipment` 包含 `id,code,serialNumber,legacySerialNumber,name,category,model,company,responsiblePerson,currentUser,location,notes,status,photo,version,createdAt,updatedAt`。时间为 UTC ISO8601；新设备 `version=1`。响应按业务字段投影，不返回创建者、编辑者或历史操作人的账号 ID，不嵌入图片 BLOB。

### 固定编号与旧记录迁移

`id` 是服务端分配的固定 UUID，二维码使用 `/equipment/:id` 页面链接。`serialNumber` 是服务端生成的八位数字字符串，从 `00000001` 递增；客户端不得指定或修改，数据库触发器也禁止改号。编号分配与创建同一事务提交，并使用永久 AUTOINCREMENT 分配记录，已提交编号不会因重启、退役或删除底层设备行而回收。并发创建不会分配重复编号。八位编号空间用尽返回 `409 SERIAL_EXHAUSTED`。

旧记录首次升级按 `created_at`、相同时间下的原行插入顺序分配新编号。原自由填写的序列号原样保存在只读 `legacySerialNumber`，没有旧值时为空串；旧 `code`（`RT-XXXXXXXX`）和 UUID 保留，二维码无需重贴。迁移在事务中执行，失败整体回滚，重启重试不会对已迁移记录重新编号。新界面以 `serialNumber` 为主要编号。

网页标签为“固定资产标识码”表格，含公司名称、资产编号、资产名称、责任人、使用人及稳定二维码，支持完整 SVG、单独二维码下载和打印。修改档案后二维码不变，纸面文字需重新打印。

没有删除设备的接口；停用设备设为 `retired`，原二维码仍可由具备业务访问资格的登录成员读取。设备本体 `PUT`、`DELETE` 返回 405；下方照片子资源支持独立删除。

### 可写字段与版本

| 字段 | 规则 |
| --- | --- |
| `name` | 必填，去除首尾空白后非空，最多 120 字符。 |
| `category` | 新建必选，值只能为 `机械臂`、`台式主机`、`显示屏`、`摄像头模组`、`实验物料`、`小推车`、`夹爪`。 |
| `model` | 可选，最多 160 字符。 |
| `company` | 设备所属公司。普通成员新建省略时由服务端取其账号公司，不能提交其他公司；超级管理员新建必须选择四项 Company 之一。普通成员新建/编辑只可选自己公司，超管可跨公司修改，仍需 version。 |
| `responsiblePerson` | 可选，最多 80 字符；负责人。网页新建时默认当前成员姓名，服务端不自动填入，也不新增必填限制。 |
| `currentUser` | 可选，最多 80 字符；当前使用人，与负责人独立。传空串可单独清空。 |
| `location` | 新建必选，只能为 `上海` 或 `太仓`。 |
| `notes` | 可选，最多 4000 字符，允许多行。 |
| `status` | `available`、`in_use`、`maintenance`、`retired`，新建省略时为 `available`。 |

除 company 的专用规则外，可选文本新建省略时为空串，修改时传空串清空、省略则保留。文本去除首尾空白，拒绝控制字符；HTML 内容作为普通文本保留，由 React 转义显示。`id`、`code`、`serialNumber`、`legacySerialNumber`、`photo`、时间和创建者／编辑者等不属于可写字段，客户端提交会被白名单拒绝。设备最多 5000 条，达到上限返回 `409 EQUIPMENT_LIMIT`；列表筛选在页面本地执行。设备本体接口不支持查询参数。

升级前设备 company 默认为空串（显示“待分配”），不会根据创建者或当前成员猜测归属。旧空公司仅超管可查看和维护；普通成员不允许请求其档案或照片。普通成员提交其他公司返回 403；超管将公司清空或设为枚举外值返回 `422 INVALID_INPUT`。设备公司与员工公司独立保存，修改员工公司不会重分配设备。

旧类别、位置即使不在新枚举中也保留展示，不自动猜测映射；后续任何普通 PATCH（包括领用、归还）都必须使合并后的类别、位置合法，必要时一起提交新值。照片操作不要求同时修正这些旧字段。

领用通常提交 `{version,currentUser,status:'in_use'}`；归还提交 `{version,currentUser:'',status:'available'}`，可同时更新合法位置，均不自动改变 `responsiblePerson`。这两个姓名是台账文本，不是账号归属或权限判定字段。

修改必须携带当前整数 `version`，至少提交一个可写字段。版本过期返回 `409 VERSION_CONFLICT`，客户端应保留草稿、读取最新资料并让用户核对，不能自动覆盖。普通 PATCH 实际内容未改变时返回原对象，不递增版本或增加历史；成功修改在同一 `BEGIN IMMEDIATE` 事务中更新设备、递增版本并写历史，任何一步失败都会回滚。

`EquipmentChange` 为 `{actorName,action:'created'|'updated',at,changes:[{field,oldValue,newValue}]}`；值为字符串或 null，照片变化使用 `field:'photo'` 与可读描述，不保存图片内容到历史。详情返回最近 30 次有权查看的记录，普通成员按事件公司过滤，超管可看完整历史；移交事件归原公司，防止其他字段 oldValue 随公司变更泄露给新公司。无法确认公司的旧历史仅超管可见。记录最新在前，同一毫秒内仍按写入顺序排列。`actorName` 来自真实登录账号，不接受客户端自报；完整内部记录保存实际账号 ID。

### 设备照片

每台设备最多一张照片。`photo` 为 null 或 `{url,width,height,bytes,updatedAt}`；`bytes` 是压缩后的字节数，`url` 形如 `/api/equipment/<id>/photo?v=<设备版本>`，不是公开下载凭据。列表和详情仅查询照片元数据，图片二进制只由照片 GET 返回。

| 请求 | 输入／返回 |
| --- | --- |
| `GET /api/equipment/:id/photo` | 具备业务访问资格的成员读取 JPEG 二进制；`Content-Type: image/jpeg`、`Cache-Control: no-store`、`X-Content-Type-Options: nosniff`。无设备返回 404，无图返回 `404 PHOTO_NOT_FOUND`。 |
| `POST /api/equipment/:id/photo` | `{version,dataUrl}` → `200 {equipment:Equipment}`；新增或替换照片。 |
| `DELETE /api/equipment/:id/photo` | `{version}` → `200 {equipment:Equipment}`；仅移除照片，不删除设备。 |

照片路由仅允许可选且不重复的正整数 `v` 查询参数，用于刷新 URL，不提供历史图片版本；未知或重复参数返回 422。POST 的 `dataUrl` 仅接受规范 Base64 编码的 `data:image/jpeg`、`data:image/png` 或 `data:image/webp`；请求体最多 2 MiB，解码后的输入文件最多 1 MiB，输入最多 2000 万像素且必须为单张静态图片。客户端不能提交宽高、文件名、路径或其他元数据。

网页先在本机压缩照片；服务端仍用 sharp 核对真实格式和像素、解码、按方向旋转、去除 EXIF 等元数据、缩小并重新编码为 JPEG。最终宽高均不超过 1600 像素，大小不超过 512 KiB；原图不持久保存。服务端最多同时处理两张照片，繁忙时返回 503，不无限排队。格式不支持返回 415，坏图或过大像素返回 422，文件或请求体过大返回 413。

上传在接收图片前验证成员与写权限，压缩前检查版本，异步压缩后重新验证会话、角色、公司资格和 CSRF，最后由存储事务再次执行版本 CAS。与普通编辑竞争同一版本时，最多一个请求成功，其余返回 409；压缩期间注销则返回 401 且不写入。上传／替换和删除照片与设备版本递增、真实编辑者及历史写入为同一事务；失败不丢失旧图。删除已无照片的设备时，仍校验版本，成功后保持原版本且不添加历史。

压缩中客户端断开后不再写入；服务关闭中的存活请求结束为 503。服务等待在途处理与原通知任务完成后再关闭数据库，避免已断开连接的后台处理读取已关闭的认证库。

压缩后的 JPEG 保存在同库 `equipment_photos` BLOB 表，尺寸、大小、更新时间与图片一起保存。现有一致性 SQLite 备份自动包含照片、设备、永久编号分配及历史，无需另行复制图片目录；不要只复制正在使用的 `.sqlite` 主文件而遗漏 WAL。恢复时停服务、恢复完整快照，保留原 UUID 和编号分配记录。台账字段、照片及备份均需按团队资料限制访问。

## 资源与桌面同步

| 请求 | 输入／权限 |
| --- | --- |
| `GET /api/resources` | `{resources:Resource[]}`；仅具备业务访问资格的成员，返回本公司目录，超管可跨公司查看（包括待分配资源）。 |
| `POST /api/resources` | 管理员；`{cluster,name,gpuModel,gpuCount,notes?,company?}` → `201 {resource}`，创建手工资源。CPU 数量为 0。 |
| `PATCH /api/resources/:id` | 管理员；`{cluster?,name?,gpuModel?,gpuCount?,notes?,enabled?,acceptInventoryVersion?,company?,companyVersion?}` → `{resource}`。同步资源不能手工改写 GPU 数量和型号。 |
| `POST /api/resources/sync` | 管理员 Cookie＋CSRF 或管理员设备 Bearer；见下方载荷 → `{resource}`。普通成员设备返回 403。 |

account 资源创建时普通管理员公司由会话确定，不能指定别家公司；超管可指定四家公司之一，未分配资源暂不可预约。调整已有资源公司只限超管，并须提供当前 `companyVersion`；已有公司不可清空，存在未结束的 confirmed 预约返回 `409 RESOURCE_HAS_RESERVATIONS`。公司版本不匹配返回 `409 VERSION_CONFLICT`，其他不涉及公司变更的修改不要求 companyVersion。旧空公司初次分配会给其旧未分配预约补齐公司；之后公司变更不迁移已有预约快照。

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

同步已有绑定、显式 resourceId 或相同 GPU UUID 对应的资源时都会核对公司；不能借已知 ID/UUID 跨公司读写。新资源采用操作人的公司，超管无公司时先生成仅超管可见的待分配资源；同步输入不接受 company，分配在网页资源管理中完成。

`sourceId` 是桌面同步来源 ID，`serverId` 是本地连接的稳定 ID，均不能包含 SSH 密码或私钥；`resourceId` 可明确绑定现有资源。桌面仅上传选中的资源清单和连接状态，不上传 SSH 地址、用户名、认证信息或进程列表。同步响应为 `{resource:{...Resource,binding:{sourceId,serverId,authoritative}}}`；`binding` 位于 `resource` 内，供本地保存绑定关系，不出现在常规资源列表。

每份清单最多 64 张 GPU，UUID 与编号不可重复；只接受完整且非全零的 NVIDIA `GPU-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`，不支持伪造编号、MIG UUID 或 NPU 编号。服务端格式验证不能证明恶意管理员报告的硬件真实存在，信任边界仍是已授权的管理员设备。

首次绑定要求在线且采集在 90 秒内，不能比服务端时间超前超过 1 分钟。同一完整硬件集可从其他 SSH 账号关联到原资源，别名不能覆盖权威来源；部分清单、多个已有资源混合或错误显式绑定返回 `TOPOLOGY_CONFLICT`。两个账号只能看到同机互不相交的 GPU 集合时，服务无法自动识别物理机相同，应使用能看到完整清单的权威连接。

离线上报保留硬件，只更新连接信息；过期上报不能回滚清单，收到数据的时间不代替采集时间。卡数变化、换卡或缺卡返回 `409 INVENTORY_CHANGED`，同时持久保存 `pendingGpus` 与 `inventoryState=conflict`，原硬件和预约不删除。管理员通过 `PATCH` 的 `acceptInventoryVersion` 确认**当前版本**；只要还有 `confirmed` 且结束时间在未来的预约就拒绝，需先协调、取消或提前结束。已有未来预约的手工资源也不能直接绑定新硬件，因为无法推断历史 GPU 编号对应的真实卡。

## 预约接口与冲突

| 请求 | 输入／返回 |
| --- | --- |
| `GET /api/reservations?from=ISO&to=ISO&mine=true` | `{reservations:Reservation[]}`；mine=true 仅当前账号。 |
| `POST /api/reservations` | `{resourceId,scope,gpuIndices?,gpuIds?,inventoryVersion?,requestId?,startAt,endAt,purpose}` → `201 {reservation}`。 |
| `GET /api/reservations/:id` | `{reservation}`；当前公司有权限的成员可查看完整记录，超管跨公司。 |
| `PATCH /api/reservations/:id` | 本人或管理员；`{version,startAt?,endAt?,purpose?,scope?,gpuIndices?,gpuIds?,inventoryVersion?}` → `{reservation}`，资源 ID 不可更换。 |
| `POST /api/reservations/:id/cancel` | 本人或管理员；`{version}` → `{reservation}`。 |
| `POST /api/reservations/:id/finish` | 本人或管理员的进行中预约；`{version}` → `{reservation}`。 |

手工资源用 `gpuIndices`，整机传 `[]`。同步资源必须传最新 `inventoryVersion` 和 `gpuIds`；同步整机预约也传 `gpuIds:[]`。指定 GPU 使用稳定 ID，不依赖数字编号。修改或续约同步资源时也要提交最新清单版本，应从当前 `Resource.inventoryVersion` 读取，不能始终沿用预约创建时的版本；GPU 编号重排后预约保留稳定身份，但资源清单版本可能已增加。

可选 `requestId` 只在创建使用。同一账号、同一 requestId、完全相同的输入重试会返回原预约；改变输入返回 `IDEMPOTENCY_CONFLICT`。更换姓名不会创建新身份；当前版本不提供改名接口。

确认冲突条件是同资源且 `existing.start < new.end && existing.end > new.start`，同时任一预约为整机，或 GPU 身份集合相交。同步资源比较稳定 GPU ID；手工资源比较编号。`BEGIN IMMEDIATE` 保护检查与写入，跨连接、跨进程并发同样生效。

相邻区间允许；只把 confirmed 纳入占用。创建允许小于 60 秒的当前时间偏差，单次最长 7 天，开始和结束均限未来 90 天内。已经开始的预约不能改变开始时间，只能在未结束时修改未来结束时间。`version` 提供并发修改保护；旧版本、清单变更和已有冲突需要刷新或人工协调。取消／提前结束释放未来排期，不会结束训练进程，预约到期也不能用于判定实际 GPU 空闲。

## 周报与绩效接口

`/api/workspace/*` 仅 account 模式提供，拒绝全部查询参数，使用普通 64 KiB JSON 与同源写入校验。服务端重新解析当前有效成员身份，不能在请求中伪造角色、公司、作者身份或评审权限。工作台记录 ID 为 UUID，写入版本为正整数。

`Report` 字段：`{id,authorId,authorName,company,weekStart,todos,nextPlan,status,reviewerId,reviewerName,score,reviewComment,reviewedBy,reviewedName,reviewedAt,submittedAt,version,createdAt,updatedAt}`。`weekStart` 为有效周一 `YYYY-MM-DD`；日期时间为 UTC ISO8601，未设置的评审人、评分与提交/评审时间为 null。`status=draft|submitted`。

`Todo` 为 `{text,completion,unfinishedReason,effect}`：文字去首尾空白，工作内容最多 400 字符，未完成原因与效果各最多 1000；completion 为 0–100 有限数字。每份最多 20 项，nextPlan 最多 4000 字符，正文序列化后最多 60 KiB。提交要求至少一项非空工作、非空下周计划，以及完成度小于 100 的每项都填写未完成原因；草稿允许未填完。

| 请求 | 输入／权限与返回 |
| --- | --- |
| `GET /api/workspace/reports` | `{reports:Report[]}`；仅作者、同公司指定评审人可见其对应记录，超管可见全部，普通同事不因 role=admin 获得访问。 |
| `POST /api/workspace/reports` | `{authorId?,weekStart,todos,nextPlan,status?}` → `201 {report}`；默认作者为自己、状态 draft，只有超管可指定其他已分配公司成员。 |
| `GET /api/workspace/reports/:id` | `{report,history}`；遵守同一读取权限，草稿也受保护，越权返回 404。 |
| `PATCH /api/workspace/reports/:id` | `{version,todos?,nextPlan?,status?}` → `{report}`；仅作者或超管，且记录须仍为 draft。 |
| `POST /api/workspace/reports/:id/reviewer` | `{version,reviewerId}` → `{report}`；reviewerId 为 UUID 或 null，仅超管，非超管评审人须与周报同公司且不能为作者。 |
| `POST /api/workspace/reports/:id/review` | `{version,score,comment}` → `{report}`；仅指定同公司评审人或超管，对已提交记录手工评分。 |

每位作者每个 weekStart 唯一，重复创建返回 `409 REPORT_EXISTS`。提交后正文锁定，修改返回 `409 REPORT_LOCKED`；草稿评分返回 `409 REPORT_NOT_SUBMITTED`。评分为 0–100 有限数字，comment 最多 4000 字符，允许空串。换评审人会清空当前评分、评语与评审人记录，历史仍留存；相同评审人重复提交不递增版本。

读权限要求用户当前公司与报告公司一致（超管例外），作者或评审人调离公司即失去旧公司报告访问；公司字段不随账号变更自动改写。写入在事务中校验版本并记录审计，旧版本返回 `409 VERSION_CONFLICT`。`history` 为 `{actorName,action,at,details}[]`，最多 100 项，包含原内容或旧评分，因此同样受报告读取权限约束。

## 设备申请与领取接口

`Request` 字段：`{id,applicantId,applicantName,company,category,quantity,purpose,equipmentId,equipmentName,equipmentSerial,status,decisionComment,equipmentUpdated,version,createdAt,updatedAt}`。未关联设备时 equipmentId/name/serial 为 null；status 为 `pending|approved|rejected|collected`。申请公司与原始内容创建后不可通过处理接口修改。

| 请求 | 输入／权限与返回 |
| --- | --- |
| `POST /api/workspace/requests` | `{category,quantity,purpose,equipmentId?}` → `201 {id,submitted:true}`；有公司成员可提交，**只返回确认，不返回申请正文**。 |
| `GET /api/workspace/requests` | `{requests:Request[]}`，仅超管。 |
| `GET /api/workspace/requests/:id` | `{request,history}`，仅超管，提交者也无读权限。 |
| `PATCH /api/workspace/requests/:id` | `{version,status,comment}` → `{request}`，仅超管；status 只接受 approved、rejected、collected。 |

类别使用设备七类枚举，quantity 为 1–999 整数，purpose 非空且最多 4000 字符。可关联本公司可用设备，设备类别须一致，关联时 quantity 必须为 1；不存在或跨公司返回 `404 EQUIPMENT_NOT_FOUND`。超管提交自己的申请也必须先给自己分配公司。

普通成员与资源管理员读取目录/详情或审批返回 `403 SUPERADMIN_REQUIRED`。员工只保存提交编号确认，不能通过编号、筛选参数或本人身份读取正文/处理进度。原始用途、数量、类别和设备绑定不接受 PATCH；comment 为处理备注，最多 4000 字符，可为空。

领取前须为 approved，否则返回 `409 REQUEST_NOT_APPROVED`；collected 不可回退，否则返回 `409 REQUEST_LOCKED`。已领取记录可修改处理备注，不会再次更新设备。同一状态与备注重复提交直接返回原记录；所有有效修改需当前 version。

关联设备首次领取使用**申请事务的同一个 SQLite 连接**：核对申请人仍有效且同公司、设备仍属该公司、类别相同、状态 available 且 currentUser 为空，再更新设备使用人为申请人当前姓名、状态 in_use、设备版本和设备历史，同时更新申请、equipmentUpdated=true 与申请审计，任一失败整体回滚。申请人变更返回 `409 APPLICANT_CHANGED`，设备公司变更返回 `409 EQUIPMENT_CHANGED`，已被使用或类别/状态变化返回 `409 EQUIPMENT_UNAVAILABLE`。

未关联设备的申请仅记录人工处理，equipmentUpdated 保持 false，不自动采购或建设备。直接设备维护/领用接口继续向本公司成员开放，申请功能不构成强制审批拦截。申请 history 与周报同为最多 100 项，只有超管可读。

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

网页首页支持单个 `?resource=<id>` 或 `?reservation=<id>` 参数；ID 限 1–100 个字母、数字、下划线或短横线，重复或不合法参数不作为目标。`resource` 在成员登录并通过公司门禁、资源加载后定位并高亮对应机器，不会自动创建预约；资源已停用或不存在时显示不可用提示。`reservation` 在具备业务访问资格后打开预约详情。设备深链 `/equipment/:id` 也先经过登录和公司门禁，再读取对应档案。

访客首先看到登录／注册界面，身份及公司资格有效后才加载资源、排期和设备；深链地址保留，不会把业务数据写进静态登录壳。`/#setup=<一次性码>` 与普通资源深链用途不同：前者只为一次性资源管理员注册提供认领码，读取后移除 fragment，不能用它调用业务 API，也不作为持续登录令牌。

桌面读取中央资源和排期也需要有效设备登录；超级管理员或已分配公司的资源管理员调用 `device-login` 后才可 `resources/sync`，已分配公司的普通成员设备令牌可以读取团队业务，但不能同步或修改资源目录。设备登录在操作系统钥匙串中保存，网页 Cookie 不传给桌面。预约确认仅建立排期记录，任何账号、设备令牌或预约 ID 都不授予 SSH 登录、终端、文件访问或 GPU 操作系统隔离权限。

## 运维与通知

计划部署 Node.js 24.20.0 在 `/opt/racktop-team/node/bin/node`，构建目录 `/opt/racktop-team/current`，root 专用环境文件 `/etc/racktop-team/service.env`，低权限 `racktop-team` 服务的数据为 `/var/lib/racktop-team/team.sqlite`。目录 0700，数据库与秘密配置 0600。使用流程见 [README.md](README.md)，部署与一次性资源导入见 [deploy/README.md](deploy/README.md)；实际上线以交付报告为准。

预约站点使用根 `/api`；既有共享中继的 `/v1/…` 与 `/healthz` 在 Nginx 中继续指向中继，WebSocket、HTTPS 与证书续期路由必须保留。预约健康检查独立使用 `/api/health`。

`createNotifier(config).send(event)` 支持 created／updated／cancelled／finished／ending 群消息，使用可选 `FEISHU_WEBHOOK_URL` 与 `FEISHU_WEBHOOK_SECRET`。没有配置就不发送。SQLite outbox 使预约提交不依赖即时消息成功；后台失败重试，可能重复，不承诺个人私信或恰好一次。凭据只放服务端环境，客户端秘密只放 OS keyring，不把密码、令牌或 SSH 私钥写入预约用途、资源备注、文档或日志。
