# RackTop 2.2.0 验证记录

本页对应统一版本 **2.2.0**，发布源码来自 [PR #7](https://github.com/AIsMovDataInfra/RackTop-Workspace/pull/7)，合并提交为 [`99c59e4`](https://github.com/AIsMovDataInfra/RackTop-Workspace/commit/99c59e477c3557e942d263fd3c9da2365729546b)。[`v2.2.0` 标签](https://github.com/AIsMovDataInfra/RackTop-Workspace/releases/tag/v2.2.0)、三平台构建和发布任务均绑定完整提交 `99c59e477c3557e942d263fd3c9da2365729546b`。Linux amd64、Mac Apple Silicon 和 Mac Intel 使用同一版本与 Release；本页只记录 2.2.0 的实际证据，之前版本的记录保持不变。

## 验收摘要

| 项目 | 结果 |
| --- | --- |
| 本轮功能 | 原生下拉菜单裁切修复、邀请码到期前多次使用、独立成员授权与撤销、在线访客公网出口 IP 展示，以及 Linux/Mac 统一版本均已进入发布源码。 |
| GitHub CI | [工作流 34340934877](https://github.com/AIsMovDataInfra/RackTop-Workspace/actions/runs/34340934877) 成功；Linux、Apple Silicon、Intel 和统一发布任务均通过。 |
| Release | v2.2.0 作为 Pre-release 发布；9 个附件均匿名下载成功，字节数、本地 SHA256 与 GitHub digest 一致；`SHA256SUMS` 覆盖并匹配其余 8 个文件。 |
| 源码与更新 | 源码归档内 424 个文件与标签一致；Linux、Apple Silicon、Intel 三个平台的更新签名均通过复验。 |
| 公网中继 | 0.3.0 在线运行，`racktop-relay.service` 与 Nginx 均为 active/enabled；独立中继 smoke 为 6/6，另有 RackTop 2.2.0 完整公网端到端流程通过。 |
| Mac 原生验证 | 两个原生 runner 均通过 DMG 挂载、架构、签名、更新归档一致性、8 秒启动和截图检查；包为 ad-hoc 签名且未 Apple 公证。 |
| 本机 Linux | 已把核验过的公开 Deb 安装到用户级 2.2.0 目录；3 个数据库、5 个配置文件和 7 个旧版本二进制保持不变，随后受控切换到当前 2.2.0 进程。 |

## 本版本行为

- 共享资源页面以及其他桌面页面的原生下拉菜单已统一修正纵向裁切，选项文字不再偏下或被遮挡。
- 同一个邀请码在到期前可供多台设备依次加入。每台设备形成独立成员身份，分别记录在线状态并支持单独撤销；撤销成员会轮换邀请码，阻止旧邀请码继续加入。
- 分享者只在访客在线时看到该连接的公网出口 IP。该值来自受信任反向代理写入的单个合法转发地址，只短暂进入主人待处理票据，不返回访客、不进入健康接口或统计，也不持久化到日志或数据库。
- Linux amd64、Mac Apple Silicon 和 Mac Intel 统一为 2.2.0，安装包名称继续明确区分平台和架构。

## 自动化与原生 CI

[标签工作流](https://github.com/AIsMovDataInfra/RackTop-Workspace/actions/runs/34340934877) 于 2026-09-09 10:34:24 UTC 开始，使用提交 `99c59e477c3557e942d263fd3c9da2365729546b`，于 10:49:25 UTC 成功结束。Windows job 按工作流配置跳过，不属于本次发布范围。

Linux [job 102431292091](https://github.com/AIsMovDataInfra/RackTop-Workspace/actions/runs/34340934877/job/102431292091) 的完整日志显示：

- 桌面前端 68 个测试文件、325/325 项通过，生产构建通过。
- Rust 主套件共发现 175 项，172 项通过，3 项按外部环境条件忽略，没有失败。
- `racktop-relay` 0.3.0 的 Node 测试 30/30 通过；远程文件 Python 测试 15/15 通过。
- 需要真实 Node 中继、loopback 监听和 TLS 数据传输的 Rust 用例另行启用，1/1 通过。
- Linux 签名更新下载器完成 9/9 项正反向检查，覆盖正确下载、同版本不更新、拒绝降级、篡改包、无效签名、清单版本错配、端点失败、生产公钥一致性和修改字节拒绝。
- Deb 元数据为 `Package: rack-top`、`Version: 2.2.0`、`Architecture: amd64`；7 份包内 MD5、ELF 架构、LICENSE、NOTICE 和动态库解析通过。隔离用户资料下的原生应用运行到预期的 15 秒超时，退出码为预定的 124。

Mac [Apple Silicon job 102431291952](https://github.com/AIsMovDataInfra/RackTop-Workspace/actions/runs/34340934877/job/102431291952) 与 [Intel job 102431292179](https://github.com/AIsMovDataInfra/RackTop-Workspace/actions/runs/34340934877/job/102431292179) 均通过。两边各完成前端 68 个文件、325/325 项测试；Rust 各为 168 项通过、3 项按条件忽略。统一 publish job 还在发布前执行了版本、Mac 更新清单和工作区更新清单检查，随后成功发布 Release 并推进更新分支。

## 公开附件与源码一致性

[v2.2.0 Release](https://github.com/AIsMovDataInfra/RackTop-Workspace/releases/tag/v2.2.0) 于 2026-09-09 10:49:19 UTC 发布为 **测试版（Pre-release）**，不标记为 Latest。下列 9 个附件均在未携带 GitHub 凭据和代理设置的公网环境中匿名下载并获得 HTTP 200；实际字节数和本地 SHA256 与 GitHub Release API digest 一致，`SHA256SUMS` 覆盖并匹配其余 8 个文件。

| 文件 | 字节数 | SHA256 |
| --- | ---: | --- |
| [RackTop_2.2.0_linux-amd64.deb](https://github.com/AIsMovDataInfra/RackTop-Workspace/releases/download/v2.2.0/RackTop_2.2.0_linux-amd64.deb) | 11,726,416 | `9645d6e95f45ce5d617e6c75cdd972d87169f6bc267e17850fd3b59732b138ee` |
| [RackTop_2.2.0_macos-arm64-unsigned.dmg](https://github.com/AIsMovDataInfra/RackTop-Workspace/releases/download/v2.2.0/RackTop_2.2.0_macos-arm64-unsigned.dmg) | 9,425,056 | `fdb2735d7275bf6cab25a9ec8732dfe1f17ce0e3f4d6b7a3143af602f46629cd` |
| [RackTop_2.2.0_macos-arm64-unsigned.app.tar.gz](https://github.com/AIsMovDataInfra/RackTop-Workspace/releases/download/v2.2.0/RackTop_2.2.0_macos-arm64-unsigned.app.tar.gz) | 9,327,615 | `f10b3e71031d92d25768c40e6ffe74d3ceefdd8a6a4efffbf1f1b5a9276a1485` |
| [RackTop_2.2.0_macos-x64-unsigned.dmg](https://github.com/AIsMovDataInfra/RackTop-Workspace/releases/download/v2.2.0/RackTop_2.2.0_macos-x64-unsigned.dmg) | 10,085,543 | `421d854880d5b5229838639ece9df8b3fe6cf242876b7bec7cf0af249755ae9a` |
| [RackTop_2.2.0_macos-x64-unsigned.app.tar.gz](https://github.com/AIsMovDataInfra/RackTop-Workspace/releases/download/v2.2.0/RackTop_2.2.0_macos-x64-unsigned.app.tar.gz) | 9,998,163 | `96ef67f938eea290dc6ebb65a7e4440b9d7d3152355cda0c6537872dd6da5e23` |
| [RackTop_2.2.0_source.tar.gz](https://github.com/AIsMovDataInfra/RackTop-Workspace/releases/download/v2.2.0/RackTop_2.2.0_source.tar.gz) | 9,549,500 | `6b77d420dea847c8878789ae43340f332eebb937ef61356c8545c28b4718ca10` |
| [LICENSE](https://github.com/AIsMovDataInfra/RackTop-Workspace/releases/download/v2.2.0/LICENSE) | 35,149 | `3972dc9744f6499f0f9b2dbf76696f2ae7ad8af9b23dde66d6af86c9dfb36986` |
| [NOTICE.md](https://github.com/AIsMovDataInfra/RackTop-Workspace/releases/download/v2.2.0/NOTICE.md) | 2,703 | `df41af7d9908083c2b26686640dbb9d9d788ddbf7ef9098c5fa56e0e29a6fbff` |
| [SHA256SUMS](https://github.com/AIsMovDataInfra/RackTop-Workspace/releases/download/v2.2.0/SHA256SUMS) | 770 | `3cb8f7d256506d8ec89ba70a718439fbcc6420b9a194b493da86eba0a8717a4e` |

源码归档中的 424 个文件逐一与 `v2.2.0` 标签比较，内容、相对路径和提交标记全部一致；归档内 LICENSE 与 NOTICE 也和公开附件一致。该检查证明发布源码可对应到标签，不包含 GitHub 自动生成的网页展示状态或外部服务数据。

## 更新清单与三平台签名

[Linux 更新清单](https://github.com/AIsMovDataInfra/RackTop-Workspace/blob/bb7a0b9bcb2da264ddec92b9e32e14e5944fee1d/linux-amd64.json)和 [Mac 更新清单](https://github.com/AIsMovDataInfra/RackTop-Workspace/blob/bb7a0b9bcb2da264ddec92b9e32e14e5944fee1d/macos.json)位于同一个 updater 提交 [`bb7a0b9`](https://github.com/AIsMovDataInfra/RackTop-Workspace/commit/bb7a0b9bcb2da264ddec92b9e32e14e5944fee1d)，版本均为 2.2.0。清单中的 URL 分别指向上表的 Linux Deb、Apple Silicon 更新归档和 Intel 更新归档。

`linux-x86_64-deb`、`darwin-aarch64`、`darwin-x86_64` 三个内嵌 Minisign 签名均使用工作区发布公钥复验通过，主签名和可信注释签名同时有效，签名内文件名与公开附件名称一致。这里的 Mac 更新签名用于验证自动更新归档；文件名中的 `unsigned` 指没有 Apple Developer ID 签名，两者含义不同。

## Mac 双架构证据与边界

Apple Silicon 验证附件 `macos-arm64-verification` 的 artifact ID 为 `10099996643`；Intel 验证附件 `macos-x64-verification` 的 artifact ID 为 `10100195568`。两份 JSON 均报告 `passed: true`，并分别确认：

- 目标架构为 `aarch64-apple-darwin` / `x86_64-apple-darwin`，原生运行架构为 `arm64` / `x86_64`。
- DMG 可挂载，`com.racktop.desktop` 标识、应用结构和架构正确；DMG 与更新归档中的应用字节、符号链接和权限一致。
- 应用代码签名结构与更新归档 Minisign 签名验证通过。
- 应用使用隔离资料运行至少 8 秒并创建隔离数据库。

两张 CI 截图均为 1432×932，Apple Silicon 截图 SHA256 为 `42f06508af0052bd5440a0bed254da25d63e69823b4ffea0d89f6f19fc6b8c98`，Intel 截图为 `cc595cad1762a40c464b453879189f14b86d5544329d5fe1ec0c9b6c35724a0b`。逐张视觉审阅可见 RackTop v2.2.0 原生主窗口、导航和初始引导，没有白屏、错误对话框或明显布局破坏。

两种 Mac 包的 `signingMode` 均为 **ad-hoc**，`notarized` 为 `false`。`appSignatureVerified: true` 只表示 ad-hoc 代码签名在磁盘上有效，不能解释为 Apple Developer ID 身份或 Apple 公证。验证报告还明确标记 `guiInteractionTested: false`；截图和 8 秒存活证明应用能够启动，不代表真人完整操作、Gatekeeper 首次放行、钥匙串、真实 SSH、共享或自动更新替换已经在实体 Mac 上完成。

## 公网中继 0.3.0

生产中继源码位于 `/opt/racktop-relay`，服务版本为 0.3.0。`racktop-relay.service` 于 2026-09-09 09:47:54 UTC（北京时间 17:47:54）进入当前 active 状态，服务与 Nginx 均为 active/enabled；升级前目录保存在 `/opt/racktop-relay.backup-20260909T094754Z`。公开 `/healthz` 当前返回 `{"status":"ok"}`。

生产 Nginx 使用 `proxy_set_header X-Forwarded-For $remote_addr` 覆盖客户端同名请求头。中继只在请求来自本机 loopback 反向代理、值为单个合法 IP 时接收该字段；空值、多值和非法值被忽略，IPv4-mapped IPv6 会规范化。这个值表示公网出口地址，NAT、VPN、代理或公司统一出口可能让多人显示同一地址，不能作为成员身份或精确位置。

部署后的最新真实公网 smoke 为 6/6 通过：

1. 公网健康检查返回正常状态。
2. 无主人凭据创建房间被 HTTP 401 拒绝。
3. host/guest 角色令牌交换使用被双方拒绝。
4. 外层 WSS 双向各传输 262,144 字节，SHA256 一致。
5. 中继内层 TLS 使用可信临时证书和服务名，双向各传输 262,144 字节并校验一致。
6. 错误的内层证书被拒绝。

该次中继 smoke 合计验证 1,048,576 字节，使用临时探测身份，结束后清理房间和私钥材料，不输出或保存主人凭据。另以 5 对经 IPv6 访问生产入口的 WebSocket 连接验证并发路由，全部通过。

此外，RackTop 2.2.0 的主人网关、访客运行时和生产中继完成了完整公网端到端验证：同一邀请码先后为两台逻辑设备签发不同的成员路由与令牌；分享者能看到在线访客的公网出口 IP；监控、keepalive、任意终端命令和文件目录可用；文件按 48 KiB 分块上传、提交并下载 262,181 字节，最终 SHA256 一致。断线后使用独立成员路由恢复；撤销第一台设备会轮换邀请码并拒绝其旧路由，第二台设备继续有效；访客本地记录、临时路由、临时 SSH 服务和远端测试文件均已清理。这两台逻辑设备仍运行在同一台 Linux 工作站，不能替代两名同事、两台物理设备和不同网络的现场验收。

## 本机 Linux 用户级安装

已使用上表匿名下载并核验的公开 Deb，将 2.2.0 安装到 `/home/yan/.local/share/racktop/versions/2.2.0`。Deb SHA256 为 `9645d6e95f45ce5d617e6c75cdd972d87169f6bc267e17850fd3b59732b138ee`，安装后的主二进制 SHA256 为 `91adcf4a946c8d4da0dea5f80175dc4927f92445a71c524c90101e5a12abe595`；动态库均可解析，应用标识保持 `com.racktop.desktop`。用户启动器和桌面入口已更新为 2.2.0，在系统包尚未达到 2.2.0 时进入该用户版本。

安装前备份位于 `/home/yan/.local/share/racktop-install-backups/before-workspace-2.2.0-20260909T112511Z-90166`。备份覆盖 3 个 SQLite 数据库和 5 个非数据库配置文件；安装前后文件摘要、数据库表计数和权限保持一致。备份目录权限为 0700，备份文件为 0600。本记录不列出真实服务器、账号、周报、设备或其他业务行内容。

系统级 dpkg 包仍为 `1.26.0-linux.8`，用户级安装没有替换系统包。已有的 7 个旧版本二进制在安装前后摘要和权限一致。安装时原 2.1.1 进程保持运行，没有被安装程序停止或替换；随后只观察到一条中继控制连接、未发现额外访客数据连接，再受控结束旧进程并启动 2.2.0。正式 2.2.0 二进制使用真实资料启动，并确认持续运行超过 60 秒。

## 验证边界

- v2.2.0 是 Pre-release。公开文件、标签、更新签名和原生 CI 已验证，不等同于所有团队环境完成生产升级。
- Mac 包没有 Apple Developer ID 签名或公证。实体 Mac 仍需验证 Gatekeeper 首次允许、钥匙串、真实 SSH/共享、文件选择器、通知和自动更新安装。
- Mac 截图是启动烟测证据，没有执行 GUI 自动交互。截图未覆盖所有页面、主题、字体缩放和原生下拉菜单的真人操作。
- 独立 relay smoke 与完整 RackTop 2.2.0 公网端到端流程均已通过；两台逻辑访客设备仍位于同一台 Linux 工作站。不同网络、不同物理设备和多人并发仍需现场复验。
- 访客 IP 只能用于分享者识别当前连接的出口来源，不能用于实名识别、定位、考勤或安全授权。生产代理信任边界依赖 Nginx 继续覆盖 `X-Forwarded-For`，不能允许客户端绕过 Nginx 直接访问内部监听端口。
- Linux 本机安装验证覆盖包、二进制、依赖、启动入口、备份、资料保持和真实资料启动。它没有替换系统 dpkg 包，也没有从已安装 GUI 执行自动更新、真实外部 SSH、GPU 监控、文件传输或多人共享操作；源码构建的专用探针端到端通过不等于这些 GUI 交互已在本机全部复验。
- 本轮发布和安装检查没有写入真实成员、预约、周报、绩效、设备或申请记录，也没有在文档或证据中保存密码、令牌、私钥内容或真实业务数据。
