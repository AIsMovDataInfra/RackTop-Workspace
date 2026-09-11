# RackTop

Server monitoring, remote terminals, and team collaboration in one workspace.

**[Download and install](https://136.0.110.161/downloads/)** · **[Open the team workspace](https://136.0.110.161/)** · **[User guide](docs/WORKSPACE.md)** · [简体中文](README.md)

## Install

**Current version: 2.5.0 Pre-release.** For Ubuntu 20.04 / 22.04, run the unified installer below. On Mac, choose the DMG for your chip on the download page. No source build or development tools are required.

```bash
curl --proto '=https' --proto-redir '=https' -fL https://136.0.110.161/downloads/install-racktop.sh -o install-racktop.sh && bash install-racktop.sh
```

Run as your regular user; do not prefix the whole command with `sudo`. If `curl` or `python3` is missing, run `sudo apt install curl python3` first.

| Computer | Cloud download | GitHub mirror |
| --- | --- | --- |
| Ubuntu 20.04, Intel / AMD 64-bit | [Flatpak offline kit](https://136.0.110.161/downloads/RackTop_2.5.0_linux-amd64-flatpak-offline.tar.gz) | [Download](https://github.com/AIsMovDataInfra/RackTop-Workspace/releases/download/v2.5.0/RackTop_2.5.0_linux-amd64-flatpak-offline.tar.gz) |
| Ubuntu 22.04, Intel / AMD 64-bit | [DEB package](https://136.0.110.161/downloads/RackTop_2.5.0_linux-amd64.deb) | [Download](https://github.com/AIsMovDataInfra/RackTop-Workspace/releases/download/v2.5.0/RackTop_2.5.0_linux-amd64.deb) |
| Mac with an M-series chip | [Apple Silicon DMG](https://136.0.110.161/downloads/RackTop_2.5.0_macos-arm64-unsigned.dmg) | [Download](https://github.com/AIsMovDataInfra/RackTop-Workspace/releases/download/v2.5.0/RackTop_2.5.0_macos-arm64-unsigned.dmg) |
| Mac with an Intel processor | [Intel DMG](https://136.0.110.161/downloads/RackTop_2.5.0_macos-x64-unsigned.dmg) | [Download](https://github.com/AIsMovDataInfra/RackTop-Workspace/releases/download/v2.5.0/RackTop_2.5.0_macos-x64-unsigned.dmg) |

Flatpak 2.2.2 needs one upgrade through this installer before in-app updates become available. Existing Flatpak installations keep their user or system scope. See the [installation, data retention, and upgrade guide](docs/DOWNLOADS.md) (Chinese).

## Get started

- **Manage servers:** Open the desktop app, add an SSH connection, inspect GPU / CPU activity, use terminals, synchronize projects, and manage jobs.
- **Work with your team:** Sign in to the online workspace, select your current organization, manage equipment and QR labels, reserve compute resources, and write weekly reports.
- **Team SSH:** Admins maintain the online directory and grant access. Members sign in on desktop, select an organization, receive connection metadata, and configure authentication locally. [Instructions](docs/WORKSPACE.md#统一管理-ssh-服务器) (Chinese).
- **Find instructions:** [Linux](docs/LINUX.md) · [Mac](docs/MACOS.md) · [Equipment](docs/EQUIPMENT.md) · [Resource sharing](docs/SHARING.md).

Quit the old app before upgrading. Upgrades using the same installation format retain existing data. DEB and Flatpak use different data directories; back up before changing formats.

## Help and maintenance

[Report a problem](https://github.com/AIsMovDataInfra/RackTop-Workspace/issues) · [What's new](docs/Version_overview.md) · [Source and maintainer guide](docs/MAINTAINERS.md)

Maintained by **AIsMov**, based on [Tongzh-SEU/RackTop](https://github.com/Tongzh-SEU/RackTop) and the [previous maintenance repository](https://github.com/AIsMovDataInfra/RackTop). Original authors, contributors, and history are preserved. Distributed under [GPL-3.0](LICENSE); see [NOTICE](NOTICE.md). [Historical installers](https://github.com/AIsMovDataInfra/RackTop-Workspace/releases) remain available. Windows users can use the [upstream historical releases](https://github.com/Tongzh-SEU/RackTop/releases).
