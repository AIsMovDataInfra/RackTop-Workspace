# 2.2.2 Ubuntu 20.04 兼容验证

本轮为开发验证，尚未发布。

- 官方 Ubuntu Base 20.04.5 amd64 用户空间已通过 SHA-256 与 Ubuntu CD Image GPG 签名验证。原客户端在 glibc 2.31 下报告缺少 GLIBC_2.32 / 2.33 / 2.34；20.04 软件源没有 WebKitGTK 4.1，新 Debian 包安装被 APT 正确拒绝。
- 标准 Flatpak 1.6.5 读取当前 Flathub 索引超过 10 MiB 上限，因此提供 GNOME 50 与 Mesa 运行时离线套件。未安装 Flatpak PPA。
- 前端 71 个文件、334 项测试通过，TypeScript 与生产构建通过。
- Rust release 库测试 173 项通过，3 项既有忽略；Debian 包已构建并通过本机隔离资料原生启动。
- Flatpak 已实际构建。GNOME Platform 运行时中的共享库、SSH、密钥生成及密码助手检查通过。
- Ubuntu 20.04 / Flatpak 1.6.5 下原生启动持续 15 秒，WebKit 进程运行，隔离数据库含 servers 表且 quick_check=ok；截图显示 v2.2.2 中文总览界面。
- 打包与离线安装器 10 项测试通过，统一发布器 12 项测试通过。重复安装按精确应用 commit 跳过，已有运行时保留；运行时升级需按安装文档显式替换。
- 空目录断网安装整个离线套件及修复后的 GitHub Actions：验证中。

原生检查使用 Xvfb、软件图形和临时资料。隔离 Ubuntu 20.04 用户空间运行于本机 Ubuntu 22.04 内核，仅共享宿主机字体数据，不加载宿主机图形库。不能替代 Ubuntu 20.04 原生内核、真实 GNOME 桌面、Wayland、GPU 驱动、钥匙串授权或真实服务器端到端验证。当前环境没有可用的原生 computer-use 控制工具，未声称完成点击、连接或交互验收。
