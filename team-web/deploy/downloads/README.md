# 公开安装包下载页

`index.html` 是 [云端下载页](https://136.0.110.161/downloads/) 的静态源文件。普通用户安装步骤见 [下载说明](../../../docs/DOWNLOADS.md)。页面和安装包由 Nginx 直接提供，无需登录，不经过团队应用服务。

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
