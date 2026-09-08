# 部署与首次使用

本目录为 Node.js 24+、systemd 和 Nginx 的单团队部署说明。实际站点是否上线、证书状态和安装版本以交付报告为准；文档中的路径和示例不会自动配置服务器。成员使用步骤见 [团队预约说明](../README.md)，接口见 [API](../API.md)。

## 构建与安装

在仓库根目录运行 `npm ci`、`npm run team:test`、`npm run team:build`。正式服务使用 `team-web/dist` 的预构建静态网页与 `team-web/server`，不运行 Vite。GitHub 工作流 [team-web.yml](../../.github/workflows/team-web.yml) 的部署归档还包含文档、配置模板和两个运维脚本：

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

Nginx 的 `/` 与 `/api/` 转发到预约服务；`Host` 与公开站点一致，保留请求路径并覆写 `X-Real-IP` 为真实来源地址。仅在可信本地反向代理下设置 `TEAM_TRUST_PROXY=true`。既有共享中继的 `/v1/…`、`/healthz`、WebSocket 升级以及 ACME / HTTPS 证书续期路由必须保留。预约健康检查是 `/api/health`，不要把共享中继健康检查成功当作预约网页已可用。

## 一次性管理员初始化

设置 `TEAM_BOOTSTRAP_TOKEN` 为至少 32 字节随机数据的 base64url 编码，私下交付 `https://站点地址/#setup=<认领码>` 给站点所有者。不要把真实码写到构建变量、代码、命令参数、访问日志或公开文档。`TEAM_ADMIN_USERNAME` 可预留指定用户名；为空时允许站点所有者在设置页自行决定。

站点所有者打开设置链接后自己填写用户名、固定姓名和密码。前端把 fragment 从地址栏移除，注册时提交给服务；服务在事务中消费一次性码并持久化管理员认领状态。重启不重置认领资格。第一个普通注册者没有管理员权限，网站没有默认用户名或密码。

确认管理员可以登录并看到「资源管理」后，可从环境文件移除 `TEAM_BOOTSTRAP_TOKEN` 并重启。已有管理员会保留。不要删除数据库中的认领记录来“重置初始化”，这会改变账号信任边界。普通用户随后直接注册用户名、姓名、密码即可预约，无需邮箱、验证码或飞书。

## 首次连接 RackTop

1. 在网页完成管理员初始化。
2. RackTop 左侧打开「团队预约」→「账号登录」，使用同一管理员账号。
3. 在 RackTop 连上待同步服务器，确认有最近 90 秒内的完整 GPU 采样；在「同步本机资源」勾选机器并点击「保存并同步」。
4. 查看每台机器的结果，点击「查看与预约」在浏览器定位该机器。账号是独立网页登录；桌面登录不会自动登录浏览器。
5. 后续每 30 秒上报所选资源。电脑关机或退出只影响上报，公网网页和已有预约继续保留。停用资源需在网页「资源管理」操作。

浏览器记住登录可持续 30 天，不勾选为 8 小时；首次注册后的会话默认 8 小时。桌面设备令牌独立有效 30 天并保存在 OS keyring；密码不落盘。网页改密会撤销其他网页会话和全部桌面设备令牌，桌面需要重新登录。首版没有自助找回密码或网页管理员密码重置功能。

预约只登记时间和资源，不产生 SSH 权限、不锁 GPU、不隔离 Linux 用户，也不停止后台进程。远程终端和文件权限来自另外配置的 RackTop 资源共享或 SSH，不能把预约成功当作已获准访问服务器。

## 可选：运维预导入资源清单

通常使用上面的桌面同步即可。只有需要在首次账号认领前预置真实目录，且运维人员已经有数据文件权限时，才使用 `scripts/team-import-inventory.mjs`。该脚本不是 HTTP 接口，不会创建管理员、不签发登录令牌，也不会修改 SSH 公钥。

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

备份脚本检查完整性，包含已提交的 WAL，不覆盖已有文件。恢复时先停服务，恢复一致性快照并核对权限，再启动；单独复制运行中的 `.sqlite` 主文件不可靠。

完成后检查 HTTPS 和 `/api/health`、匿名资源列表、普通账号注册与所有权、管理员资源同步、GPU 冲突和旧版本保护、重启后的记录、备份恢复，以及原共享中继。未经实际执行的检查应记为未验证。日志不要输出环境秘密、请求密码或 Bearer 令牌；访问日志不应记录请求体。
