# 安装 RackTop

**[统一下载页](https://136.0.110.161/downloads/)提供 2.7.3 测试版（Pre-release）。** 安装的是现成程序，无需源码、Rust、Cargo 或 WebKit 开发包。

## Ubuntu 一键安装

Ubuntu 20.04 / 22.04 的 Intel / AMD 64 位电脑，推荐在终端运行：

```bash
curl --proto '=https' --proto-redir '=https' -fL https://136.0.110.161/downloads/install-racktop.sh -o install-racktop.sh && bash install-racktop.sh
```

使用普通用户运行，**不要在整条命令前加 sudo**。缺少 `curl` 或 `python3` 时，先运行 `sudo apt install curl python3`。

- Ubuntu 20.04 初装使用包含应用与运行时的 Flatpak 套件；Ubuntu 22.04 初装使用 DEB。
- 已有 Flatpak 会沿用原用户级或系统级安装，复用现有运行时；两个范围都安装时会停止，请先确认要保留哪一个。
- 脚本下载并核验包摘要，安装系统组件时才提示管理员认证；已有更新版本或同版本不同构建会停止。

## 手动下载安装包

| 电脑 | 云端下载 | GitHub 备用 |
| --- | --- | --- |
| Ubuntu 20.04，Intel / AMD 64 位 | [Flatpak 离线套件](https://136.0.110.161/downloads/RackTop_2.7.3_linux-amd64-flatpak-offline.tar.gz) | [下载](https://github.com/AIsMovDataInfra/RackTop-Workspace/releases/download/v2.7.3/RackTop_2.7.3_linux-amd64-flatpak-offline.tar.gz) |
| Ubuntu 22.04，Intel / AMD 64 位 | [DEB 安装包](https://136.0.110.161/downloads/RackTop_2.7.3_linux-amd64.deb) | [下载](https://github.com/AIsMovDataInfra/RackTop-Workspace/releases/download/v2.7.3/RackTop_2.7.3_linux-amd64.deb) |
| Mac，M 系列芯片 | [Apple Silicon DMG](https://136.0.110.161/downloads/RackTop_2.7.3_macos-arm64-unsigned.dmg) | [下载](https://github.com/AIsMovDataInfra/RackTop-Workspace/releases/download/v2.7.3/RackTop_2.7.3_macos-arm64-unsigned.dmg) |
| Mac，Intel 芯片 | [Intel DMG](https://136.0.110.161/downloads/RackTop_2.7.3_macos-x64-unsigned.dmg) | [下载](https://github.com/AIsMovDataInfra/RackTop-Workspace/releases/download/v2.7.3/RackTop_2.7.3_macos-x64-unsigned.dmg) |

全部为同一 2.7.3 测试版；[GitHub Release](https://github.com/AIsMovDataInfra/RackTop-Workspace/releases/tag/v2.7.3)和[历史版本](https://github.com/AIsMovDataInfra/RackTop-Workspace/releases)继续保留。团队工作台可[直接在浏览器打开](https://136.0.110.161/)。

### Ubuntu 20.04 手动安装

首次手动安装，若没有 Flatpak，先运行：

```bash
sudo apt install flatpak
```

下载并解压 `RackTop_2.7.3_linux-amd64-flatpak-offline.tar.gz`，进入 **`RackTop_2.7.3_flatpak_offline`** 文件夹，在空白处右键选择“在终端打开”，运行：

```bash
bash install.sh
```

脚本校验套件后进行**用户级**安装，保留已有运行时。已有系统级 RackTop 请使用上方统一安装器，以沿用系统级范围。此新套件内的命令是 `install.sh`；旧 2.2.2 简易套件才使用 `install-racktop.sh`。

安装成功后从应用菜单打开 RackTop，或运行 `flatpak run com.racktop.desktop`。套件包含应用与图形运行时；首次补齐系统 Flatpak 组件仍需联网。[完整 Ubuntu 20.04 教程](https://136.0.110.161/downloads/Ubuntu20.04-install.txt) · [Linux 说明](LINUX.md)。

### Ubuntu 22.04 手动安装

退出旧程序，在下载目录运行：

```bash
sudo apt install ./RackTop_2.7.3_linux-amd64.deb
```

APT 会补齐运行组件。安装成功后从应用菜单打开 RackTop，或运行 `racktop`。已有 Flatpak 请用统一安装器继续原格式；Ubuntu 20.04 请使用兼容套件。

### Mac

在苹果菜单“关于本机”确认芯片。退出旧 RackTop，打开匹配的 DMG，把 RackTop 拖入“应用程序”，再从“应用程序”打开。

这两个 `-unsigned.dmg` 测试包采用 ad-hoc 本地代码签名，未经过 Apple 公证。若提示无法验证开发者，确认下载来源后先尝试打开一次，再到“系统设置 → 隐私与安全性”选择“仍要打开”。详见 [Apple 官方说明](https://support.apple.com/zh-cn/102445)及 [Mac 指南](MACOS.md#安装与首次打开)。

## 升级与资料

升级前退出 RackTop。同格式升级继续使用原资料；不要先在应用内删除服务器，也不要删除应用资料目录、SSH 密钥或系统钥匙串。

旧 2.2.2 Flatpak 先通过上方统一安装器升级到 2.7.3，无需卸载。此后应用内更新只下载已签名的 `.flatpak` 应用包，复用 GNOME 50 运行时，并保留原安装范围与数据。

DEB 默认资料在 `~/.local/share/com.racktop.desktop`，Flatpak 默认在 `~/.var/app/com.racktop.desktop/data/com.racktop.desktop`。两者不自动迁移；切换格式前先备份并核对服务器连接，团队账号和共享身份可能需要重新登录或绑定。不要让两个客户端同时读写同一数据库。

## 管理员分配的 SSH 密码

网页管理员在「服务器资源 → 编辑」填写服务器现有密码并保存，再分配成员权限。成员升级到 2.7.3 后登录团队账号、选择组织，连接时自动领取密码。网页保存密码不会修改远端服务器账号的密码；私钥继续在本机配置。

SSH 连接和文件传输继续通过成员本机网络直连目标服务器。2.7.3 的客户端加固减少密码意外暴露，但不能阻止获授权成员主动取得密码。

## 校验、源码与帮助

手动下载后可用同目录 [SHA256SUMS](https://136.0.110.161/downloads/SHA256SUMS) 核验摘要；[GitHub 校验清单](https://github.com/AIsMovDataInfra/RackTop-Workspace/releases/download/v2.7.3/SHA256SUMS)对应 Release 附件。校验失败时重新下载，不要跳过校验。

- 2.7.3 对应源码：[云端](https://136.0.110.161/downloads/RackTop_2.7.3_source.tar.gz) · [GitHub](https://github.com/AIsMovDataInfra/RackTop-Workspace/releases/download/v2.7.3/RackTop_2.7.3_source.tar.gz)。
- GPL-3.0 许可证：[云端](https://136.0.110.161/downloads/LICENSE) · [GitHub](https://github.com/AIsMovDataInfra/RackTop-Workspace/releases/download/v2.7.3/LICENSE)。
- 来源与署名：[云端 NOTICE](https://136.0.110.161/downloads/NOTICE.md) · [GitHub NOTICE](https://github.com/AIsMovDataInfra/RackTop-Workspace/releases/download/v2.7.3/NOTICE.md)。

下载失败可使用表格中的 GitHub 备用链接；找不到资料时先核对安装格式。连接问题见 [Linux 指南](LINUX.md)，其他问题可[反馈](https://github.com/AIsMovDataInfra/RackTop-Workspace/issues)。构建和发布流程见[维护者说明](MAINTAINERS.md)。
