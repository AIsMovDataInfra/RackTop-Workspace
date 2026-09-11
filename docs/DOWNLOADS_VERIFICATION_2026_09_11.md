# 2026-09-11 安装包云端分发验证

统一入口：[安装 RackTop](https://136.0.110.161/downloads/)。免登录，按 Ubuntu 20.04、Ubuntu 22.04、Mac Apple Silicon、Mac Intel 分别选择安装包。普通用户无需编译源码；步骤见 [下载教程](DOWNLOADS.md)。

## 本次范围与版本

本次为现成安装包的云端镜像、Ubuntu 20.04 简易套件分发和安装文档整理。复用 `codex/v2.4.0-equipment-overview`，不新增版本分支。在线团队工作台仍为 2.4.0；本次未构建 2.4.0 桌面包。

- Ubuntu 20.04 x86_64：2.2.2 开发兼容版，Flatpak 应用、运行时和简易安装脚本一起提供。
- Ubuntu 22.04 amd64：2.2.1 测试版 DEB。
- Mac arm64 / x64：2.2.1 测试版 DMG，ad-hoc 签名，未经 Apple 公证。
- 2.2.1 原包已有 [GitHub Release v2.2.1](https://github.com/AIsMovDataInfra/RackTop-Workspace/releases/tag/v2.2.1)，目标提交 `98495509441955889c3e4aa8bbe90e0bf2261dd2`。本次镜像与原附件摘要一致，未覆盖 Release、移动标签或修改更新清单。
- Ubuntu 20.04 简易套件本次发布到云站点；未创建 v2.2.2 GitHub Release。对应源码归档来自 `83f3283621c907db7a7bfce37d98cf1583e3c7d7`，随下载页提供源码、GPL-3.0 和 NOTICE。

## 公开安装文件

以下文件均位于统一下载页的 `/downloads/` 目录。完整目录包含 10 个公开文件；校验文件为 [SHA256SUMS](https://136.0.110.161/downloads/SHA256SUMS)。

| 文件 | 字节 | SHA-256 |
| --- | ---: | --- |
| RackTop_2.2.2_linux-amd64-flatpak-easy.tar.gz | 494401582 | `4799c743bcd28d392a04320961fdcc5297866b9c1262b9028ddf209189656aa3` |
| RackTop_2.2.1_linux-amd64.deb | 11725938 | `4e332b7f6508355c74549b44ccfa80a0cabadf3028d2e8cfbeca2c17be20db9f` |
| RackTop_2.2.1_macos-arm64-unsigned.dmg | 9425445 | `c79b277319da90be75ddebfc4db2ce1e08283175a71cf9875cfe74c815e9d60f` |
| RackTop_2.2.1_macos-x64-unsigned.dmg | 10085860 | `d46dd09fb0580e00816ad9e6b7411490b38e70a8cc6818df99b4857292f8b22e` |

2.2.2 云端套件重新打包时保持原先已验证套件内全部 13 个文件的内容、大小和权限不变；外层压缩包元数据改变，因此以上云端摘要与此前本地“简易安装”归档的 `2ca857…` 摘要不同。未用另一份构建替换应用或运行时。

## 已执行的核验

- 匿名完整下载 GitHub 的 3 个 2.2.1 安装包，大小及 SHA-256 与 GitHub Digest 一致。
- 发布前检查公开目录严格包含指定文件，无符号链接；上传后及复制到公开目录后分别核验完整大小和 SHA-256。
- 从公网 HTTPS 匿名完整下载全部 10 个文件，逐个核验大小和 SHA-256。重新检查下载后的 2.2.2 归档，全部 13 个内部文件与原套件一致，且无绝对路径、路径穿越或链接条目。
- 下载页和大包 HEAD 返回 200；大包 Range 请求返回 206，Content-Range 与总字节数正确。缺失文件返回 404；POST 被拒绝为 403。
- Nginx 配置检查通过后 reload，只增加静态下载位置。`/equipment` 返回 200，`/healthz` 返回 200，未登录访问 `/api/equipment` 返回 401。
- Nginx、团队应用、共享中继和设备数据库备份 timer 均 active；应用仍指向既有 2.4.0 发布目录。本次未写入数据库、改变备份计划或重启应用。
- 浏览器检查正式下载页、4 个平台入口和 Mac 说明定位；本地预览检查桌面、390px 窄屏、浅色及深色样式，以及根字号放大至 32px 的窄屏布局，未见水平溢出。深色和大字预览通过本地 CSS 测试副本显示，测试副本未发布。
- 当前文档与实际 DEB 元数据核对：版本 2.2.1、架构 amd64，依赖 WebKitGTK 4.1 运行库；标签 CI 配置使用 Ubuntu 22.04。未把支持范围扩大到其他 Ubuntu 版本。

## 验证边界

本次分发不重新编译桌面应用，也未重新执行 Mac 或 Ubuntu 22.04 整机安装验收。Ubuntu 20.04 简易安装套件此前通过 Focal 用户空间的隔离安装、重复安装及错误分支检查；云端版本保持这些被验证文件不变。实体电脑的硬件、桌面环境、系统密钥环及真实用户完整操作仍需在相应电脑确认。

Mac 首次打开遵循 [Apple 官方说明](https://support.apple.com/zh-cn/102445)。Ubuntu 22.04 的 WebKitGTK 4.1 运行库可查 [Ubuntu 官方包信息](https://packages.ubuntu.com/jammy/libwebkit2gtk-4.1-0)。

页面源码和 Nginx 位置规则保存在 [下载页部署目录](../team-web/deploy/downloads/README.md)。安装包存云端，不提交进 Git 源码仓库。
