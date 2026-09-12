# 公开安装包下载页

[云端下载页](https://136.0.110.161/downloads/)当前提供 2.8.0 测试版（Pre-release）。本目录的 `index.html`、`Ubuntu20.04-install.txt` 已同步为 2026-09-13 00:22:46（UTC+8）实际公布并通过匿名 HTTPS 摘要核验的两份内容。后续发布仍应先读取线上现状，再准备和验证候选内容，避免覆盖其他维护者的修改。普通用户见[下载说明](../../../docs/DOWNLOADS.md)，发布维护见[维护者入口](../../../docs/MAINTAINERS.md)。页面和安装包由 Nginx 直接提供，无需登录。

公开目录为 `/var/www/racktop-public/downloads/`。当前公开版本使用这些文件；保留历史安装包，不覆盖旧版本附件：

- `index.html`、`install-racktop.sh`、`Ubuntu20.04-install.txt`
- `RackTop_2.8.0_linux-amd64-flatpak-offline.tar.gz`
- `RackTop_2.8.0_linux-amd64.deb`
- `RackTop_2.8.0_macos-arm64-unsigned.dmg`
- `RackTop_2.8.0_macos-x64-unsigned.dmg`
- `RackTop_2.8.0_source.tar.gz`、`LICENSE`、`NOTICE.md`、`SHA256SUMS`

Ubuntu 20.04 新套件内根目录为 `RackTop_2.8.0_flatpak_offline`，运行 `bash install.sh`，仅进行用户级安装。旧 2.2.2 简易套件内才运行 `install-racktop.sh`。固定在线入口 `/downloads/install-racktop.sh` 自动识别已有 Flatpak 的安装范围。

在线安装器从 `updater/linux-amd64.json` 获取版本和 Flatpak commit，下载同版 GitHub Release 的安装包及 SHA256SUMS；初装或缺运行时使用离线套件，运行时齐备时只下载应用包。不要用 GitHub `releases/latest` 推导测试版版本。

发布顺序保持：归并源码并固定标签 → 三平台产物、签名及全部 Release 附件核验 → 推进更新清单 → 暂存云端文件 → 核验后发布页面与安装入口。Mac 实际签名状态必须与文件名及页面说明一致；若产物不是 `-unsigned`，先按真实附件修改链接和公证说明。

`install-racktop.sh` 从源码复制为普通文件，不创建指向源码目录的符号链接。顶层 SHA256SUMS 对应云端公开文件，包含安装脚本；它与仅列 Release 附件的 GitHub SHA256SUMS 范围不同。安装包及对应源码应与 GitHub 原附件逐项比对。

`nginx.conf` 只提供位置规则，保留已有 TLS、API 和应用代理。先在公开目录外暂存，核对摘要与许可文件；需要修改 Nginx 时，`nginx -t` 通过再 reload。数据库、备份、服务器配置和凭据不得放入下载目录，安装包不提交源码仓库。

发布后匿名下载并重算摘要，确认安装入口、四个平台链接、源码、许可证、NOTICE 和教程可用，同时检查团队页面及认证 API。模拟安装测试不能代替 Ubuntu 20.04 / 22.04 的真实安装、旧 2.2.2 引导升级与原资料保留验收。
