# 2.2.2 Ubuntu 20.04 兼容验证

本轮为开发验证，尚未发布。

- 官方 Ubuntu Base 20.04.5 amd64 用户空间已通过 SHA-256 与 Ubuntu CD Image GPG 签名验证。原客户端在 glibc 2.31 下报告缺少 GLIBC_2.32 / 2.33 / 2.34；20.04 软件源没有 WebKitGTK 4.1，新 Debian 包安装被 APT 正确拒绝。
- 标准 Flatpak 1.6.5 读取当前 Flathub 索引超过 10 MiB 上限，因此提供 GNOME 50 与 Mesa 运行时离线套件。未安装 Flatpak PPA。
- 前端 71 个文件、334 项测试通过，TypeScript 与生产构建通过。
- Rust release 库测试 173 项通过，3 项既有忽略；Debian 包已构建并通过本机隔离资料原生启动。
- Flatpak 已实际构建。GNOME Platform 运行时中的共享库、SSH、密钥生成及密码助手检查通过。
- Ubuntu 20.04 / Flatpak 1.6.5 下原生启动持续 15 秒，追加 60 秒复测也通过，WebKit 进程运行，隔离数据库含 servers 表且 quick_check=ok；截图显示 v2.2.2 中文总览界面。
- 打包与离线安装器 10 项测试通过，统一发布器 12 项测试通过。重复安装按精确应用 commit 跳过，已有运行时保留；运行时升级需按安装文档显式替换。
- 从空 Flatpak 用户目录、无外部网卡的网络命名空间中，使用标准 1.6.5 成功安装完整离线套件，并再次运行安装器成功。仅安装应用、GNOME 50、Mesa 25.08 与 25.08-extra，三个运行时 commit 与套件记录一致。使用该安装再次完成原生启动、数据库与界面截图验证。
- 修复后的 GitHub Actions Linux 全部通过：前端/Rust/共享协议、DEB 构建与原生启动、Flatpak 构建与原生启动、离线套件构建及空目录断网重复安装，工作流 [34579927417](https://github.com/AIsMovDataInfra/RackTop-Workspace/actions/runs/34579927417)，代码提交 `83f3283`。

离线套件 SHA-256：`9b86f1e4fd5b21678c242a586c446080dead4babcbda05ac54360fcac349288a`。本地包为开发验证产物，尚未上传为 Release。

原生检查使用 Xvfb、软件图形和临时资料。隔离 Ubuntu 20.04 用户空间运行于本机 Ubuntu 22.04 内核；系统和图形库来自 Focal 与 Flatpak，为显示中文额外只读挂载宿主机字体。不能替代 Ubuntu 20.04 原生内核、真实 GNOME 桌面、Wayland、GPU 驱动、钥匙串授权或真实服务器端到端验证。当前环境没有可用的原生 computer-use 控制工具，未声称完成点击、连接或交互验收。

本轮 Actions 仅选择 Linux，未重建 Mac/Windows，未执行正式发布、用户安装替换或线上更新通道切换。组织 App 缺少 Pull Request 写权限，创建 Draft PR 返回 `Resource not accessible by integration`；修复分支已成功推送。

## Actions 产物核验

Actions 已上传 Linux amd64 DEB、小 Flatpak、离线套件三个安装产物及单独的验证证据。DEB 与小 Flatpak 已完整下载、重算 SHA-256 并匹配侧文件；DEB 包名、版本、架构为 rack-top / 2.2.2 / amd64。

| CI 文件 | SHA-256 |
| --- | --- |
| RackTop_2.2.2_linux-amd64.deb | 388750dd5052a610637d82c4a2a7eb0ac700bc00fa72154f25c6c0fab657b13b |
| RackTop_2.2.2_linux-amd64.flatpak | 62a75615493ff77cc15f9af23a9a622931aefba4194a774e50e0aa34b58d2ff4 |
| RackTop_2.2.2_linux-amd64-flatpak-offline.tar.gz | 3a361f0bea6032ea704197cb04c1acb8ee1e5da6ae1355310d364a2e12b7a065 |

CI 离线套件大小为 494,374,256 字节，通过 ZIP 范围读取核验内部文件名、大小和摘要侧文件；未完整重复下载、独立重算该 tar.gz 的摘要。离线安装及包内全部 SHA-256 验证由 CI 实际执行并通过。以上为独立 CI 构建的摘要，本地构建按前文自己的校验清单核对。Actions Artifact ZIP 与内部安装包的摘要不同，不能混用。
