# 2.5.0 验证记录

状态：团队网页、GitHub 测试版（Pre-release）、生产更新清单和云端下载镜像均已发布。本记录只使用正式标签产物的最终摘要；预检产物不代替正式发布验证。以下时间均为 2026-09-11，除特别注明外使用 UTC+8。

## 版本与发布

功能提交为 `c4a0d5b518415c99b4e950607c078056d77a1ec2`（22:19:15），已并入 `main`；注释标签 `v2.5.0` 指向该提交。后续文档提交不改变已发布标签。维护身份为组织 GitHub App `dusan2026[bot]`。

[正式标签 CI 34612185746](https://github.com/AIsMovDataInfra/RackTop-Workspace/actions/runs/34612185746) 的 Linux、Apple Silicon、Intel 和发布任务全部成功。[2.5.0 Release](https://github.com/AIsMovDataInfra/RackTop-Workspace/releases/tag/v2.5.0)（ID 387136417）于 **23:15:46** 发布为 **Pre-release**，11 个附件齐全。本轮没有新 Windows 安装包。

本轮新增组织服务器目录与逐成员授权、桌面授权目录同步、本机 SSH 认证、多组织成员及当前组织切换，并提供统一 Ubuntu 安装入口和签名 Flatpak 更新。中央目录只保存连接元数据，不保存 SSH 密码或私钥；业务数据仍隔离在当前组织，周报按成员、组织与周保存。

## 网页上线、迁移与备份

网页于 **22:26:38** 上线，运行目录为 `2.5.0-c4a0d5b51841`。切换前保留最新停服快照，正式迁移与此前独立副本预演均通过：原 21 张表的既有列与字段内容逐项保留，迁移后 25 张表通过完整性和外键检查，生产台账保留 **32 台设备、37 条修改记录**。

上线后 **22:27:41** 自动备份通过官方校验及独立恢复副本检查。最终 **23:21:38** 只读核验确认部署的 23 个文件与功能提交匹配，app、relay、nginx 和备份 timer 均 active；数据库仍为 25 张表、32 台设备、37 条修改记录，完整性及外键检查通过，23:15 自动快照再次校验通过。

每 15 分钟定时备份继续运行。备份仍在同一云服务器受保护目录，尚无异机副本，不能承诺零数据损失。

浏览器检查覆盖管理员维护连接与授权、成员权限变化、多组织切换、手机宽度、中英文及深色大字体；生产页面验收没有写入测试业务数据。[网页 CI 34609599601](https://github.com/AIsMovDataInfra/RackTop-Workspace/actions/runs/34609599601) 成功。

## 自动检查与权限边界

| 范围 | 实际结果 |
| --- | --- |
| 网页后端与界面 | 167 + 162，共 329 项通过；TypeScript 与生产构建通过 |
| 桌面界面 | 提交前全量及个人上传隔离回归通过；正式 CI 全量 339 项通过 |
| Linux 原生 Rust | 196 项通过，3 项环境依赖测试在常规运行中忽略；真实 Node relay 测试由 CI 单独运行并通过 |
| 两种 Mac 原生 Rust | 每架构 184 项通过，3 项既有测试忽略 |
| 安装与发布工具 | 安装器 17、组合发布器 13、Mac 发布器 6、Flatpak 打包 10、签名下载 9 项通过 |
| 原生目录回环探针 | 真实测试后台 JSON、独立资料与本机 HTTP，验证目录导入、独立连接身份、首次本机认证、撤权终止子进程和重启后重新授权 |

独立审查及回归覆盖组织切换、撤权后立即重授、阻塞钥匙串期间撤权、迟到凭据与终端回调，以及旧托管目录缓存不得作为个人资源重新上传到另一组织。回环探针未使用真实公司 SSH 服务器。本轮没有向真实用户资料安装程序或上传个人 SSH 凭据。

## 正式 Mac 原生产物

| 架构 | 原生环境 | 正式 job 与完成时间 |
| --- | --- | --- |
| Apple Silicon / arm64 | macOS 14.8.9 | [103305155985](https://github.com/AIsMovDataInfra/RackTop-Workspace/actions/runs/34612185746/job/103305155985)，22:57:20 成功 |
| Intel / x86_64 | macOS 15.7.9 | [103305155794](https://github.com/AIsMovDataInfra/RackTop-Workspace/actions/runs/34612185746/job/103305155794)，23:06:12 成功 |

两个 job 均通过 DMG 校验与挂载、目标架构、严格代码签名、更新包 minisign、DMG 与更新归档内 app 内容和模式一致检查；隔离空资料原生启动至少 8 秒并创建数据库。正式截图已逐张审阅，可见正常 2.5.0 首页，无白屏或明显布局问题。

正式 CI 文件已单独下载，包大小和 SHA-256 与 CI 报告、GitHub Release digest 一致。两个更新归档内版本与构建版本均为 `2.5.0`、应用 ID 为 `com.racktop.desktop`；Mach-O CPU、LICENSE 和 NOTICE 对应冻结源码。使用冻结生产公钥及本机独立 minisign 验签通过，包含可信注释签名。两包声明最低 macOS 11.0，实际原生启动仅覆盖上表环境。签名为 ad-hoc，未经过 Apple 公证；本轮未执行真实 Mac 用户旧版升级、资料保留或完整 GUI 交互测试。

## Ubuntu 20.04 正式旧版升级

在隔离 Ubuntu 20.04.5 用户空间、Flatpak 1.6.5 与 GNOME 50 中，从原始 2.2.2 安装及独立合成资料重新复制基线，执行冻结源码中的原统一安装器。安装器通过实际生产 HTTPS 清单下载正式应用包，没有下载或安装 mock：

- 旧部署 commit `77eac82bcbcfc558e8c5965059ceb2e134051910286dd1542d974126d7cbcf68` 升级为正式 `fab7794c1e694ad0a1af114cc16deb3c734547260f46055dcb81b6ae62693c81`。
- 实际公开下载的 DEB、Flatpak 字节与正式 CI、Release digest 和校验清单一致；生产清单内两份签名独立验证通过。
- 原 user 安装范围和三个运行时 commit 不变；个人连接字段、完整历史快照、设置及 data/config/cache 哨兵内容保留。
- 完整 2.5.0 GUI、WebKit 和 SQLite 正常启动，旧资料和全新空资料分别运行超过 15 秒；数据库检查通过，并包含新增托管目录结构。
- 再次执行安装器只读取清单及 SHA-256 清单，未重新下载或安装应用包，Flatpak refs 不变。

HOME、XDG、Flatpak、DBus、钥匙串和临时目录均独立；下载安装时显式联网，GUI、资料和运行时检查关闭外网。最小 Focal rootfs 原来没有 curl/wget，验收使用 scratch 中 curl/libcurl 7.87.0、OpenSSL 1.1.1t 和 Focal CA，正常校验证书；私有库仅用于 curl 子进程，不影响应用。这不是系统默认 curl 7.68 TLS 栈测试，也不是物理 Focal 内核或专有 GPU 验证。

一次并行首次启动探针遇到 Flatpak 1.6 的 ldconfig 临时缓存竞争；GUI 本身正常，改为串行重跑后运行时检查通过。此次 Focal 验收复用原运行时，未重做空运行时完整离线套件安装；正式 Linux CI 已独立覆盖离线套件空安装及原生启动。system 安装范围和真实用户资料未在本轮 Focal 实机流程中操作。

## 正式 Release 附件

下表为 GitHub Release 的 11 个正式附件。已核验大小、SHA-256 与对应来源链；源码归档独立解包后，474 个跟踪文件、521 个归档条目的内容、模式和提交标识与标签提交一致。`SHA256SUMS` 覆盖其余 10 个附件，自身摘要使用 Release digest 核对。

| 文件 | 字节数 | SHA-256 |
| --- | ---: | --- |
| `LICENSE` | 35149 | `3972dc9744f6499f0f9b2dbf76696f2ae7ad8af9b23dde66d6af86c9dfb36986` |
| `NOTICE.md` | 2703 | `df41af7d9908083c2b26686640dbb9d9d788ddbf7ef9098c5fa56e0e29a6fbff` |
| `RackTop_2.5.0_linux-amd64-flatpak-offline.tar.gz` | 494316609 | `523588398016685bc41e1db37f96f64adc3a289c3d30a3d2c03ea86c8c3f63cd` |
| `RackTop_2.5.0_linux-amd64.deb` | 11973344 | `86730ca81edabfde1547b95ecb2441d05fefa5ebb7e751f9ff25a5de9af891da` |
| `RackTop_2.5.0_linux-amd64.flatpak` | 14062760 | `8c6c1ead1cd1e0edbfec67f97acf1ae5d83c898bcc5670fb8bc4c0d41b72ea4e` |
| `RackTop_2.5.0_macos-arm64-unsigned.app.tar.gz` | 9523150 | `6691bf0ed4fb7b848af4a6ba05cd76ff55609ee7593ff822a06b91726b01782a` |
| `RackTop_2.5.0_macos-arm64-unsigned.dmg` | 9622029 | `9c3e3387130583aa69ab1788e9d2586cf9a7c08584b31fbd9584c17f5e504ef9` |
| `RackTop_2.5.0_macos-x64-unsigned.app.tar.gz` | 10174627 | `2031bbd6ad731f6105ad1c6de1d073fd8b3174bf4bd686272d55658ec1612042` |
| `RackTop_2.5.0_macos-x64-unsigned.dmg` | 10259218 | `22a06b10128a5c1ff73015e1409b960ee246aacaf27e395fa9c5e3038ab93567` |
| `RackTop_2.5.0_source.tar.gz` | 9682561 | `0fdb29cc0cbb478fa851cff9c38b7ea04fe5db8bf64c24fecd5381fa089a7ac0` |
| `SHA256SUMS` | 985 | `22a36880f52a27ece2710473ed5f94c21bbc0458d5af7bcd5ff91845ae75eb17` |

## 生产更新清单与独立验签

**23:17:34** 使用正常 HTTPS 地址读取实际生产 [Mac 清单](https://raw.githubusercontent.com/AIsMovDataInfra/RackTop-Workspace/updater/macos.json) 和 [Linux 清单](https://raw.githubusercontent.com/AIsMovDataInfra/RackTop-Workspace/updater/linux-amd64.json)，未添加缓存绕过参数。两者均为 2.5.0，发布时间与 Release 一致；`updater` 发布提交为 `6550e75c92d26ce2976b626235abea33129a769f`。

Mac arm64/x64、Linux DEB/Flatpak 四目标的平台集合、URL、CI 签名、实际包 SHA-256 和 GitHub digest 全部匹配，使用冻结生产公钥及独立 minisign **4/4 验签通过**。Flatpak 清单 commit 与正式包一致。签名取自公开生产清单；Release 不另附 `.sig` 文件。修改一字节的独立测试副本被拒绝。

公钥来自功能提交中的 `src-tauri/linux-updater.pub`，文件 SHA-256 为 `829db78bd40acf64270fa7c217e0ff71ece26853646f0331debc09c1179c73af`。独立 minisign 0.11 从 Ubuntu 官方签名仓库验证并仅解压到 scratch，未安装到系统。Mac 清单 SHA-256 为 `13ec05a9781bbe2571895f6ce81743315425fb7c7a6592dcf30e23c3dc3d8db8`，Linux 清单为 `bfa65c4b4bb8b78e7e7c45f8ca50ae46b577dec232c8e5656a71343796a20b05`。四目标密码学验签作为镜像发布前门槛通过。

## 云端镜像最终结果

[云端下载页](https://136.0.110.161/downloads/) 于 **23:21:07** 发布。外部正常 TLS、匿名完整流下载共 **15 个文件、569,684,567 字节**，全部大小与 SHA-256 匹配。覆盖安装包、更新包、源码、LICENSE、NOTICE、校验清单、Ubuntu 20.04 说明、下载页及统一安装脚本；真实浏览器确认四个平台的 2.5.0 下载入口和链接正确。

云端 `SHA256SUMS` 是含下载辅助文件的汇总清单（1830 字节），原 Release 清单保留为 `SHA256SUMS-2.5.0`（985 字节），后者与上表 Release `SHA256SUMS` 字节一致。[统一安装器](https://136.0.110.161/downloads/install-racktop.sh) 返回 `text/plain`、`nosniff`，缓存策略仅为 `no-cache`。

## 使用边界

- 目录每 30 秒轮询；客户端观察到撤权会停止托管连接。网络失败或 75 秒本机授权到期也会停止使用，管理员操作并非全网即时推送。
- 目录权限控制 RackTop 内托管连接，不能代替远端 SSH 账号和密钥管理。个人连接不自动上传，本机密码和私钥不进入中央目录。
- 旧 2.2.2 Flatpak 需要先通过统一安装器手动升级一次；该路径已用正式公开产物验证。新版再使用应用内更新；未来版本的实际在线升级尚无法在本次 2.5.0 发布时验证，已有签名下载与更新生命周期测试覆盖。
- 同格式升级保留原安装范围和资料；DEB 与 Flatpak 使用不同个人资料目录，不自动跨格式迁移。不要先卸载旧版来完成升级。
- Mac CI 空资料启动不能代替真实用户旧版升级和资料保留测试；异机备份仍未配置。
