# RackTop 团队预约 API（实现约定）

Node.js 24+，单服务进程 + SQLite。认证模式 demo 仅限 loopback / feishu 正式部署。UTC ISO8601 时间；前端展示 Asia/Shanghai（显式标注北京时间）。JSON API，同源 cookie，写入需要 X-CSRF-Token。

## 数据
- User: {id,name,role:'admin'|'member'}；用户身份由服务端会话决定，禁止请求自报 owner/role。
- Resource: {id,cluster,name,gpuModel,gpuCount,notes,enabled}; GPU编号 0..gpuCount-1。gpuCount=0 的CPU服务器仅允许整机。无SSH凭据/地址要求；管理员新增/停用/编辑资源，已有有效预约不得改变GPU数量。
- Reservation: {id,resourceId,resourceName,cluster,ownerId,ownerName,scope:'machine'|'gpus',gpuIndices:number[],startAt,endAt,purpose,status:'confirmed'|'cancelled'|'completed',createdAt,updatedAt,version:number}。列表同时包含历史，UI可推导 scheduled/ongoing/elapsed。取消保留记录，提前结束记录真实结束时间并保留原 plannedEndAt（若实现）。整机 gpuIndices=[]。
- Error: {error:{code,message,conflicts?:Reservation[]}}。409预约冲突或版本过期，403无权，401未登录，422输入无效。

## 接口
- GET /api/session -> {user:User|null,csrfToken:string,authMode:'demo'|'feishu',feishuConfigured:boolean,demoUsers?:User[],notifications:{configured:boolean},timezone:'Asia/Shanghai'}。
- POST /api/auth/demo {userId} -> 与session一致（仅本机demo可用；也需先取匿名session的CSRF）；GET /api/auth/feishu/start -> OAuth；GET /api/auth/feishu/callback；POST /api/auth/logout（CSRF保护）。
- 飞书 start 可带单个 `reservation` 参数，仅接受 `/^[a-zA-Z0-9_-]{1,100}$/` 的预约 ID；空值或未提供时返回首页。有效 ID 保存在服务端单次 state 内，callback 完成后返回 `/?reservation=<id>`。重复参数、非法值及其他参数（包括任意 returnUrl）返回 400；callback 查询参数不能覆盖服务端目标。
- GET /api/resources -> {resources:Resource[]}（要求登录）。
- POST /api/resources {cluster,name,gpuModel,gpuCount,notes?} -> {resource}（admin）。
- PATCH /api/resources/:id {cluster?,name?,gpuModel?,gpuCount?,notes?,enabled?} -> {resource}（admin）。
- GET /api/reservations?from=ISO&to=ISO&mine=true -> {reservations:Reservation[]}；from/to筛选重叠窗口；不传默认近7日至未来30日；最多1000条。
- POST /api/reservations {resourceId,scope,gpuIndices,startAt,endAt,purpose} -> 201 {reservation}。
- GET /api/reservations/:id -> {reservation}；登录成员可查看通知链接对应记录。
- PATCH /api/reservations/:id {version,startAt?,endAt?,purpose?,scope?,gpuIndices?} -> {reservation}。owner或admin可修改；变更在事务内重新冲突检查；资源不变。
- POST /api/reservations/:id/cancel {version} -> {reservation}（owner/admin）。
- POST /api/reservations/:id/finish {version} -> {reservation}（正在进行的owner/admin）。
- GET /api/health -> {ok:true}，无需身份且无内部信息。

## 核心规则
确认占用重叠：existing.start < new.end && existing.end > new.start，且同resource且任一machine或gpuIndices交集非空。BEGIN IMMEDIATE保护读检写，两个独立连接同样生效。相邻区间允许。只纳入confirmed，取消/提前完成释放未来排期，不能把到期说成实际GPU空闲。创建时间不能在过去（允许小于60秒偏差）；结束必须大于开始，最长7天、最远90天。续约保持已开始的起始时间，只能修改未来结束时间。CAS version防覆盖。所有字符串有上限；日期必须带时区且有效。

## Auth模块给HTTP服务的接口
`createAuth(config)` -> {resolve(req): session|null, handle(req,res,url,body): Promise<boolean>, verifyWrite(req,session):void, sessionPayload(req):object, close():void}。
session = {user,csrfToken}。
handle处理以上/api/session、/api/auth/*，内部完成自身写操作的Origin/CSRF检查；其余返回false。普通业务写操作HTTP层调用verifyWrite。
config = {mode:'demo'|'feishu',publicUrl,host,feishuAppId,feishuAppSecret,feishuTenantKeys:string[],feishuAdminOpenIds:string[],notificationsConfigured:boolean}。
默认演示用户 demo-admin/“管理员（演示）”、demo-lin/“小林（演示）”、demo-zhou/“小周（演示）”。demo模式启动验证仅loopback host且publicUrl loopback，真实环境配置缺失fail closed。

## 飞书通知模块
`createNotifier(config)` -> {send(event):Promise<boolean>}。event={type:'created'|'updated'|'cancelled'|'finished'|'ending',reservation,resource}；使用配置FEISHU_WEBHOOK_URL + 可选FEISHU_WEBHOOK_SECRET。默认不发送。仅事件摘要/资源别名/姓名/时间/用途/详情页链接；无服务器密码。后端用SQLite outbox实现事务记录、后台重试，预约成功不依赖即时消息成功。提醒可先实现群内@无支持则普通文字；不要承诺个人私信或不实现的按钮。说明实际能力。
