# RackTop

把服务器监控、远程终端和团队协作放在一个工作台里。

**[下载安装](https://136.0.110.161/downloads/)** · **[打开团队工作台](https://136.0.110.161/)** · **[使用帮助](docs/WORKSPACE.md)** · [English](README_EN.md)

## 安装

**当前桌面安装包：2.8.3 测试版（Pre-release）。** Ubuntu 20.04 / 22.04 推荐在终端运行统一安装命令；Mac 打开下载页，按芯片选择 DMG。无需下载源码或配置开发环境。管理员可在网页分配现有 SSH 登录密码；成员在桌面登录团队账号后即可使用获授权的服务器。

SSH 连接和文件传输继续通过成员本机网络直连目标服务器。2.7.3 的客户端加固减少密码意外暴露，但不能阻止获授权成员主动取得密码。

```bash
curl --proto '=https' --proto-redir '=https' -fL https://136.0.110.161/downloads/install-racktop.sh -o install-racktop.sh && bash install-racktop.sh
```

使用普通用户运行，不要在整条命令前加 `sudo`。缺少 `curl` 或 `python3` 时，先运行 `sudo apt install curl python3`。

| 电脑 | 云端安装包 | GitHub 备用 |
| --- | --- | --- |
| Ubuntu 20.04，Intel / AMD 64 位 | [Flatpak 离线套件](https://136.0.110.161/downloads/RackTop_2.8.3_linux-amd64-flatpak-offline.tar.gz) | [下载](https://github.com/AIsMovDataInfra/RackTop-Workspace/releases/download/v2.8.3/RackTop_2.8.3_linux-amd64-flatpak-offline.tar.gz) |
| Ubuntu 22.04，Intel / AMD 64 位 | [DEB 安装包](https://136.0.110.161/downloads/RackTop_2.8.3_linux-amd64.deb) | [下载](https://github.com/AIsMovDataInfra/RackTop-Workspace/releases/download/v2.8.3/RackTop_2.8.3_linux-amd64.deb) |
| Mac，M 系列芯片 | [Apple Silicon DMG](https://136.0.110.161/downloads/RackTop_2.8.3_macos-arm64-unsigned.dmg) | [下载](https://github.com/AIsMovDataInfra/RackTop-Workspace/releases/download/v2.8.3/RackTop_2.8.3_macos-arm64-unsigned.dmg) |
| Mac，Intel 芯片 | [Intel DMG](https://136.0.110.161/downloads/RackTop_2.8.3_macos-x64-unsigned.dmg) | [下载](https://github.com/AIsMovDataInfra/RackTop-Workspace/releases/download/v2.8.3/RackTop_2.8.3_macos-x64-unsigned.dmg) |

Mac 包使用 ad-hoc 签名，未经 Apple 公证；首次打开请按[Mac 指南](docs/MACOS.md)操作。

旧 2.2.2 Flatpak 先用统一安装器升级一次，再使用新版应用内更新；已有 Flatpak 会保留原用户级或系统级安装范围。[安装步骤、资料保留与升级说明](docs/DOWNLOADS.md)。

## 开始使用

**2.8.3 将“现在使用”和“预约未来时段”明确分开，并允许获授权的成员桌面上报 GPU 占用。** 团队连接继续按当前账号及组织筛选，超级管理员可查看本账号的跨组织连接；个人连接及历史资料保留。管理员完成组织服务器首次硬件绑定后，管理员或获授权成员运行 2.8.3 客户端并持续采集，即可约每 30 秒更新摘要；只开网页不会采集，观测达到 90 秒未更新时显示未知。[本轮更新范围](docs/Version_overview.md)。

- **管理服务器**：打开桌面 RackTop，添加 SSH 连接，查看 GPU / CPU、使用终端、同步项目和管理任务。
- **团队协作**：打开在线工作台，登录后选择当前组织，使用「资产设备管理」登记资产、打印扫码标签，通过「办公设备申请」提交需求，并预约算力。
- **团队 SSH**：管理员在网页维护服务器资源、填写现有 SSH 密码并授权；成员在桌面登录、选择组织后连接。未提供共享密码时仍可使用本机密码、私钥或 SSH Agent。[操作步骤](docs/WORKSPACE.md#统一管理-ssh-服务器)。
- **资源看板**：默认“现在使用”，所选 GPU 必须当前明确空闲且排期无冲突；忙碌、未知或过期时可改选至少一分钟后的未来时段。每卡当前占用与时段预约分别显示，“未预约”不等于空闲。没有可识别系统用户名时显示“匿名用户”，不把预约人当作使用人；预约不会自动停止任务。CPU 由管理员登记实际节点，人工确认后整机预约。
- **查看操作方法**：[Linux](docs/LINUX.md) · [Mac](docs/MACOS.md) · [资产设备管理](docs/EQUIPMENT.md) · [资源共享](docs/SHARING.md)。

升级前退出旧程序；同一种安装方式会继续使用原资料。DEB 与 Flatpak 的资料目录不同，切换格式前请先备份，详见安装说明。

## 帮助与维护

[反馈问题](https://github.com/AIsMovDataInfra/RackTop-Workspace/issues) · [更新记录](docs/Version_overview.md) · [源码与维护说明](docs/MAINTAINERS.md)

由 **AIsMov** 维护，源自 [Tongzh-SEU/RackTop](https://github.com/Tongzh-SEU/RackTop) 及[原维护仓库](https://github.com/AIsMovDataInfra/RackTop)。保留原作者、贡献者和完整历史，按 [GPL-3.0](LICENSE) 分发；详见 [NOTICE](NOTICE.md)。[历史安装包](https://github.com/AIsMovDataInfra/RackTop-Workspace/releases)继续保留，Windows 用户可使用[上游历史版本](https://github.com/Tongzh-SEU/RackTop/releases)。
