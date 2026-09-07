# RackTop 团队预约

面向小团队的共享整机 / GPU 预约台，当前由 AIsMov 维护。网页与中央 SQLite 服务共同保存预约记录，成员不需要安装桌面客户端。原 RackTop 的空闲提醒与本功能互相独立，当前尚未同步桌面端的预约或监控数据。

## 本机运行

需要 **Node.js 24+** 和 npm。仓库根目录执行：

```bash
npm ci
npm run team:dev
```

打开 <http://127.0.0.1:1421/>。开发入口默认使用本机演示模式，包含三名有明确标识的演示成员及示例资源，数据持久化到本机数据库。API 默认监听 `127.0.0.1:4318`。`Ctrl+C` 会同时停止前端和后台。

演示模式只允许本机回环地址，不能作为团队身份认证方式部署。正式使用选择飞书模式，使用独立数据库；不要把演示数据库当团队正式台账。

## 使用已构建的网页压缩包

解压网页包后，在解压目录用 Node.js 24+ 执行以下命令即可启动本机演示，不需要重新安装依赖：

```bash
TEAM_AUTH_MODE=demo TEAM_HOST=127.0.0.1 TEAM_PORT=1421 TEAM_PUBLIC_URL=http://127.0.0.1:1421 node team-web/server/server.mjs
```

正式部署复制并填写环境模板后，运行 `node --env-file=team-web/.env team-web/server/server.mjs`。仅修改前端源码时才需要 `npm ci` 和 `npm run team:build`。

## 预约规则

- 资源按集群 / 服务器组织，GPU 从 0 开始编号。账号和密码不是预约资源的身份。
- 支持整台服务器和具体 GPU；CPU 服务器仅支持整机预约。
- 同一资源时间重叠时，整机与所有 GPU 预约互斥；不重叠的 GPU 可以并行预约。结束时刻与下一预约开始时刻相同不算冲突。
- 每次创建、修改和续约都在数据库事务中检查；同一资源的并发请求不会同时占到相同 GPU。界面旧版本修改会提示重新加载，避免覆盖别人的操作。
- 每次预约最长 7 天，最远预约未来 90 天，时间统一按北京时间显示，存储为 UTC。
- 成员可以修改、取消或提前结束自己的预约；管理员可以管理资源并协调预约。
- 预约记录说明的是团队排期。GPU 的实际运行状态尚未接入，本系统不监控或终止进程，不保存 SSH 密码或私钥。

## 正式部署

1. 准备一台团队可访问、能持久保存数据的服务器和 HTTPS 域名。
2. 创建飞书网页应用，配置预定使用成员的可用范围。回调地址为 `https://你的域名/api/auth/feishu/callback`。
3. 把 `team-web/.env.example` 复制为 `team-web/.env`，填写真实部署地址、飞书 App ID / Secret、允许的 tenant_key、管理员 open_id。凭据仅放服务端，不提交 Git、不放前端 VITE 环境变量。
4. 使用 Node.js 24+ 构建并启动：

```bash
npm run team:build
node --env-file=team-web/.env team-web/server/server.mjs
```

5. 将 Caddy / Nginx 配置为 HTTPS 反向代理，参考 `Caddyfile.example`。不要把 Vite 开发服务器当生产服务。
6. 管理员首次登录后在“资源管理”添加真实的集群名称、服务器别名、GPU 型号和数量。正式空库不自动生成演示资源。
7. 两位真实成员分别登录，验证成员只能修改自己的预约、整机/按卡冲突、取消、续约和持久化，然后把网页链接固定在飞书群里。

应用需要通过“获取登录用户信息”接口取得 `open_id`、`name` 与 `tenant_key`。请按[飞书接口权限说明](https://open.feishu.cn/document/server-docs/authentication-management/login-state-management/get)核验当前应用权限，并用真实成员登录验收；本项目不需要读取手机号、邮箱或完整通讯录。管理员 `open_id` 必须来自同一个应用，不能用姓名或手机号替代。

飞书组织外成员能否打开企业自建应用，取决于该应用的发布和可用范围；仅放开 tenant_key 白名单不能替代飞书的访问授权。请先确认 15 位成员的组织关系。

### Docker 部署材料

仓库提供 `Dockerfile` 和 `compose.yaml`。准备 `team-web/.env` 后，可在仓库根目录执行：

```bash
docker compose -f team-web/compose.yaml up --build -d
```

容器以非 root 用户运行，仅把服务端口映射到宿主机回环地址，数据库使用持久卷；HTTPS 由宿主机反向代理提供。镜像构建是否经过实际执行，请以交付验证记录为准。

## 飞书群通知

可选配置群自定义机器人的 `FEISHU_WEBHOOK_URL` 和签名密钥 `FEISHU_WEBHOOK_SECRET`。未配置时不会发送消息。配置后，创建、修改、取消、提前结束和临近结束事件可通知到配置的群；这不是个人私信能力。

通知由后台独立处理，发送失败不撤销已成功保存的预约。未配置通知时的历史事件会标记为未启用，日后配置机器人不会补发这些旧消息。默认每 30 秒处理最多 5 条，失败按指数退避重试；崩溃发生在发送与确认之间时可能重复，因此不承诺恰好发送一次。临近结束提醒提前 30 分钟，同一预约版本最多入队一次；预约修改、取消或到期后的旧提醒会跳过。首次启用请先用测试群验证内容、签名、失败重试和消息频率。界面和预约数据库不显示 webhook 或应用密钥。不要把团队共享密码写到预约用途里。

## 测试

```bash
npm run team:test
npm run team:build
```

自动测试使用临时数据库和模拟飞书响应，不向真实飞书群发送消息。真实企业登录、群通知和公网环境仍需要管理员提供配置后验收。

## 数据与维护

- 一份 SQLite 数据库对应一个团队、一台服务实例；部署到本机磁盘，不能把数据库文件放进共享网盘、NFS 或多容器共同写入的目录。
- 重启保留资源和预约；登录会话可能需要重新登录。
- 数据库采用 WAL，运行中不能只复制主 `.sqlite` 文件作备份。可执行 `node scripts/team-backup.mjs team-web/data/team.sqlite team-web/backups/新的文件名.sqlite` 做在线一致性备份；脚本拒绝覆盖已有文件并检查完整性。上线前验证一次恢复。Docker 部署可运行 `docker compose -f team-web/compose.yaml exec reservations node scripts/team-backup.mjs /data/team.sqlite /data/backup-新的日期.sqlite`，再将备份复制到卷外保存。
- 到期记录保留，不自动宣称 GPU 实际空闲；取消和提前结束也保留记录。
- 许可证沿用仓库 GPL-3.0，来源与当前维护职责见 `../NOTICE.md`。

参考：[飞书网页登录示例](https://github.com/larksuite/lark-samples/tree/main/web_app_with_auth)、[飞书自定义机器人](https://open.feishu.cn/document/client-docs/bot-v3/add-custom-bot)。
