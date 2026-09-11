# RackTop 下载与安装

按电脑系统选择下面一行即可。Ubuntu 20.04 使用 **2.2.2 开发兼容包**；Ubuntu 22.04、两种 Mac 使用 **2.2.1 测试版**。**2.4.0 是已上线的团队网页版本，尚无对应桌面安装包**，设备管理网页更新无需重新安装客户端。

可将 [云端下载页](https://136.0.110.161/downloads/) 或本页的 GitHub 地址直接转发给同事。云端下载页与四种安装包已上线，已完成匿名下载及摘要核验；2.2.1 也可使用表内 GitHub 备用链接。

| 电脑系统 | 云端下载 | 备用下载 |
| --- | --- | --- |
| **Ubuntu 20.04，x86_64 / amd64** | [2.2.2 Flatpak 简易安装包，约 472 MiB](https://136.0.110.161/downloads/RackTop_2.2.2_linux-amd64-flatpak-easy.tar.gz) | [纯文字安装步骤](https://136.0.110.161/downloads/Ubuntu20.04-install.txt) |
| Ubuntu 22.04，x86_64 / amd64 | [2.2.1 Linux DEB](https://136.0.110.161/downloads/RackTop_2.2.1_linux-amd64.deb) | [GitHub DEB](https://github.com/AIsMovDataInfra/RackTop-Workspace/releases/download/v2.2.1/RackTop_2.2.1_linux-amd64.deb) |
| Mac Apple Silicon（M 系列芯片） | [2.2.1 macOS arm64 DMG](https://136.0.110.161/downloads/RackTop_2.2.1_macos-arm64-unsigned.dmg) | [GitHub arm64 DMG](https://github.com/AIsMovDataInfra/RackTop-Workspace/releases/download/v2.2.1/RackTop_2.2.1_macos-arm64-unsigned.dmg) |
| Mac Intel | [2.2.1 macOS x64 DMG](https://136.0.110.161/downloads/RackTop_2.2.1_macos-x64-unsigned.dmg) | [GitHub x64 DMG](https://github.com/AIsMovDataInfra/RackTop-Workspace/releases/download/v2.2.1/RackTop_2.2.1_macos-x64-unsigned.dmg) |

## Ubuntu 20.04

1. 下载上面的 `RackTop_2.2.2_linux-amd64-flatpak-easy.tar.gz`。
2. 在文件管理器中右键压缩包，选择「提取到此处」。
3. 打开解压得到的 `RackTop_2.2.2_Ubuntu20.04` 文件夹，在空白处右键，选择「在终端打开」。
4. 复制并运行：

   ```bash
   /bin/bash install-racktop.sh
   ```

5. 安装成功后，从应用菜单打开 RackTop，或运行：

   ```bash
   /usr/bin/flatpak run com.racktop.desktop
   ```

首次安装保持联网；缺少 Flatpak 等系统组件时，脚本会通过 `sudo` 补齐并提示输入本机密码。**使用普通用户执行上述命令，不要在整个脚本前加 `sudo`。** 安装包面向 x86_64 图形桌面，包含应用及配套运行时；无需下载源码或安装 Cargo、WebKit 开发包。

2.2.2 是 Ubuntu 20.04 的开发兼容分发，使用独立 Flatpak 数据目录；原 DEB 版资料不会自动搬迁。依赖原因、数据位置和验证范围见 [Ubuntu 20.04 兼容说明](LINUX.md#ubuntu-2004-兼容包222-开发版)。

## Ubuntu 22.04

下载 `RackTop_2.2.1_linux-amd64.deb`，在文件所在目录打开终端并运行：

```bash
sudo apt install ./RackTop_2.2.1_linux-amd64.deb
racktop
```

也可从应用菜单启动。此包用于 x86_64 / amd64，不适用于 ARM 电脑；Ubuntu 20.04 请使用上面的兼容包。更多说明见 [Linux 指南](LINUX.md)。

2.2.1 的 CI 使用 Ubuntu 22.04 构建，并配置了原生启动检查。本轮下载整理复核了该标签的 CI 配置和 DEB 元数据，未重新执行系统安装；不据此扩大到其他 Ubuntu 版本。包声明依赖 WebKitGTK 4.1 运行库 `libwebkit2gtk-4.1-0`、GTK 3 等，由上述 `apt install` 安装；元数据未声明具体 WebKit 最低版本号或 Ubuntu 版本号。

## Mac

在「苹果菜单 → 关于本机」确认芯片：M 系列选择 **arm64**，Intel 选择 **x64**。下载对应 DMG，退出已运行的 RackTop，打开 DMG 并将 RackTop 拖到「应用程序」。

Mac 测试包采用 ad-hoc 签名，**未经 Apple 公证**。首次打开若提示无法验证开发者，在确认下载来源可靠且文件未被改动后，打开「系统设置 → 隐私与安全性」，点击「仍要打开」并确认。具体步骤见 [Apple 官方说明](https://support.apple.com/zh-cn/102445)。应用受单位管理时可能需要管理员处理；更多兼容信息见 [Mac 指南](MACOS.md#安装与首次打开)。

## 可选：核对下载文件

下载 [云端 SHA256SUMS](https://136.0.110.161/downloads/SHA256SUMS)，放到安装包所在文件夹。Linux 可运行：

```bash
sha256sum --check --ignore-missing SHA256SUMS
```

Mac 可运行 `shasum -a 256` 后接下载的 DMG 文件名，将输出与 `SHA256SUMS` 中该文件对应的值核对。使用 GitHub 备用下载时，也可从 [v2.2.1 Release](https://github.com/AIsMovDataInfra/RackTop-Workspace/releases/tag/v2.2.1) 获取同版校验清单。

## 源码、许可证与网页

2.2.2 对应的 [源码归档](https://136.0.110.161/downloads/RackTop_2.2.2_source.tar.gz) 与兼容包一起提供；2.2.1 源码和发布附件见 [v2.2.1 Release](https://github.com/AIsMovDataInfra/RackTop-Workspace/releases/tag/v2.2.1)。源码是供开发者查看、修改和构建的材料，普通安装使用上表文件。

项目保留原作者及来源，按 [GPL-3.0](../LICENSE) 分发，详见 [NOTICE](../NOTICE.md)。本次下载核验见 [云端分发记录](DOWNLOADS_VERIFICATION_2026_09_11.md)，历史版本见 [版本信息](VERSION_INFOS.md)。

[在线团队工作台](https://136.0.110.161) 与 [设备管理](https://136.0.110.161/equipment) 已更新到网页 2.4.0；沿用团队账号，普通成员由超级管理员分配公司后使用。
