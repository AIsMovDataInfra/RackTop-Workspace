# macOS 安装与构建说明

RackTop 2.0.0 是 [AIsMovDataInfra/RackTop-Workspace](https://github.com/AIsMovDataInfra/RackTop-Workspace) 的独立分发，与 Linux 共用同一版本和 Release，分别提供 Apple Silicon 与 Intel 原生安装包。桌面名称仍为 RackTop，保留 SSH、本机密钥管理、共享网关及团队工作台。项目沿用 Tongzh-SEU 原作和旧 AIsMov 维护版的历史、[GPL-3.0](../LICENSE)及[来源说明](../NOTICE.md)。

## 下载与系统要求

**发布状态：2.0.0 正在构建与验收。** 目标为两种 DMG、对应更新归档，并与 Linux 共享源码、许可证、NOTICE 及 `SHA256SUMS`；是否就绪以 [v2.0.0 Release](https://github.com/AIsMovDataInfra/RackTop-Workspace/releases/tag/v2.0.0) 实际附件为准。

| Mac 机型 | 安装包 |
| --- | --- |
| Apple Silicon（M1 / M2 / M3 / M4 等 M 系列） | [RackTop_2.0.0_macos-arm64-unsigned.dmg](https://github.com/AIsMovDataInfra/RackTop-Workspace/releases/download/v2.0.0/RackTop_2.0.0_macos-arm64-unsigned.dmg) |
| Intel 处理器 | [RackTop_2.0.0_macos-x64-unsigned.dmg](https://github.com/AIsMovDataInfra/RackTop-Workspace/releases/download/v2.0.0/RackTop_2.0.0_macos-x64-unsigned.dmg) |

在 Apple 菜单的「关于本机」查看芯片类型。两个安装包均为原生架构构建，选择与本机芯片对应的文件。项目配置的最低系统版本为 **macOS 11.0**；这表示构建目标，实际验证范围见文末。

## 安装与首次打开

1. 下载对应的 DMG；如需校验，同时下载同一 Release 的 `SHA256SUMS` 文件，在下载目录运行 `shasum -a 256 RackTop_2.0.0_macos-arm64-unsigned.dmg`。在 `SHA256SUMS` 中找到文件名完全匹配的那一行，确认其第一列摘要与命令输出一致。Intel 版替换为对应的 `x64` 文件名。
2. 打开 DMG，将 **RackTop** 拖入 **应用程序**。升级已有安装时，先退出 RackTop 再替换应用。
3. 从「应用程序」启动 RackTop。
4. 如果 macOS 提示无法验证开发者或无法检查恶意软件，确认下载来源后，打开「系统设置 → 隐私与安全性」，在本次被阻止的应用旁选择「仍要打开」，再确认「打开」。此入口通常需要先尝试打开一次才出现。操作依据 [Apple 的安全打开 App 说明](https://support.apple.com/zh-cn/102445)。

这一批文件名含 `-unsigned` 的安装包使用 **ad-hoc 本地代码签名**，没有 Apple Developer ID 签名，也未经过 Apple 公证。包内签名完整性校验通过不代表 Apple 已验证开发者身份，因此不能保证首次启动没有系统提示。若提示应用已损坏或包含恶意软件，应重新核对附件与校验值，不要将其当作普通开发者验证提示处理。

## 连接服务器、共享与预约

- **直接连接服务器**：在「添加服务器」填写 SSH 主机、端口和用户名，选择本机 SSH Agent、私钥或密码，并核对服务器 Host Key 指纹。已有私钥可通过「密钥管理」导入引用；Mac 需要能访问所选文件。保存密码使用本机系统钥匙串。
- **通过邀请码访问共享资源**：在共享访客入口连接网关并输入资源所有者提供的邀请码，使用获准的监控、终端和文件能力。共享依赖资源所有者的 RackTop 和电脑持续在线；Mac 客户端不需要复制所有者的私钥。
- **团队预约**：连接同一个在线预约服务，用成员名称和密码注册或登录；普通成员需由超级管理员分配公司后使用。无需安装 RackTop 也可以在浏览器查看排期和预约；管理员可在桌面端将选中的服务器 GPU 清单同步到中央目录。同步不上传 SSH 地址或私钥。预约属于排期协调，不会自动授予 SSH 权限，也不会强制占用 GPU。详细流程见 [团队预约使用说明](../team-web/README.md)。

## 更新

首次从旧维护版迁入 2.0.0，请退出 RackTop 后用新仓库对应架构的 DMG 替换应用。旧仓库与旧更新清单不变；新分发使用专用更新签名与 [RackTop-Workspace Releases](https://github.com/AIsMovDataInfra/RackTop-Workspace/releases)，保留原应用标识和用户数据兼容。新版本通过新仓库 `updater/macos.json` 的 `darwin-aarch64` / `darwin-x86_64` 选择包并验证签名；首次迁移与后续自动更新的实际安装验收仍待补。

Tauri 更新签名与 Apple Developer ID / 公证是两套机制。更新包具备 Tauri 签名，不代表其通过 Apple 公证。自动更新不可用时，退出应用后手动下载并安装本机架构对应的 DMG。应用数据与安装包分开存放，替换前可先在设置中导出配置备份。

## 从源码构建

需要 macOS 构建环境、Xcode 命令行工具、Node.js 22+、Rust stable 和本机 OpenSSH。构建在线预约服务时使用 Node.js 24+。在仓库根目录安装依赖，并安装所需 Rust 目标：

```bash
npm ci
rustup target add aarch64-apple-darwin x86_64-apple-darwin
```

构建 Apple Silicon 包：

```bash
RACKTOP_MACOS_TARGET=aarch64-apple-darwin RACKTOP_REQUIRE_UPDATER=0 npm run bundle:macos
```

构建 Intel 包：

```bash
RACKTOP_MACOS_TARGET=x86_64-apple-darwin RACKTOP_REQUIRE_UPDATER=0 npm run bundle:macos
```

构建脚本为 [scripts/package-macos.sh](../scripts/package-macos.sh)，产物默认位于 `src-tauri/target/<target>/release/bundle/`：`dmg/` 包含 DMG、本地校验文件和签名状态说明，`macos/` 包含应用。Release 统一提供 `SHA256SUMS`，不单独上传本地的 `.dmg.sha256` 或 `.signing.txt`。脚本会验证应用签名和 DMG 完整性。

上述命令通过 `RACKTOP_REQUIRE_UPDATER=0` 允许未配置更新私钥的本地环境只构建 DMG。脚本默认 `RACKTOP_REQUIRE_UPDATER=1`，发布构建必须配置更新私钥并生成更新归档及其 `.sig`。GitHub Actions 在两种架构的 macOS runner 上分别构建和验收。

不配置 Apple 签名身份时，脚本使用 ad-hoc 签名。开发者如需 Developer ID 签名和公证，须自行配置有效的签名身份及 Apple 公证凭据；公证流程成功后才能将产物描述为已公证。相关凭据应保存在本机钥匙串或 CI Secrets，不写入仓库。

## 团队工作台

「密钥管理」与「日志」之间的 **团队工作台** 可以悬停、键盘焦点或点击展开，包含设备管理、周报与绩效、算力预约和设备申请与领取，主按钮打开在线首页。原「团队预约」桌面页面继续同步本机资源。网页用一个名称和密码注册，超管分配公司后使用本公司业务；设备照片缩略图、资产标签和账号头像都在网页中管理。详见[工作台指南](WORKSPACE.md)、[账号管理](TEAM_ACCOUNTS.md)和[设备管理](EQUIPMENT.md)。

SSH 导入与导出合并到 **SSH 配置**，导出可勾选特定连接，不包含密码、私钥或本机私钥路径。GPU 通知选择关闭后立即抑制后续派发，设置保存到本机；通知与团队业务数据的具体边界见 [Linux 指南](LINUX.md#团队工作台与通知)。

## 验证范围

2.0.0 的共享桌面前端目前 322 项测试和生产构建通过；Linux Rust 160 项通过不代替 Mac Rust 与原生验证。Mac 双架构 CI、附件、签名、原生启动及新签名迁移仍在验收，尚不声明 Mac 发布或用户设备完整操作已完成。

### 历史 1.x 验证记录

1.30.0 的 [标签双架构工作流 34250130373](https://github.com/AIsMovDataInfra/RackTop/actions/runs/34250130373) 构建与发布成功：每种架构前端 301 项、Rust 156 项通过（3 项既有外部环境测试忽略），DMG 挂载、代码签名、DMG 与更新包一致性、更新签名及隔离原生启动 8 秒均通过。8 个公开附件匿名下载后与 GitHub 摘要及 SHA256SUMS 一致，源码 389 文件逐项匹配标签，两种公开更新签名在本机复验通过。已查看两张原生窗口截图，版本为 1.30.0，团队预约、资源共享和设备管理入口完整；未将 CI 启动检查描述为真实用户完整操作。

1.29.0 的 [标签双架构工作流 34199717924](https://github.com/AIsMovDataInfra/RackTop/actions/runs/34199717924) 已通过：两架构前端/Rust 检查、DMG 与更新包一致性、代码签名、更新签名、隔离原生启动及最终发布均成功。安装包采用 ad-hoc 签名、未经 Apple 公证。设备网页的浏览器操作已验证；真实 Mac 用户的首次安装、系统浏览器打开和自动更新仍需单独验收。

以下保留首批 1.27.0 的平台验证记录。

GitHub Actions [v1.27.0 标签双架构构建 34180973823](https://github.com/AIsMovDataInfra/RackTop/actions/runs/34180973823) 已在 Apple Silicon **macOS 14.8.9** 与 Intel **macOS 15.7.9** 完成验证：

- 每种架构前端 292 项测试、TypeScript 和 Vite 构建通过。
- 每种架构 Rust 152 项通过、3 项需外部环境的集成测试默认忽略。
- 实际挂载 DMG，检查原生架构、版本、许可证、应用代码签名和 Tauri 更新签名。
- 对比 DMG 与更新归档内全部应用文件、权限及符号链接，内容一致。
- 在隔离用户目录中启动应用，持续运行至少 8 秒并完成独立数据库初始化；保存并检查了原生窗口截图。

[发布任务 34182220265](https://github.com/AIsMovDataInfra/RackTop/actions/runs/34182220265) 复用标签构建产物，重新验证两种更新签名与 GitHub 附件摘要后，已发布独立 Mac 更新清单；Linux 更新清单保持 `1.26.0-linux.9`。

这些是 CI 中的原生启动与包完整性验证。真实用户设备的钥匙串授权、SSH/共享会话、自动更新替换、Gatekeeper 首次放行和 macOS 11 最低版本兼容性仍需单独验收；未声称已经通过。签名发布后的附件以对应 Release 和标签工作流为准。

## 历史发布任务恢复（旧 1.x 仓库）

以下说明仅针对旧仓库的 Mac 专项发布。当前 2.0.0 分发必须依照统一工作流收齐 Linux 与两种 Mac 产物，核验同一 Release 后再同时推进新仓库的两个 feed；不要用旧恢复工作流改动旧清单或单独提前推进 Mac。

Mac 构建及原生检查已成功、但发布任务因环境或网络失败时，可在主分支运行 `Recover verified Mac release publication` 工作流，填写已有版本标签和该标签的构建 Run ID。恢复流程核对来源工作流、标签提交和两种架构的成功状态，重新验证更新签名后发布既有安装包，不重建应用、不移动标签。签名校验使用提供 minisign 的 Ubuntu 24.04 环境；已经创建的 Release 不允许覆盖，需先核实既有附件及更新清单状态。
