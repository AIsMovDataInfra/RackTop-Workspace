# RackTop · AIsMov 团队工作台

本项目由 **AIsMov** 维护，当前代码与 Linux / macOS 分发位于独立公开仓库 [AIsMovDataInfra/RackTop-Workspace](https://github.com/AIsMovDataInfra/RackTop-Workspace)。桌面应用继续叫 **RackTop**，在线网页为 **AIsMov RackTop 团队工作台**。项目源自 [Tongzh-SEU/RackTop](https://github.com/Tongzh-SEU/RackTop) 及 [原 AIsMov 维护仓库](https://github.com/AIsMovDataInfra/RackTop)，保留原作者 **Tongzh-SEU**、完整 Git 历史、[GPL-3.0](LICENSE) 和[来源说明](NOTICE.md)。

本轮开发版本为 **2.1.0**，继续提供Linux amd64及Mac Apple Silicon、Intel两种安装包。新增24种彩色头像、完整公司筛选、超管周报统计和明确的周一至周日报告窗口；网页以 **RackTop** 为主字、**AIsMov · 团队工作台** 为辅助字。本地自动化与两套生产构建已通过，浏览器剩余流程、部署和发布验收继续进行，见[2.1.0验证记录](docs/VERIFICATION_2_1.md)。上一版[2.0.0 Release](https://github.com/AIsMovDataInfra/RackTop-Workspace/releases/tag/v2.0.0)仍可下载，其[历史验证记录](docs/VERIFICATION.md)保留。

<div align="right">
  🌐 Language:
  <kbd><strong>✔简体中文</strong></kbd>
  <a href="./README_EN.md"><kbd>English</kbd></a>
</div>

<p align="center">
  <img src="docs/assets/readme/racktop-icon.png" alt="RackTop Logo" width="300" />
</p>

<h2 align="center">多台服务器，一个训练工作台</h2>

<p align="center">
  📊 查看算力、🔄 同步项目、🚀 启动任务，📈 并持续掌握运行状态。
</p>

<p align="center">
RackTop 是面向个人研究者和小型团队的 GPU 服务器桌面工作台，将分散在多台 Linux 服务器的算力状态、远程终端、项目资料和训练任务集中管理。
启动前快速找到合适的 GPU，运行中持续掌握资源与进程状态，切换服务器时让项目、数据集和模型保持就绪。
</p>

<p align="center">
  <a href="https://github.com/AIsMovDataInfra/RackTop-Workspace/releases"><img src="https://img.shields.io/github/v/release/AIsMovDataInfra/RackTop-Workspace?include_prereleases&style=flat-square&logo=github&label=release" alt="Release"></a>
  <a href="https://github.com/AIsMovDataInfra/RackTop-Workspace/stargazers"><img src="https://img.shields.io/github/stars/AIsMovDataInfra/RackTop-Workspace?style=flat-square&logo=github&label=stars" alt="GitHub Stars"></a>
  <img src="https://img.shields.io/badge/platform-Linux%20%7C%20macOS%20%7C%20Windows-1687b8?style=flat-square" alt="Platform">
  <a href="https://github.com/AIsMovDataInfra/RackTop-Workspace/releases"><img src="https://img.shields.io/github/downloads/AIsMovDataInfra/RackTop-Workspace/total?style=flat-square&logo=github&label=downloads" alt="Downloads"></a>
  <a href="https://github.com/AIsMovDataInfra/RackTop-Workspace/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-GPL--3.0-green?style=flat-square" alt="GPL-3.0 License"></a>
</p>



<p align="center">
  <img src="docs/assets/readme/fleet-overview.png" alt="全局算力总览" width="33%">
  <img src="docs/assets/readme/history-heatmap.png" alt="资源历史热力图" width="33%">
  <img src="docs/assets/readme/idle-compute.png" alt="空闲算力筛选" width="33%">
</p>


## 下载

**2.1.0目标安装包，待发布验收。** 以下链接在发布完成前可能不可下载；Mac继续提供两种架构。

| 平台 | 目标安装包 |
| --- | --- |
| Linux amd64 | [RackTop_2.1.0_linux-amd64.deb](https://github.com/AIsMovDataInfra/RackTop-Workspace/releases/download/v2.1.0/RackTop_2.1.0_linux-amd64.deb) |
| Mac Apple Silicon | [RackTop_2.1.0_macos-arm64-unsigned.dmg](https://github.com/AIsMovDataInfra/RackTop-Workspace/releases/download/v2.1.0/RackTop_2.1.0_macos-arm64-unsigned.dmg) |
| Mac Intel | [RackTop_2.1.0_macos-x64-unsigned.dmg](https://github.com/AIsMovDataInfra/RackTop-Workspace/releases/download/v2.1.0/RackTop_2.1.0_macos-x64-unsigned.dmg) |

### 已发布的上一版

以下2.0.0安装包仍可下载，已有验证不代替2.1.0验收。

| 客户端平台 | 提供方 | 安装包与下载 |
| --- | --- | --- |
| **Ubuntu 22.04 x86_64 / amd64** | **AIsMov 2.0.0 测试版** | [下载 Linux .deb](https://github.com/AIsMovDataInfra/RackTop-Workspace/releases/download/v2.0.0/RackTop_2.0.0_linux-amd64.deb) |
| macOS Apple Silicon（M 系列） | AIsMov 2.0.0 测试版 | [下载 arm64 .dmg](https://github.com/AIsMovDataInfra/RackTop-Workspace/releases/download/v2.0.0/RackTop_2.0.0_macos-arm64-unsigned.dmg) |
| macOS Intel | AIsMov 2.0.0 测试版 | [下载 x64 .dmg](https://github.com/AIsMovDataInfra/RackTop-Workspace/releases/download/v2.0.0/RackTop_2.0.0_macos-x64-unsigned.dmg) |
| Windows x64 | Tongzh-SEU 官方历史版 v1.25.4 | [下载官方安装程序](https://github.com/Tongzh-SEU/RackTop/releases/download/v1.25.4/RackTop_1.25.4_x64-setup.exe) |

上述 2.0.0 安装包已发布并验证可下载，完整文件名与校验值见[附件摘要表](docs/VERIFICATION.md#公开附件与更新签名)。Linux 和 Mac 共用 [v2.0.0 Release](https://github.com/AIsMovDataInfra/RackTop-Workspace/releases/tag/v2.0.0)，按文件名选择平台和芯片；Mac `.app.tar.gz` 为更新技术附件，通常安装请选 DMG。Mac 包采用 ad-hoc 签名、未经过 Apple 公证，首次打开步骤见 [Mac 指南](docs/MACOS.md#安装与首次打开)。Windows 继续使用[上游版本](https://github.com/Tongzh-SEU/RackTop/releases)。

从旧 `1.30.0-linux.12` 或其他旧维护版迁入，下载并手动安装一次新仓库包。新分发使用专用签名密钥和新更新地址，旧更新通道不会自动迁移；应用标识与本机数据目录保持兼容。Mac 用户先退出应用，再用新 DMG 替换安装。

```bash
sudo apt install ./RackTop_2.0.0_linux-amd64.deb
racktop
```

也可以从应用菜单启动。更多依赖、密码存储、源码构建和已知限制见 [Linux 使用说明](docs/LINUX.md)。如需校验，下载同一 Release 的 `SHA256SUMS` 后运行 `sha256sum --check --ignore-missing SHA256SUMS`。

## 在线团队工作台

以下包含2.1.0功能说明；线上升级状态以[本轮验证记录](docs/VERIFICATION_2_1.md)为准。

打开 [AIsMov RackTop](https://136.0.110.161)，用一个成员名称和密码注册，不需要邮箱。超级管理员分配公司后即可使用本公司的设备台账和算力预约；2.1.0设置中可选择24种彩色头像，原7种保持兼容，网页“记住登录”为 360 天，桌面设备登录仍为 30 天。

| 功能 | 使用方式 |
| --- | --- |
| 设备管理 | 目录显示照片和公司；超管始终可筛选四家公司及零数量状态，手机扫码登记负责人、使用人和位置，打印资产标签。 |
| 周报与绩效 | 明确本周与下周日期范围；超管按周、公司、成员查看提交、任务与人工评分汇总，单份周报仍限作者、指定评审人和超管查看。 |
| 算力预约 | 同公司整机或指定 GPU 排期、冲突检查、续约与取消；管理员同步桌面 GPU 清单或手工登记资源。 |
| 设备申请与领取 | 员工提交申请后只得到编号确认；只有超管能读申请内容和审批，关联现有设备的领取会同步使用人及设备状态。 |

桌面「密钥管理」与「日志」之间的 **团队工作台** 支持悬停、键盘焦点或点击展开，主按钮打开网页首页。原 **团队预约** 桌面页保留本机资源选择、同步与排期功能。说明见[工作台指南](docs/WORKSPACE.md)、[账号管理](docs/TEAM_ACCOUNTS.md)、[设备指南](docs/EQUIPMENT.md)和[预约服务](team-web/README.md)。

线上只保存团队业务资料。本轮没有 SSH 连接云同步；SSH 地址、账号、密码、私钥和进程明细仍不随预约同步上传。桌面 **SSH 配置** 支持导入与勾选导出连接，导出不含密码、私钥或本机私钥路径。预约不会锁定 GPU 或终止训练进程。

本机体验（Node.js 24+）：`npm ci` 后执行 `npm run team:dev`，打开 `http://127.0.0.1:1421/`。完整新功能需使用独立 account 测试库，默认 demo 不提供公司身份与周报/申请权限。

## 项目来源与反馈

RackTop 最初由 [Tongzh-SEU](https://github.com/Tongzh-SEU) 开发，面向研究者和小团队集中管理 GPU 服务器。感谢原作者及上游贡献者提供完整的桌面应用基础。**AIsMov** 负责本项目的持续维护、功能改进、问题处理和 Linux / macOS 发行。

AIsMov 维护版增加 Linux 平台识别、系统钥匙串接入、原生窗口适配、Debian 打包、独立跳板机密码、签名更新、SSH 连接配置分享和本机 SSH 密钥管理。详细变更见 [版本记录](docs/VERSION_INFOS.md) 与 [来源说明](NOTICE.md)。本维护版的功能建议与问题请提交到 [RackTop-Workspace Issues](https://github.com/AIsMovDataInfra/RackTop-Workspace/issues)；原项目与官方 Windows/macOS 版本见 [上游仓库](https://github.com/Tongzh-SEU/RackTop)。

## 主要功能

- **多服务器算力总览**：集中查看 GPU、CPU、系统内存、温度、利用率和进程状态，并按服务器与 GPU 快速定位资源。
- **空闲算力发现**：按显存、利用率、占用状态和持续空闲时间筛选可用 GPU，直接打开远程终端或进入启动任务流程。
- **远程终端**：通过 SSH 打开服务器终端，适合临时检查环境、查看文件和处理启动前问题。
- **项目资料管理**：按项目管理工作目录，并关联数据集和模型；支持跨服务器检查状态、同步副本和补齐缺失资料。
- **启动配置与任务管理**：保存项目级启动配置，在不同服务器和 GPU 上切换工作目录、GPU 卡号、Shell 命令、超参数和日志路径，再统一启动和监测任务。
- **运行状态与历史**：查看 RackTop 任务和外部进程、日志、资源监测、历史热力图，以及离线、高温、空闲和进程退出通知。
- **安全连接**：支持 SSH Agent、密钥、密码、`~/.ssh/config`、ProxyJump 和 Host Key 指纹核验，不自动接受未知主机。
- **本机 SSH 密钥管理**：从左下角“密钥管理”入口发现已有密钥、手动生成 Ed25519 或 RSA 4096 密钥对、导入引用、重命名和复制公钥；在服务器设置中选择对应私钥。移出列表会保留原文件。


## 安全与数据

- Host Key 未确认时不会自动接受；指纹变化会阻止连接。
- 密码不会写入命令行、日志或 SQLite，只保存在会话内存或系统钥匙串。
- RackTop 使用本机 OpenSSH 连接远程服务器；历史采样和任务/文件管理功能可能在远端写入文件，请按需配置。
- 服务器、项目、数据集、模型、启动配置和历史数据保存在本机应用数据目录；卸载应用通常不会自动删除这些数据，如需彻底清理请先在应用设置中导出或删除，再按操作系统清理应用数据目录。

## 开发者说明

RackTop 使用 Tauri 2、React、TypeScript、Rust 和 SQLite 构建。开发环境需要 Node.js 22+、Rust stable 和系统 OpenSSH。

```bash
npm install
npm run dev
npm run tauri dev
```

运行前端构建和 Rust 测试：

```bash
npm run build
cargo test --manifest-path src-tauri/Cargo.toml
```

本地打包：

```bash
npm run tauri build
```

Linux 开发者请先安装 [系统开发依赖](docs/LINUX.md#从源码构建)，再运行 `npm run bundle:linux -- --locked`；产物在 `src-tauri/target/release/bundle/deb/`。macOS 的双架构构建与签名说明见 [macOS 开发指南](docs/MACOS.md#从源码构建)。本仓库的 GitHub Actions 从同一版本标签构建 Linux 与两种 macOS 安装包，核验全部附件后推进新仓库的两个更新清单；Windows 安装包仍使用上游官方版本。

## 产品说明书

### 1. 添加服务器

第一次使用时，从“添加服务器”开始。填写 SSH 地址、端口和登录用户，按需要选择 SSH Agent、密钥或密码，并完成 Host Key 核验。RackTop 会通过 SSH 读取服务器资源，不需要在服务器安装额外服务。

![添加 SSH 服务器](docs/assets/readme/add-server.png)

### 2. 查看服务器与 GPU 状态

总览页按服务器展示 GPU 数量、GPU 显存、系统内存和在线状态。进入服务器后，可以查看每张 GPU 的利用率、显存、温度、当前进程和 CPU 状态；点击卡片可以继续查看细节。

![服务器概览](docs/assets/readme/overview.png)

![全局算力总览](docs/assets/readme/fleet-overview.png)

### 3. 使用远程终端

需要临时检查环境时，打开对应服务器的远程终端。终端复用已配置的 SSH 连接，适合执行检查命令、确认目录、验证 Python 环境或排查任务启动问题。

![远程终端](docs/assets/readme/terminal.png)

### 4. 发现空闲算力

在“空闲算力”中按 GPU 使用情况、可用显存和是否有进程占用筛选资源。点击启动按钮会进入启动任务，点击终端按钮只打开远程终端，不会改变任务配置。

![空闲算力筛选](docs/assets/readme/idle-compute.png)

### 5. 查看资源历史

资源历史以热力图展示近期 GPU 使用情况，时间坐标固定在左侧并随窗口自适应。它适合快速判断一台服务器什么时候繁忙、哪些 GPU 长时间空闲，以及任务运行是否出现异常波动。

![资源历史热力图](docs/assets/readme/history-heatmap.png)

### 6. 管理项目、数据集和模型

项目是长期管理的核心。为项目关联数据集和模型后，RackTop 会检查它们在目标服务器上的路径和副本状态；需要在另一台服务器运行时，可以从同步弹窗查看缺失项并执行同步或补齐。一个数据集或模型可以被多个项目关联。

![项目、数据集和模型同步](docs/assets/readme/sync-dialog.png)

### 7. 创建启动任务

启动配置按项目保存。同一套超参数可以针对不同服务器切换工作目录、GPU 卡号和运行命令；粘贴已有命令时，RackTop 会识别其中的 `cd`、`CUDA_VISIBLE_DEVICES` 和项目日志路径，并在启动前生成预览。未提供项目日志路径时，RackTop 使用自己的受管日志路径，便于在任务页统一查看日志。

![启动任务](docs/assets/readme/launch-task.png)

启动后可以在“我的进程”中查看任务状态、日志和资源占用，并安全结束任务或外部进程。
