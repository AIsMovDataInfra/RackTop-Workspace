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

按实际改动选择检查，并进行需要的平台运行验证。六处应用版本字段必须一致：`package.json.version`、`package-lock.json.version`、`package-lock.json.packages[""].version`、`src-tauri/Cargo.toml` 的 `[package].version`、`src-tauri/Cargo.lock` 中同名应用包的版本、`src-tauri/tauri.conf.json.version`。只更新应用版本，不重算依赖版本；详细记录追加至 [VERSION_INFOS.md](VERSION_INFOS.md)，用户摘要写入 [Version_overview.md](Version_overview.md)。历史 `VERIFICATION*.md` 保留实际验收范围，不能用旧版记录代替本轮检查。

`.github/workflows/build.yml` 构建 Linux DEB、Flatpak 及两种 Mac 包；`team-web.yml` 验证并打包团队网页。由 `scripts/publish-workspace-update.py` 核验版本标签、安装包、许可证、源码、摘要和签名后发布，并最后推进更新清单。

统一 Linux 安装入口为 `scripts/install-racktop.sh`，只安装已发布的预编译包。它读取 HTTPS 更新清单，从同一版本 Release 获取 `SHA256SUMS` 并核验包摘要。Ubuntu 20.04 初装使用完整 Flatpak 运行时套件；已有 Flatpak 保持原来的 user / system 范围，运行时齐备时只下载应用包。Ubuntu 22.04 新装使用 DEB。不要在安装失败后尝试源码编译，也不要用 `releases/latest` 推导版本：GitHub 的预发布不出现在该接口。

**当前分发为 [2.7.3 测试版（Pre-release）](https://github.com/AIsMovDataInfra/RackTop-Workspace/releases/tag/v2.7.3)。** 发布顺序为：完成全部平台验证 → 归并源码 → 固定版本标签 → 上传并验证全部附件 → 推进更新清单 → 发布安装脚本及下载页面。下载页提供统一在线安装器及四个平台安装入口。新 Ubuntu 20.04 离线套件的根目录为 `RackTop_2.7.3_flatpak_offline`，内置 `install.sh` 进行用户级安装；保留已有系统级安装应使用统一在线安装器。后续页面的阶段文字仍须以实际公开下载和安装验证为准。

SSH 连接和文件传输继续通过成员本机网络直连目标服务器。2.7.3 的客户端加固减少密码意外暴露，但不能阻止获授权成员主动取得密码。

## 2.8.0 待发布内容与兼容性

当前源码版本为 **2.8.0，待发布、待最终验证**；上方安装流程及公开下载仍为 2.7.3。正式包发布、验签和公开下载核验完成后，再更新用户下载链接及发布记录。

- 团队导航使用「资产设备管理」和「办公设备申请」，移除周报前台入口；已登录用户打开旧 `/reports` 链接可看到移除说明。周报 API 保留既有鉴权并返回 `410 REPORTS_REMOVED`，历史周报表、内容及相关审计保留，部署不得清表。旧客户端的周报入口可能仍存在，需要升级后同步移除。
- GPU / CPU 集群按实际 GPU 数量分类，保留原集群名称。CPU 入口和整机预约已准备，当前尚未登记 CPU 资源；本轮不提供通用 CPU 实时占用采集。
- 管理员使用 2.8.0 桌面登录团队并连接获授权的服务器后，桌面通过本机网络 SSH 采集 NVIDIA GPU 观测，约每 30 秒向云端同步摘要。托管采集需要同版本团队服务支持 `/api/servers/:id/telemetry`；旧 2.7.3 客户端不能提供该摘要。个人硬件同步与托管采集分开，成员账号不得上传托管摘要。实时摘要保存在内存中，关闭本地历史记录也能同步，不额外持久化完整采样。
- 云端新增托管资源绑定和占用摘要表，保留现有资源、预约及硬件身份。完整硬件观测才能首次建立 GPU 资源；失败采样不会创建假的 CPU 资源，硬件变化或归属冲突须由管理员核验。
- 没有足以判断占用或空闲的有效证据，或观测超过 90 秒有效期时，显示占用未知，不将旧数据视为空闲；部分查询失败但仍有占用证据时可显示被占用。占用用户名来自服务器 Linux 系统账号，与预约人分开；已知忙碌但无用户名显示「匿名用户」。摘要只用于协作判断，预约不停止实际任务，当前忙碌不禁止未来时段预约。

先部署经验证的团队服务，再让管理员使用正式 2.8.0 桌面采集；仅上线网页不能让旧桌面产生新摘要。服务更新需备份外置数据库，并核对历史周报、资产、申请、预约、硬件绑定及权限保留。安装包继续覆盖 Ubuntu 20.04 Flatpak（含离线套件）、Ubuntu 22.04 DEB 和两种 Mac；本轮平台安装、资料保留及真实端到端结果必须单独记录，不能套用 2.7.3 的验收。

### 正式构建入口

在六字段一致、功能与数据保留检查通过、最终提交已集成至 `main` 后，使用该提交创建尚不存在的不可变 `v2.8.0` 标签并推送。标签触发 [build.yml](../.github/workflows/build.yml) 的 Linux 与两种 Mac 正式构建；三者全部成功后才由发布 job 调用 [publish-workspace-update.py](../scripts/publish-workspace-update.py)。不要移动标签或手动提前推进 `updater`。

团队服务使用独立的 [team-web.yml](../.github/workflows/team-web.yml) 手动构建入口；Actions 产物只是部署包，构建成功不代表生产服务已更新。以下命令以已审核的最终 `main` 提交为前提；构建后还应核对 run 的 `headSha` 与最终提交相同：

```bash
racktop-gh workflow run team-web.yml --repo AIsMovDataInfra/RackTop-Workspace --ref main
racktop-gh run list --repo AIsMovDataInfra/RackTop-Workspace --workflow team-web.yml --limit 5
racktop-gh run list --repo AIsMovDataInfra/RackTop-Workspace --workflow build.yml --limit 5
```

正式 Release 后，核对附件、四个更新目标的签名、对应源码与许可证，再准备新版本的下载镜像与页面。2.7.3 的既有冻结策略和验收记录不能直接当作 2.8.0 发布依据；只有公开地址的实际内容与新产物吻合后，才把当前下载版本改为 2.8.0。

## 数据与来源

桌面应用 profile、SSH 密钥引用和系统钥匙串分别保存；团队数据库位于部署目录之外。部署和卸载不得删除用户资料。恢复方法与限制见[备份说明](../team-web/deploy/BACKUPS.md)及[Linux 资料目录](LINUX.md#本机集成)。

本项目源自 [Tongzh-SEU/RackTop](https://github.com/Tongzh-SEU/RackTop)，经 [AIsMov 原维护仓库](https://github.com/AIsMovDataInfra/RackTop)继续维护。公开分发继续提供对应源码、[GPL-3.0](../LICENSE)、[NOTICE](../NOTICE.md)及原作者署名。
