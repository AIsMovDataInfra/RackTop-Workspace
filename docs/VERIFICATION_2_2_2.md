# 2.2.2 Ubuntu 20.04 兼容验证

本轮为开发验证，尚未发布。

- 官方 Ubuntu Base 20.04.5 amd64 用户空间已通过 SHA-256 与 Ubuntu CD Image GPG 签名验证。原客户端在 glibc 2.31 下报告缺少 GLIBC_2.32 / 2.33 / 2.34；20.04 软件源没有 WebKitGTK 4.1。
- 前端 71 个文件、334 项测试通过，TypeScript 与生产构建通过。
- Rust、Flatpak 构建、Ubuntu 20.04 用户空间运行与本机原生操作：验证中。

隔离 Ubuntu 20.04 用户空间运行于本机 Ubuntu 22.04 内核，不能替代 Ubuntu 20.04 原生内核、GNOME 桌面、GPU 驱动、钥匙串授权或真实服务器端到端验证。
