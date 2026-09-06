# Linux 客户端（实验版）

此分支基于上游 RackTop v1.25.4，增加 Ubuntu 22.04 x86_64 的原生 Linux 桌面构建，版本为 `1.26.0-linux.1`。这是本地移植版本，不是上游官方 Linux Release。

## 安装与启动

下载 `.deb` 后，在其所在目录执行（将文件名替换为实际下载的文件名）：

```bash
sudo apt install ./RackTop_1.26.0-linux.1_amd64.deb
racktop
```

也可从桌面应用菜单启动 RackTop。安装需要图形桌面以及 WebKitGTK 4.1；Linux 服务器端仍通过原有 OpenSSH 工作流管理。此包仅面向 amd64，不适用于 ARM。

## 本机集成

- Linux 使用系统窗口标题栏，支持窗口管理器提供的移动、缩放、最小化和关闭。
- 服务器密码通过 Secret Service 存入系统钥匙串。Ubuntu GNOME 通常由 GNOME Keyring 提供此服务；其他桌面需配置兼容服务。服务不可用或钥匙串未解锁时，保存密码可能报错；可使用 SSH Agent/密钥或仅会话密码。
- 外部 SSH 快速配置终端沿用 `x-terminal-emulator`。Ubuntu 上需安装一个提供此命令的终端程序；应用内 SSH 终端由原有 PTY 实现提供。
- 托盘可见性取决于桌面的 AppIndicator 支持。窗口内仍可使用主要功能。
- 此 Linux 构建采用手动更新。上游 updater 清单目前只提供 macOS/Windows，Linux 检查更新时会明确提示手动安装新版。
- 应用数据通常位于 `${XDG_DATA_HOME:-$HOME/.local/share}/com.racktop.desktop`。卸载软件包不会自动删除用户数据。

## 从源码构建

在 Ubuntu 22.04 上安装开发依赖：

```bash
sudo apt update
sudo apt install build-essential pkg-config curl libwebkit2gtk-4.1-dev \
  libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev \
  libdbus-1-dev openssh-client
```

安装 Node.js 22 LTS 和 Rust stable，再从仓库根目录执行：

```bash
npm ci
npm run test
npm run build
cargo test --release --locked --lib --manifest-path src-tauri/Cargo.toml
npm run bundle:linux -- --locked
```

产物位于 `src-tauri/target/release/bundle/deb/`，并附 SHA-256 文件。Tauri 会自动合并 `src-tauri/tauri.linux.conf.json`。Linux 构建关闭 updater 签名产物，因此不需要上游签名私钥。

`.github/workflows/build.yml` 同时提供 Ubuntu 22.04 构建、测试和启动烟雾检查。推送或远程 CI 执行需另行获得相应仓库权限。

## 验证范围

实际执行的检查及结果记录在 `VERSION_INFOS.md` 的当前版本条目。真实 GPU 服务器的 SSH、资源监控、任务启动和文件同步需要使用自己的测试服务器进一步验证；打包成功不能替代这些功能验证。尚未验证其他发行版、ARM、Wayland 与不同桌面环境的兼容性。

参考：[Tauri Linux 开发依赖](https://v2.tauri.app/start/prerequisites/#linux)、[Tauri Debian 打包](https://v2.tauri.app/distribute/debian/)、[keyring 3.6.3 后端说明](https://docs.rs/keyring/3.6.3/keyring/)。
