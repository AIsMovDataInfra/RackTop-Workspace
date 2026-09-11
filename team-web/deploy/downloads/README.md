# 公开安装包下载页

`index.html` 是 [云端下载页](https://136.0.110.161/downloads/) 的静态源文件。普通用户安装步骤见 [下载说明](../../../docs/DOWNLOADS.md)，源码发布流程见 [维护者入口](../../../docs/MAINTAINERS.md)。页面和安装包由 Nginx 直接提供，无需登录，不经过团队应用服务。

**当前源码正在准备 2.5.0，统一安装入口尚未发布。** 页面继续提供既有安装包；不能只改阶段文字就声称新版本已上线。

公开目录为 `/var/www/racktop-public/downloads/`。只放页面明确列出的安装包、对应源码、许可证、NOTICE、教程和 `SHA256SUMS`；数据库、备份、服务器配置与凭据不能放入此目录。安装包不提交到 Git 源码仓库。

当前文件：

- `index.html`
- `RackTop_2.2.2_linux-amd64-flatpak-easy.tar.gz`
- `RackTop_2.2.1_linux-amd64.deb`
- `RackTop_2.2.1_macos-arm64-unsigned.dmg`
- `RackTop_2.2.1_macos-x64-unsigned.dmg`
- `RackTop_2.2.2_source.tar.gz`
- `Ubuntu20.04-install.txt`
- `LICENSE`
- `NOTICE.md`
- `SHA256SUMS`

`nginx.conf` 是需要合入现有 HTTPS server 的位置规则，不是完整服务器配置。保留已有 TLS、API、应用代理和速率限制配置。上传先使用公开目录之外的暂存目录，核对文件大小、SHA-256 和许可文件后再整体发布；运行 `nginx -t` 通过后 reload。后续更新已发布安装包应使用新版本文件名。

发布后匿名下载文件并重新计算摘要，同时确认 `/equipment`、健康检查和需要登录的 API 行为正常。Ubuntu 20.04 套件内的 SHA256SUMS 校验原应用及运行时；目录顶层的 SHA256SUMS 校验公开下载文件。2.2.1 镜像必须与 GitHub Release 原附件的 Digest 一致。

此页面提供现成包下载，未创建新桌面版本，也不改变客户端自动更新通道。2.4.0 是团队网页版本。

## 2.5.0 统一安装入口

在 2.5.0 各平台构建、公开附件和更新清单全部验证后，将仓库 `scripts/install-racktop.sh` **复制为普通文件**到公开目录的 `install-racktop.sh`，并加入顶层 `SHA256SUMS`。不要创建指向源码目录的符号链接。`nginx.conf` 的精确匹配规则使这个固定入口重新验证缓存。

安装器直接读取 `updater/linux-amd64.json`，使用清单中的发布版本，从同版 Release 下载 `SHA256SUMS` 及安装包。Flatpak 条目须提供真实 OSTree `commit`；初装及缺运行时使用 `RackTop_X.Y.Z_linux-amd64-flatpak-offline.tar.gz`，运行时齐备时只下载 `RackTop_X.Y.Z_linux-amd64.flatpak`。现有同范围运行时不降级，应用更新使用 `--or-update`。

发布前运行 `bash -n scripts/install-racktop.sh` 与 `python3 scripts/test-install-racktop.py`。测试只调用模拟包管理器，不能代替 Ubuntu 20.04 / 22.04 的真实安装和升级验收。必须核对实际下载包、SHA256、Flatpak user / system 范围、重复运行和旧资料保持，再把 README、安装说明和页面的“尚未发布”改为实际发布状态。Mac 仍使用与芯片匹配的 DMG。
