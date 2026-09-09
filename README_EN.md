# RackTop · AIsMov Workspace

**AIsMov** maintains RackTop in the independent public repository [AIsMovDataInfra/RackTop-Workspace](https://github.com/AIsMovDataInfra/RackTop-Workspace). The desktop app remains **RackTop**; the online product is **AIsMov RackTop Team Workspace**. The project derives from [Tongzh-SEU/RackTop](https://github.com/Tongzh-SEU/RackTop) and the [previous AIsMov maintenance repository](https://github.com/AIsMovDataInfra/RackTop). **Tongzh-SEU** remains the original author, and the full Git history, attribution, [GPL-3.0 license](LICENSE) and [NOTICE](NOTICE.md) are preserved.

The current distribution is **2.0.0** for Ubuntu 22.04 amd64, macOS Apple Silicon and macOS Intel, sharing one version and Release. Build, publication and installation checks are still in progress; availability is determined by the actual [v2.0.0 assets](https://github.com/AIsMovDataInfra/RackTop-Workspace/releases/tag/v2.0.0), and verification is recorded in the [changelog](docs/VERSION_INFOS.md). The previous repository and its update feeds remain unchanged. Existing users must manually install a new package once; the application identity and local data stay compatible.

The [online workspace guide](docs/WORKSPACE.md) covers equipment photos and QR labels, compute reservations, private weekly work reports with designated reviewers and manual scores, and equipment requests readable only by the super administrator. New members register with one name and password, then receive a company assignment from the super administrator. Business access is restricted to that company, with stricter report/request permissions. Settings provide seven built-in avatars. Remembered web sessions last 360 days; desktop device tokens remain valid for 30 days.

The desktop **团队工作台** (Team Workspace) menu opens the four web modules. The existing **团队预约** (Team Reservations) page retains desktop GPU inventory synchronization. **SSH 配置** (SSH Configuration) combines import and selected-connection export, excluding passwords, private keys and local key paths. Cloud synchronization of SSH configurations is deferred; the online service stores team business records. GPU reservations do not lock hardware or stop training jobs. Node.js 24+ is required to run the team service locally; full new modules require account mode, not the default demo.

<div align="right">
  🌐 Language:
  <a href="./README.md"><kbd>简体中文</kbd></a>
  <kbd><strong>✔ English</strong></kbd>
</div>

<p align="center">
  <img src="docs/assets/readme/racktop-icon.png" alt="RackTop Logo" width="300" />
</p>

<h2 align="center">Multiple Servers, One Training Workspace</h2>

<p align="center">
  📊 Monitor compute resources, 🔄 sync projects, 🚀 launch jobs, and 📈 stay on top of every run.
</p>

<p align="center">
RackTop is a desktop workspace for individual researchers and small teams managing GPU servers. It brings compute status, remote terminals, project assets, and training jobs from multiple Linux servers into one place.
Find the right GPU before launching a job, monitor resources and processes while it runs, and keep projects, datasets, and models ready when switching between servers.
</p>

<p align="center">
  <a href="https://github.com/AIsMovDataInfra/RackTop-Workspace/releases"><img src="https://img.shields.io/github/v/release/AIsMovDataInfra/RackTop-Workspace?include_prereleases&style=flat-square&logo=github&label=release" alt="Release"></a>
  <a href="https://github.com/AIsMovDataInfra/RackTop-Workspace/stargazers"><img src="https://img.shields.io/github/stars/AIsMovDataInfra/RackTop-Workspace?style=flat-square&logo=github&label=stars" alt="GitHub Stars"></a>
  <img src="https://img.shields.io/badge/platform-Linux%20%7C%20macOS%20%7C%20Windows-1687b8?style=flat-square" alt="Platform">
  <a href="https://github.com/AIsMovDataInfra/RackTop-Workspace/releases"><img src="https://img.shields.io/github/downloads/AIsMovDataInfra/RackTop-Workspace/total?style=flat-square&logo=github&label=downloads" alt="Downloads"></a>
  <a href="https://github.com/AIsMovDataInfra/RackTop-Workspace/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-GPL--3.0-green?style=flat-square" alt="GPL-3.0 License"></a>
</p>

<p align="center">
  <img src="docs/assets/readme/fleet-overview.png" alt="Fleet-wide compute overview" width="33%">
  <img src="docs/assets/readme/history-heatmap.png" alt="Resource history heatmap" width="33%">
  <img src="docs/assets/readme/idle-compute.png" alt="Idle compute filtering" width="33%">
</p>

## Download

| Client platform | Publisher | Installer |
| --- | --- | --- |
| **Ubuntu 22.04 x86_64 / amd64** | **AIsMov 2.0.0 pre-release** | [Linux .deb](https://github.com/AIsMovDataInfra/RackTop-Workspace/releases/download/v2.0.0/RackTop_2.0.0_linux-amd64.deb) |
| macOS Apple Silicon (M series) | AIsMov 2.0.0 pre-release | [arm64 .dmg](https://github.com/AIsMovDataInfra/RackTop-Workspace/releases/download/v2.0.0/RackTop_2.0.0_macos-arm64-unsigned.dmg) |
| macOS Intel | AIsMov 2.0.0 pre-release | [x64 .dmg](https://github.com/AIsMovDataInfra/RackTop-Workspace/releases/download/v2.0.0/RackTop_2.0.0_macos-x64-unsigned.dmg) |
| Windows x64 | Tongzh-SEU historical official v1.25.4 | [Official installer](https://github.com/Tongzh-SEU/RackTop/releases/download/v1.25.4/RackTop_1.25.4_x64-setup.exe) |

These are the intended 2.0.0 download URLs and may remain unavailable until publication completes. Mac packages use ad-hoc signing and are not notarized by Apple; see the [first-launch guide](docs/MACOS.md#安装与首次打开). The `.app.tar.gz` files are updater assets; choose DMG for normal installation. Windows remains an upstream download.

Migration from the previous Linux `1.30.0-linux.12` or Mac distribution requires one manual installation because the new repository has dedicated signing keys and update feeds. The old feeds will not redirect to it. On Mac, quit RackTop and replace the app using the DMG for your processor. On Linux:

```bash
sudo apt install ./RackTop_2.0.0_linux-amd64.deb
racktop
```

Historical releases remain in the [previous repository](https://github.com/AIsMovDataInfra/RackTop/releases); their original links and full version records are preserved in [VERSION_INFOS.md](docs/VERSION_INFOS.md).

You can also launch RackTop from your application menu. A graphical desktop, WebKitGTK 4.1 and OpenSSH are required. The package is for amd64, not ARM. Password persistence uses a compatible Secret Service keyring, such as GNOME Keyring; you can instead use session-only passwords. Download `SHA256SUMS` alongside the package and run `sha256sum --check --ignore-missing SHA256SUMS` to check the files you downloaded.

For 2.0.0, desktop frontend tests (316), Linux Rust tests (160 passed, three external-environment tests ignored) and the production frontend build have passed. Release downloads, native installation and both-platform CI checks are still pending. Previous package and startup checks are kept as historical records in [the Linux guide](docs/LINUX.md); they do not establish that the new packages have passed those checks.

## Attribution and Feedback

RackTop was originally created by [Tongzh-SEU](https://github.com/Tongzh-SEU) to help researchers and small teams manage GPU servers from a single desktop workspace. We thank the original author and upstream contributors. **AIsMov** is responsible for ongoing maintenance, feature development, issue handling and Linux / macOS distribution of this project.

The AIsMov maintenance work adds Linux platform detection, native window integration, Secret Service support, Debian packaging, independent jump-host passwords, signed updates, SSH connection configuration sharing and local SSH key management. See [NOTICE](NOTICE.md) and the [changelog](docs/VERSION_INFOS.md). Send feature requests and issues for this maintained version to [RackTop-Workspace Issues](https://github.com/AIsMovDataInfra/RackTop-Workspace/issues). For the original project and official Windows/macOS releases, visit [upstream](https://github.com/Tongzh-SEU/RackTop).

## Key Features

- **Multi-server compute overview**: View GPU, CPU, system memory, temperature, utilization, and process status in one place, then quickly locate resources by server or GPU.
- **Idle compute discovery**: Filter available GPUs by VRAM, utilization, occupancy, and idle duration, then open a remote terminal or proceed directly to job launch.
- **Remote terminals**: Open server terminals over SSH for quick environment checks, file inspection, and pre-launch troubleshooting.
- **Project asset management**: Organize working directories by project and associate them with datasets and models. Check their status across servers, synchronize copies, and restore missing assets.
- **Launch profiles and job management**: Save project-level launch profiles and switch working directories, GPU IDs, shell commands, hyperparameters, and log paths across servers and GPUs before launching and monitoring jobs from one place.
- **Runtime status and history**: Inspect RackTop jobs and external processes, logs, resource monitoring, history heatmaps, and notifications for offline servers, high temperatures, idle resources, and process exits.
- **Secure connections**: Supports SSH Agent, keys, passwords, `~/.ssh/config`, ProxyJump, and host key fingerprint verification. Unknown hosts are never accepted automatically.
- **Local SSH key management**: Open **密钥管理** (Key Management) in the lower-left sidebar to discover keys, manually generate Ed25519 or RSA 4096 key pairs, import references, rename entries and copy public keys. Select the corresponding private key in server settings. Removing an entry preserves its files.

## Security and Data

- RackTop never accepts an unverified host key automatically, and a changed fingerprint blocks the connection.
- Passwords are never written to command lines, logs, or SQLite. They remain in session memory or the system keychain.
- RackTop connects through the local OpenSSH client. Remote history sampling and job/file management features may write files on the server; configure them as needed.
- Server, project, dataset, model, launch profile, and history data is stored in the local application data directory. Uninstalling the app usually does not remove this data automatically. To remove everything, first export or delete data from the app settings, then clear the application data directory according to your operating system.

## Developer Guide

RackTop is built with Tauri 2, React, TypeScript, Rust, and SQLite. Development requires Node.js 22+, the stable Rust toolchain, and the system OpenSSH client.

```bash
npm install
npm run dev
npm run tauri dev
```

Run the frontend build and Rust tests:

```bash
npm run build
cargo test --manifest-path src-tauri/Cargo.toml
```

Build a local package:

```bash
npm run tauri build
```

For Linux, install the [system development dependencies](docs/LINUX.md#从源码构建), then run `npm run bundle:linux -- --locked`. Packages are written to `src-tauri/target/release/bundle/deb/`. See the [macOS build guide](docs/MACOS.md#从源码构建) for both architectures and signing. GitHub Actions builds Linux and macOS packages separately; Windows users should use official upstream releases.

## Product Guide

### 1. Add a Server

Start by selecting **Add Server**. Enter the SSH address, port, and login user; choose SSH Agent, key, or password authentication as needed; and verify the host key. RackTop reads server resources over SSH, so no additional service needs to be installed on the server.

![Add an SSH server](docs/assets/readme/add-server.png)

### 2. View Server and GPU Status

The overview displays the GPU count, GPU memory, system memory, and online status for each server. Open a server to inspect utilization, memory, temperature, active processes, and CPU status for every GPU, then select a card for more details.

![Server overview](docs/assets/readme/overview.png)

![Fleet-wide compute overview](docs/assets/readme/fleet-overview.png)

### 3. Use the Remote Terminal

When you need to inspect an environment, open the remote terminal for the relevant server. It reuses the configured SSH connection and is suitable for running checks, confirming directories, validating Python environments, and troubleshooting launch issues.

![Remote terminal](docs/assets/readme/terminal.png)

### 4. Find Idle Compute Resources

In **Idle Compute**, filter resources by GPU utilization, available VRAM, process occupancy, and idle duration. Select the launch button to begin creating a job, or select the terminal button to open a remote terminal without changing the job configuration.

![Idle compute filtering](docs/assets/readme/idle-compute.png)

### 5. View Resource History

Resource History presents recent GPU usage as a heatmap, with the time axis fixed on the left and the layout adapting to the window size. Use it to see when a server is busy, identify GPUs that have remained idle, and spot unusual changes during a run.

![Resource history heatmap](docs/assets/readme/history-heatmap.png)

### 6. Manage Projects, Datasets, and Models

Projects are the core unit of long-term organization. After associating datasets and models with a project, RackTop checks their paths and replica status on the target server. When moving a job to another server, use the synchronization dialog to identify missing assets and synchronize or restore them. A dataset or model can be associated with multiple projects.

![Synchronize projects, datasets, and models](docs/assets/readme/sync-dialog.png)

### 7. Create and Launch a Job

Launch profiles are saved per project. The same hyperparameter configuration can use different working directories, GPU IDs, and commands on different servers. When you paste an existing command, RackTop recognizes `cd`, `CUDA_VISIBLE_DEVICES`, and project log paths, then generates a preview before launch. If no project log path is provided, RackTop uses its own managed log path so logs remain available from the Jobs view.

![Launch a job](docs/assets/readme/launch-task.png)

After launch, open **My Processes** to view job status, logs, and resource usage, or to safely stop a RackTop job or external process.
