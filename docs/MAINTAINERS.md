# RackTop 源码与维护

普通用户从[下载页](https://136.0.110.161/downloads/)安装。本文面向修改源码、验证和发布的维护者。

## 仓库与分支

维护目标是 [AIsMovDataInfra/RackTop-Workspace](https://github.com/AIsMovDataInfra/RackTop-Workspace)。`main` 保存集成后的产品源码与用户文档，`updater` 单独保存客户端更新清单。进行中的一个产品版本复用一条开发分支；验证、归并并核对远端提交后，才清理已合入的开发分支。

`updater` 是客户端依赖的独立发布通道，不能删除或合并进 `main`。不要改写已有标签或安装包，也不要通过删除历史发布来简化用户首页。来源、许可证和全部历史版本说明继续保留。

公开推送、PR、Release 和 Actions 操作使用组织 GitHub App `dusan2026`，本机入口为 `racktop-gh` / `racktop-maintain`；不使用个人凭据。完整工作约定见 [AGENTS.md](../AGENTS.md)。

## 本地开发

桌面使用 Tauri 2、React、TypeScript、Rust 和 SQLite；需要 Node.js 22+、Rust stable、OpenSSH 及平台开发依赖。团队网页服务需要 Node.js 24+。

```bash
npm ci
npm run tauri dev
```

仅调试网页界面可运行 `npm run dev`；团队网页使用 `npm run team:dev`。浏览器预览不能替代原生 SSH、钥匙串、终端和更新流程验证。

| 范围 | 入口 |
| --- | --- |
| 桌面界面与原生功能 | `src/`、`src-tauri/` |
| 团队网页及持久化服务 | `team-web/` |
| 共享中继 | `relay/` |
| Linux / Flatpak 构建 | [Linux 指南](LINUX.md)、[Flatpak 打包](../packaging/flatpak/README.md) |
| macOS 构建与签名 | [Mac 指南](MACOS.md) |
| 云端部署与自动备份 | [部署说明](../team-web/deploy/README.md)、[备份恢复](../team-web/deploy/BACKUPS.md) |
| 公开下载页 | [下载页部署](../team-web/deploy/downloads/README.md) |

## 验证与发布

```bash
python3 scripts/check-release-version.py
npm run test
npm run build
npm run team:test
npm run team:build
cargo test --locked --manifest-path src-tauri/Cargo.toml
```

按实际改动选择检查，并进行需要的平台运行验证。版本号同步 npm、Cargo 和 Tauri；详细记录追加至 [VERSION_INFOS.md](VERSION_INFOS.md)，用户摘要写入 [Version_overview.md](Version_overview.md)。历史 `VERIFICATION*.md` 保留实际验收范围，不能用旧版记录代替本轮检查。

`.github/workflows/build.yml` 构建 Linux DEB、Flatpak 及两种 Mac 包；`team-web.yml` 验证并打包团队网页。由 `scripts/publish-workspace-update.py` 核验版本标签、安装包、许可证、源码、摘要和签名后发布，并最后推进更新清单。

统一 Linux 安装入口为 `scripts/install-racktop.sh`，只安装已发布的预编译包。它读取 HTTPS 更新清单，从同一版本 Release 获取 `SHA256SUMS` 并核验包摘要。Ubuntu 20.04 初装使用完整 Flatpak 运行时套件；已有 Flatpak 保持原来的 user / system 范围，运行时齐备时只下载应用包。Ubuntu 22.04 新装使用 DEB。不要在安装失败后尝试源码编译，也不要用 `releases/latest` 推导版本：GitHub 的预发布不出现在该接口。

**当前分发为 [2.7.3 测试版（Pre-release）](https://github.com/AIsMovDataInfra/RackTop-Workspace/releases/tag/v2.7.3)。** 发布顺序为：完成全部平台验证 → 归并源码 → 固定版本标签 → 上传并验证全部附件 → 推进更新清单 → 发布安装脚本及下载页面。下载页提供统一在线安装器及四个平台安装入口。新 Ubuntu 20.04 离线套件的根目录为 `RackTop_2.7.3_flatpak_offline`，内置 `install.sh` 进行用户级安装；保留已有系统级安装应使用统一在线安装器。后续页面的阶段文字仍须以实际公开下载和安装验证为准。

SSH 连接和文件传输继续通过成员本机网络直连目标服务器。2.7.3 的客户端加固减少密码意外暴露，但不能阻止获授权成员主动取得密码。

## 数据与来源

桌面应用 profile、SSH 密钥引用和系统钥匙串分别保存；团队数据库位于部署目录之外。部署和卸载不得删除用户资料。恢复方法与限制见[备份说明](../team-web/deploy/BACKUPS.md)及[Linux 资料目录](LINUX.md#本机集成)。

本项目源自 [Tongzh-SEU/RackTop](https://github.com/Tongzh-SEU/RackTop)，经 [AIsMov 原维护仓库](https://github.com/AIsMovDataInfra/RackTop)继续维护。公开分发继续提供对应源码、[GPL-3.0](../LICENSE)、[NOTICE](../NOTICE.md)及原作者署名。
