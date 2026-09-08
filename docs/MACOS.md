# macOS 安装与构建说明

RackTop 的 AIsMov 维护版计划从 **1.27.0** 提供 Apple Silicon 与 Intel 两种 macOS 安装包。代码沿用维护版的 SSH 连接、本机密钥管理、共享网关与邀请码、访客监控/终端/文件传输，以及在线团队预约功能；原作者为 [Tongzh-SEU](https://github.com/Tongzh-SEU/RackTop)，本 fork 保留 [GPL-3.0 许可证](../LICENSE) 与 [来源说明](../NOTICE.md)。

## 下载与系统要求

**发布状态：待发布。** 以下为计划上传地址，安装包和 `SHA256SUMS` 校验文件是否已可下载，以 [v1.27.0 Release](https://github.com/AIsMovDataInfra/RackTop/releases/tag/v1.27.0) 的实际附件为准。

| Mac 机型 | 安装包 |
| --- | --- |
| Apple Silicon（M1 / M2 / M3 / M4 等 M 系列） | [RackTop_1.27.0_macos-arm64-unsigned.dmg](https://github.com/AIsMovDataInfra/RackTop/releases/download/v1.27.0/RackTop_1.27.0_macos-arm64-unsigned.dmg) |
| Intel 处理器 | [RackTop_1.27.0_macos-x64-unsigned.dmg](https://github.com/AIsMovDataInfra/RackTop/releases/download/v1.27.0/RackTop_1.27.0_macos-x64-unsigned.dmg) |

在 Apple 菜单的「关于本机」查看芯片类型。两个安装包均为原生架构构建，选择与本机芯片对应的文件。项目配置的最低系统版本为 **macOS 11.0**；这表示构建目标，实际验证范围见文末。

## 安装与首次打开

1. 下载对应的 DMG；如需校验，同时下载同一 Release 的 `SHA256SUMS` 文件，在下载目录运行 `shasum -a 256 RackTop_1.27.0_macos-arm64-unsigned.dmg`。在 `SHA256SUMS` 中找到文件名完全匹配的那一行，确认其第一列摘要与命令输出一致。Intel 版替换为对应的 `x64` 文件名。
2. 打开 DMG，将 **RackTop** 拖入 **应用程序**。升级已有安装时，先退出 RackTop 再替换应用。
3. 从「应用程序」启动 RackTop。
4. 如果 macOS 提示无法验证开发者或无法检查恶意软件，确认下载来源后，打开「系统设置 → 隐私与安全性」，在本次被阻止的应用旁选择「仍要打开」，再确认「打开」。此入口通常需要先尝试打开一次才出现。操作依据 [Apple 的安全打开 App 说明](https://support.apple.com/zh-cn/102445)。

这一批文件名含 `-unsigned` 的安装包使用 **ad-hoc 本地代码签名**，没有 Apple Developer ID 签名，也未经过 Apple 公证。包内签名完整性校验通过不代表 Apple 已验证开发者身份，因此不能保证首次启动没有系统提示。若提示应用已损坏或包含恶意软件，应重新核对附件与校验值，不要将其当作普通开发者验证提示处理。

## 连接服务器、共享与预约

- **直接连接服务器**：在「添加服务器」填写 SSH 主机、端口和用户名，选择本机 SSH Agent、私钥或密码，并核对服务器 Host Key 指纹。已有私钥可通过「密钥管理」导入引用；Mac 需要能访问所选文件。保存密码使用本机系统钥匙串。
- **通过邀请码访问共享资源**：在共享访客入口连接网关并输入资源所有者提供的邀请码，使用获准的监控、终端和文件能力。共享依赖资源所有者的 RackTop 和电脑持续在线；Mac 客户端不需要复制所有者的私钥。
- **团队预约**：连接同一个在线预约服务，用用户名和密码注册或登录。无需安装 RackTop 也可以在浏览器查看排期和预约；管理员可在桌面端将选中的服务器 GPU 清单同步到中央目录。同步不上传 SSH 地址或私钥。预约属于排期协调，不会自动授予 SSH 权限，也不会强制占用 GPU。详细流程见 [团队预约使用说明](../team-web/README.md)。

## 更新

macOS 维护版的更新信息和「查看版本说明」入口使用 [AIsMovDataInfra/RackTop](https://github.com/AIsMovDataInfra/RackTop/releases)。内置更新按 `darwin-aarch64` / `darwin-x86_64` 选择对应包，并验证维护仓库的更新签名；更新清单发布后的实际安装情况仍需按下方验收。

Tauri 更新签名与 Apple Developer ID / 公证是两套机制。更新包具备 Tauri 签名，不代表其通过 Apple 公证。自动更新不可用时，退出应用后手动下载并安装本机架构对应的 DMG。应用数据与安装包分开存放，替换前可先在设置中导出配置备份。

## 从源码构建

需要 macOS 构建环境、Xcode 命令行工具、Node.js 22+、Rust stable 和本机 OpenSSH。构建在线预约服务时使用 Node.js 24+。在仓库根目录安装依赖，并安装所需 Rust 目标：

```bash
npm ci
rustup target add aarch64-apple-darwin x86_64-apple-darwin
```

构建 Apple Silicon 包：

```bash
RACKTOP_MACOS_TARGET=aarch64-apple-darwin RACKTOP_MARK_UNSIGNED=1 RACKTOP_REQUIRE_UPDATER=0 npm run bundle:macos
```

构建 Intel 包：

```bash
RACKTOP_MACOS_TARGET=x86_64-apple-darwin RACKTOP_MARK_UNSIGNED=1 RACKTOP_REQUIRE_UPDATER=0 npm run bundle:macos
```

构建脚本为 [scripts/package-macos.sh](../scripts/package-macos.sh)，产物默认位于 `src-tauri/target/<target>/release/bundle/`：`dmg/` 包含 DMG、本地校验文件和签名状态说明，`macos/` 包含应用。Release 统一提供 `SHA256SUMS`，不单独上传本地的 `.dmg.sha256` 或 `.signing.txt`。脚本会验证应用签名和 DMG 完整性。

上述命令通过 `RACKTOP_REQUIRE_UPDATER=0` 允许未配置更新私钥的本地环境只构建 DMG。脚本默认 `RACKTOP_REQUIRE_UPDATER=1`，发布构建必须配置更新私钥并生成更新归档及其 `.sig`。GitHub Actions 在两种架构的 macOS runner 上分别构建和验收。

不配置 Apple 签名身份时，脚本使用 ad-hoc 签名。开发者如需 Developer ID 签名和公证，须自行配置有效的签名身份及 Apple 公证凭据；公证流程成功后才能将产物描述为已公证。相关凭据应保存在本机钥匙串或 CI Secrets，不写入仓库。

## 验证范围

当前文档随 macOS 发布准备更新。**两种架构的最终 DMG 构建、安装、原生启动、钥匙串访问、真实 SSH/共享会话和自动更新，尚未在本文中记为通过。** Release 发布前需根据实际 CI 报告与设备测试结果补充记录；现有 Linux 验证不能替代 Mac 实机验证，macOS 11.0 的最低版本兼容性也需要单独确认。

已加入前端回归测试，检查原生 Mac 的版本说明链接指向维护仓库，并保证 Windows 与普通浏览器不被误判为原生 Mac。该测试仅覆盖更新入口选择，不能证明 DMG 可安装或 Gatekeeper 已放行。
