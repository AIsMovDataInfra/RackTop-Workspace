# 部署与首次使用

本目录为 Node.js 24+、systemd 和 Nginx 的单团队部署说明。实际站点是否上线、证书状态和安装版本以交付报告为准；文档中的路径和示例不会自动配置服务器。成员使用步骤见 [团队预约说明](../README.md)，接口见 [API](../API.md)，账号分配、找回与超级管理员恢复见[团队账号说明](../../docs/TEAM_ACCOUNTS.md)。

## 构建与安装

在仓库根目录运行 `npm ci`、`npm run team:test`、`npm run team:build`。正式服务使用 `team-web/dist` 的预构建静态网页与 `team-web/server`，不运行 Vite。1.29.0 起照片处理使用 sharp，部署时同时复制 `package.json`、`package-lock.json`，在目标架构上执行 `npm ci --omit=dev` 安装运行依赖；不要仅复制服务器脚本。GitHub 工作流 [team-web.yml](../../.github/workflows/team-web.yml) 的部署归档还包含文档、配置模板和三个运维脚本：

- `scripts/team-admin.mjs`：显式创建唯一超级管理员，或在运维核验后明确重置其密码；密码仅从标准输入读取，不在启动时自动创建或重设。
- `scripts/team-backup.mjs`：对运行中的 SQLite 做一致性备份。
- `scripts/team-import-inventory.mjs`：有数据库文件权限的运维人员可做一次性资源清单初始化；普通用户不需要它。

采用以下目录约定：

| 用途 | 路径 |
| --- | --- |
| 当前部署包 | `/opt/racktop-team/current` |
| Node.js 24+ | `/opt/racktop-team/node/bin/node` |
| 服务环境文件 | `/etc/racktop-team/service.env`，root 所有、0600 |
| 持久数据目录 | `/var/lib/racktop-team`，`racktop-team` 所有、0700 |
| 数据库 | `/var/lib/racktop-team/team.sqlite`，0600 |
| systemd 服务 | `/etc/systemd/system/racktop-team.service` |

使用 [.env.example](../.env.example) 创建真实环境文件。正式模式设置 `TEAM_AUTH_MODE=account`、`NODE_ENV=production`，仅监听 `127.0.0.1:4318`，`TEAM_PUBLIC_URL` 使用实际 HTTPS 根地址。此项目当前桌面连接地址固定为 `https://136.0.110.161`，换站点需要同步修改并重建桌面应用，不只是修改服务器环境。

把 [racktop-team.service](racktop-team.service) 放入 systemd 目录并创建对应低权限用户、持久目录。模板从环境文件读取秘密，仅允许写入持久目录；修改路径时也要同步 `WorkingDirectory`、`ExecStart` 和 `ReadWritePaths`。首次安装或更新服务文件后执行 `systemctl daemon-reload`，随后 `systemctl enable --now racktop-team.service`；只更换构建或环境配置时使用 `systemctl restart racktop-team.service`。

Nginx 的 `/` 与 `/api/` 转发到预约服务；`Host` 与公开站点一致，保留请求路径并覆写 `X-Real-IP` 为真实来源地址。仅在可信本地反向代理下设置 `TEAM_TRUST_PROXY=true`。既有共享中继的 `/v1/…`、`/healthz`、WebSocket 升级以及 ACME / HTTPS 证书续期路由必须保留。预约健康检查是 `/api/health`，不要把共享中继健康检查成功当作预约网页已可用。照片经客户端压缩后以 JSON 上传，预约反代 `location /` 的 `client_max_body_size` 设为 `2m`；普通业务请求仍由 Node 限制为 64 KiB，只有照片 POST 允许 2 MiB。设备照片 GET 也需要成员登录，不得配置 Nginx 公开缓存。

## 超级管理员初始化与员工公司分配

当前站点的唯一超级管理员通过 `scripts/team-admin.mjs create` 显式创建，约定用户名为 `admin`。系统没有内置初始密码；以 `racktop-team` 运行，使用 Bash 隐藏输入后将密码通过标准输入传入，完整命令见[运维初始化与遗忘恢复](../../docs/TEAM_ACCOUNTS.md#运维初始化与遗忘恢复)。不要在代码、环境模板、命令参数、构建日志或开机任务中设置真实密码。

初始化成功后登录网页「成员管理」，为现有员工选择 A公司、B公司、C公司或西浦。普通用户可以自行注册用户名、固定姓名、密码，但公司最初为待分配；完成分配后才能查看和使用资源、预约、设备及照片。超管也可以增加员工账号并指定公司。已有网页登录和桌面设备会话会在下一次请求读取最新公司属性。

`create` 可安全重复执行，不会覆盖已有超级管理员密码；若同名普通账号已存在，脚本拒绝抢占，需要先核实并处理。超级管理员忘记密码时，运维使用明确的 `reset` 模式并从标准输入提供新密码；这会撤销该账号的全部会话，不清空业务数据。不要把 `reset` 加入每次部署流程。

### 保留的资源管理员认领方式

旧的 `TEAM_BOOTSTRAP_TOKEN` / `TEAM_ADMIN_USERNAME` 及 `#setup=…` 一次性认领方式仍仅创建资源管理员，即 `role=admin`，不会授予 `isSuperAdmin`。已有认领状态继续持久化，重启不重置；不要删除认领记录。若仍使用这一可选流程，认领码须为至少 32 字节随机数据的 base64url 编码，只私下交给站点所有者，确认认领后可移除环境中的认领码并重启。

原资源管理员必须由超级管理员分配公司后才能继续业务操作和桌面资源同步；它不能查看成员名册、分配公司或重置员工密码。升级不会自动提升旧管理员或猜测公司归属。

## 首次连接 RackTop

1. 完成超级管理员初始化，并为需要同步的原资源管理员分配公司。
2. RackTop 左侧打开「团队预约」→「账号登录」，使用超级管理员或已经分配公司的资源管理员账号；已有绑定继续使用原账号，避免混淆资源来源。
3. 在 RackTop 连上待同步服务器，确认有最近 90 秒内的完整 GPU 采样；在「同步本机资源」勾选机器并点击「保存并同步」。
4. 查看每台机器的结果，点击「查看与预约」在浏览器定位该机器。账号是独立网页登录；桌面登录不会自动登录浏览器。
5. 后续每 30 秒上报所选资源。电脑关机或退出只影响上报，公网网页和已有预约继续保留。停用资源需在网页「资源管理」操作。

浏览器记住登录可持续 30 天，不勾选为 8 小时；首次注册后的会话默认 8 小时。桌面设备令牌独立有效 30 天并保存在 OS keyring；密码不落盘。网页改密会撤销其他网页会话和全部桌面设备令牌，桌面需要重新登录。忘记密码可在登录页提交申请，再联系超级管理员核实身份后设置新密码；申请不发送邮件、短信或消息。超管在网页重置员工密码会撤销该员工全部网页和桌面会话。超管自己遗忘时走运维CLI显式 `reset`，具体见[团队账号说明](../../docs/TEAM_ACCOUNTS.md)。

预约只登记时间和资源，不产生 SSH 权限、不锁 GPU、不隔离 Linux 用户，也不停止后台进程。远程终端和文件权限来自另外配置的 RackTop 资源共享或 SSH，不能把预约成功当作已获准访问服务器。

## 可选：运维预导入资源清单

通常使用上面的桌面同步即可。只有需要在首次账号初始化前预置真实目录，且运维人员已经有数据文件权限时，才使用 `scripts/team-import-inventory.mjs`。该脚本不是 HTTP 接口，不会创建管理员、不签发登录令牌，也不会修改 SSH 公钥。

先备份数据库，准备只包含选定资源公开元数据的 UTF-8 JSON 文件（最多 512 KiB、32 个资源）：

```text
{
  "sourceId": "与本机同步设置对应的来源 UUID",
  "resources": [{
    "serverId": "本地 RackTop 连接 UUID",
    "name": "资源名称",
    "cluster": "所属集群",
    "observedAt": "刚刚采集的 UTC ISO8601 时间",
    "status": "online",
    "gpus": [{
      "uuid": "真实完整的 NVIDIA GPU UUID",
      "index": 0,
      "name": "驱动返回的 GPU 型号",
      "memoryTotalMb": 81920
    }]
  }]
}
```

以上为字段示意，不是可提交的硬件数据；不要使用占位 UUID 或示例显存伪造目录。真实输入不得包含 SSH 地址、登录名、密码、私钥、设备令牌或进程信息。首次登记同样要求最近 90 秒内的在线采样，脚本复用正式同步校验。

以数据目录所属低权限用户执行，参数仅为文件路径：

```bash
/opt/racktop-team/node/bin/node /opt/racktop-team/current/scripts/team-import-inventory.mjs /var/lib/racktop-team/team.sqlite /受限目录/最新清单.json
```

成功时输出 `{sourceId,bindings:{本地连接ID:在线资源ID}}`，用于与原桌面来源保持一致。多资源逐项事务写入，**整个文件不是一个事务**；中途错误时先检查已经写入的目录，不要假定所有资源都回滚。输出不含用户密码或登录令牌，但应与其他部署元数据一起妥善保管。

需要把这份映射预配置到本机时，开发者可显式构建 `integration-probe` 特性的 `team-setup` 工具，从标准输入传入 `{profilePath,sourceId,bindings}`。工具仅存入空白本机团队配置的 OS keyring，不覆盖已有账号或绑定，且不随正常安装包分发。只有首次管理员登录会采用预配置；普通成员登录不会接管。该步骤没有替代站点所有者的账号注册或密码登录。

## 升级、备份和检查

升级前生成唯一命名的一致性备份，保留环境文件、数据目录和原有资源绑定。不要重新导入演示数据，不要把构建包里的数据库复制覆盖生产库。

```bash
/opt/racktop-team/node/bin/node /opt/racktop-team/current/scripts/team-backup.mjs /var/lib/racktop-team/team.sqlite /var/lib/racktop-team/backups/唯一名称.sqlite
```

备份脚本检查完整性，包含已提交的 WAL，不覆盖已有文件。恢复时先停服务，恢复一致性快照并核对权限，再启动；单独复制运行中的 `.sqlite` 主文件不可靠。定时快照、保留策略、独立位置备份与恢复步骤见 [资产数据持久化与备份](BACKUPS.md)。自动备份工具应安装在独立于网页 release 的稳定目录，并实际启用对应 systemd timer。

完成后检查 HTTPS 和 `/api/health`、匿名业务接口拒绝访问、待分配成员的 `COMPANY_REQUIRED`、超管专属名册权限、公司分配后的成员资源列表、找回与重置后的会话撤销、删号后的历史保留、普通账号注册与所有权、管理员资源同步、GPU 冲突和旧版本保护、重启后的记录、备份恢复，以及原共享中继。未经实际执行的检查应记为未验证。日志不要输出环境秘密、请求密码或 Bearer 令牌；访问日志不应记录请求体。

## 设备照片与迁移

照片在服务器经 [sharp](https://sharp.pixelplumbing.com/api-output/) 解码、按方向旋转和压缩为 JPEG，最长边不超过 1600 像素、每张不超过 512 KiB；原图与 EXIF 元数据不存储。每设备一张，SQLite 的 `equipment_photos` 表保存压缩图片，与现有一致性备份一起保存恢复，无须单独拷贝图片目录。

升级前应备份 `team.sqlite`。旧设备 UUID/二维码不变，按创建顺序补齐不可修改的 8 位序列号，旧自由序列号保留在 `legacySerialNumber`；旧类别和位置不猜测映射，成员下次编辑时须选择支持的枚举。新建或编辑、照片上传与归还都使用相同设备版本，冲突须读取最新版后重试。旧设备新增公司字段为空，由超级管理员核实后分配；员工换公司不会改变已有资产公司。预约、设备、照片接口均仅向已登录且已分配公司的团队成员提供内容，超级管理员可在未分配自身公司时进入业务和成员管理；静态登录壳与注册接口仍可公开访问。
