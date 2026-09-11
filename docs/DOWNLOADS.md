# 安装 RackTop

**推荐从[统一下载页](https://136.0.110.161/downloads/)选择系统。** 安装的是现成程序，无需下载源码、Rust 或其他开发工具。

## Ubuntu 一键安装

**2.5.0 与下面的统一安装入口尚未发布。发布完成前，请使用本页下方的现有安装包。**

发布后，在终端运行：

```bash
curl --proto '=https' --proto-redir '=https' -fL https://136.0.110.161/downloads/install-racktop.sh -o install-racktop.sh && bash install-racktop.sh
```

使用普通用户运行，**不要在整条命令前加 sudo**。脚本会识别 Ubuntu 20.04 / 22.04 的 Intel / AMD 64 位电脑，下载并校验对应安装包；安装系统组件时才会提示管理员认证。

- Ubuntu 20.04 初装使用包含运行时的 Flatpak 套件。
- Ubuntu 22.04 初装使用 DEB；如果已有 Flatpak，继续更新原来的 Flatpak。
- 已有 Flatpak 保持原来的用户级或系统级安装，复用现有运行时。两个范围都装有 RackTop 时会停止，请先确认要保留哪一个。
- 已有更新版本或同版本不同构建时会停止，避免降级或覆盖其他构建。
- 安装失败会显示原因并停止，不会转为源码编译。

缺少 `curl` 或 `python3` 时，先运行 `sudo apt install curl python3`，再执行上面的安装命令。Mac 请使用下方 DMG。

## 当前可用安装包

| 电脑 | 下载 |
| --- | --- |
| Ubuntu 20.04，x86_64 / amd64 | [2.2.2 Flatpak 简易套件，约 472 MiB](https://136.0.110.161/downloads/RackTop_2.2.2_linux-amd64-flatpak-easy.tar.gz) |
| Ubuntu 22.04，x86_64 / amd64 | [2.2.1 DEB](https://136.0.110.161/downloads/RackTop_2.2.1_linux-amd64.deb) |
| Mac，Apple Silicon / M 系列芯片 | [2.2.1 arm64 DMG](https://136.0.110.161/downloads/RackTop_2.2.1_macos-arm64-unsigned.dmg) |
| Mac，Intel 芯片 | [2.2.1 x64 DMG](https://136.0.110.161/downloads/RackTop_2.2.1_macos-x64-unsigned.dmg) |

Ubuntu 20.04 的 2.2.2 是开发兼容包，其余为 2.2.1 测试版。GitHub 备用下载和历史版本见 [Releases](https://github.com/AIsMovDataInfra/RackTop-Workspace/releases)。在线工作台 2.4.0 可[直接打开](https://136.0.110.161/)，不需要升级桌面程序。

### Ubuntu 20.04 现有套件

下载并解压 `RackTop_2.2.2_linux-amd64-flatpak-easy.tar.gz`，进入解压后的文件夹，在空白处右键选择“在终端打开”，运行：

```bash
bash install-racktop.sh
```

首次安装保持联网，按提示补齐系统组件。安装成功后从应用菜单打开 RackTop，或运行 `flatpak run com.racktop.desktop`。[完整图形桌面与兼容说明](LINUX.md)。

### Ubuntu 22.04 现有 DEB

进入下载目录，在终端运行：

```bash
sudo apt install ./RackTop_2.2.1_linux-amd64.deb
```

安装成功后从应用菜单打开 RackTop，或运行 `racktop`。APT 会补齐运行组件；Ubuntu 20.04 请使用对应的 Flatpak 套件。

### Mac

在苹果菜单“关于本机”确认芯片。退出旧 RackTop，打开对应 DMG，把 RackTop 拖入“应用程序”，再从“应用程序”打开。

当前 Mac 包未经过 Apple 公证。若系统提示无法验证开发者，确认下载来源后尝试打开一次，再到“系统设置 → 隐私与安全性”选择“仍要打开”。详见 [Mac 首次打开说明](MACOS.md#安装与首次打开)及 [Apple 官方说明](https://support.apple.com/zh-cn/102445)。

## 升级与资料

升级前退出 RackTop。同格式升级继续使用原资料；不要先在应用内删除服务器，也不要删除应用资料目录、SSH 密钥或系统钥匙串。

DEB 默认资料在 `~/.local/share/com.racktop.desktop`，Flatpak 默认在 `~/.var/app/com.racktop.desktop/data/com.racktop.desktop`。两者不自动迁移；切换格式前先备份，随后核对服务器连接，团队账号和共享身份可能需要重新登录或绑定。不要让两个客户端同时读写同一数据库。

旧 2.2.2 Flatpak 可通过统一安装器更新到发布后的 2.5.0，不需要删除旧安装。完成这次引导后，新版应用内更新只下载已签名的 `.flatpak` 应用包，复用 GNOME 50 运行时并保留原安装范围。该功能需等待 2.5.0 发布与平台验证完成；旧 2.2.2 客户端仍需先完成一次引导。

## 遇到问题

- **下载失败**：检查网络，重新运行；现有安装包可使用 [GitHub 备用下载](https://github.com/AIsMovDataInfra/RackTop-Workspace/releases/tag/v2.2.1)。
- **摘要校验失败**：停止安装并重新下载，仍失败时[反馈问题](https://github.com/AIsMovDataInfra/RackTop-Workspace/issues)，不要跳过校验。
- **找不到资料**：先确认使用的是 DEB 还是 Flatpak，查看各自的资料目录，避免把另一种安装方式的空目录误认为资料丢失。
- **服务器无法连接**：核对 SSH 地址和登录方式；密码保存在系统钥匙串中，使用前需要解锁。更多说明见 [Linux 指南](LINUX.md)。

手动下载可用同目录的 [SHA256SUMS](https://136.0.110.161/downloads/SHA256SUMS) 校验。每个发布继续提供对应源码、[GPL-3.0](../LICENSE)和[来源说明](../NOTICE.md)。构建、部署和发布流程见[维护者说明](MAINTAINERS.md)。
