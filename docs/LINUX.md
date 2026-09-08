# Linux 客户端（实验版）

此社区 fork 最初基于上游 RackTop v1.25.4，提供 Ubuntu 22.04 x86_64 的原生 Linux 桌面构建。本次 Linux 测试版为 `1.26.0-linux.9`，发布正在准备中，标签构建通过后可下载；以对应 Release 的实际附件为准。这是由 [AIsMovDataInfra/RackTop](https://github.com/AIsMovDataInfra/RackTop) 分发的社区移植版本，不是上游官方 Linux Release。原作者为 Tongzh-SEU，许可证为 GPL-3.0。

## 安装与启动

从 [Linux Release](https://github.com/AIsMovDataInfra/RackTop/releases) 下载 `.deb` 后，在其所在目录执行（将文件名替换为实际下载的文件名）：

```bash
sudo apt install ./RackTop_1.26.0-linux.9_amd64.deb
racktop
```

也可从桌面应用菜单启动 RackTop。安装需要图形桌面以及 WebKitGTK 4.1；Linux 服务器端仍通过原有 OpenSSH 工作流管理。此包仅面向 amd64，不适用于 ARM。

## 本机集成

- Linux 使用系统窗口标题栏，支持窗口管理器提供的移动、缩放、最小化和关闭。
- 服务器密码通过 Secret Service 存入系统钥匙串。Ubuntu GNOME 通常由 GNOME Keyring 提供此服务；其他桌面需配置兼容服务。服务不可用或钥匙串未解锁时，保存密码可能报错；可使用 SSH Agent/密钥或仅会话密码。
- 外部 SSH 快速配置终端沿用 `x-terminal-emulator`。Ubuntu 上需安装一个提供此命令的终端程序；应用内 SSH 终端由原有 PTY 实现提供。
- 托盘可见性取决于桌面的 AppIndicator 支持。窗口内仍可使用主要功能。
- 从 linux.4 起支持签名 Debian 包的一键更新。点击左上角 RackTop → 检查更新 → 更新到指定版本，下载和校验后由系统请求管理员授权，完成后重新启动。原作者主页和官方仓库入口继续保留。
- 应用数据通常位于 `${XDG_DATA_HOME:-$HOME/.local/share}/com.racktop.desktop`。卸载软件包不会自动删除用户数据。

## 一键更新与首次升级

linux.1～linux.3 的旧更新模块需要先手动安装一次 linux.4 或更新版本。安装后，侧栏与“关于”中显示完整版本号。新版在启动和每 24 小时检查更新，用户也可点击左上角手动检查；有新版本时选择“更新到 v…”。系统管理员密码由系统授权窗口输入，与服务器 SSH 密码无关。

安装包只从本 fork 的 Linux Release 下载，客户端在运行安装器前验证签名以及包名称、版本和架构，并拒绝降级。更新取消、网络或安装失败时可以重试，也可打开 Release 手动下载。系统安装依赖 `pkexec`、APT 和可用的桌面授权代理；需要管理权限。安装保留原有应用数据。

发布维护者需在 GitHub Actions Secret 中配置 `LINUX_UPDATER_PRIVATE_KEY`，与源码中的 `src-tauri/linux-updater.pub` 匹配。本仓库采用无密码保护、由 GitHub Secret 加密存储的专用发布密钥。不得把私钥放入源码、安装包或 Release 附件。自动流程先校验签名并运行下载集成测试，创建 Release 并核对 GitHub 附件摘要，最后更新独立 `updater` 分支的 `linux-amd64.json`。公钥更换会影响旧客户端的更新信任，不能随意轮换。首次发布的清单须在标签构建成功后才会存在。

签名工具与本地下载测试：

```bash
# TAURI_SIGNING_PRIVATE_KEY_PATH 指向受保护的私钥文件；不要将内容写进命令或日志。
python3 scripts/sign-linux-update.py src-tauri/target/release/bundle/deb/RackTop_1.26.0-linux.9_amd64.deb
cargo build --release --locked --features integration-probe --bin racktop-probe --manifest-path src-tauri/Cargo.toml
python3 scripts/test-linux-update.py src-tauri/target/release/racktop-probe src-tauri/target/release/bundle/deb/RackTop_1.26.0-linux.9_amd64.deb
```

## 分享 SSH 连接与失败重试

侧栏“导出 SSH Config”可预览、复制或保存全部服务器连接。桌面版保存至本机下载目录，并显示完整文件路径。接收者选择“导入 SSH Config”→“选择配置文件”，预览并选择需要的服务器后导入。仍保留读取本机 `~/.ssh/config` 的入口，重复连接自动跳过。

共享文件只包含名称、主机、端口、用户名和 ProxyJump；不包含密码、私钥内容、本机私钥路径、标签及历史数据。密码认证的接收者需编辑导入的服务器，选择密码并自行输入目标与跳板密码。别名跳板只有在导出列表中能解析时才展开为明确地址，否则提示先补齐地址。共享文件不能替代 VPN、跳板机网络权限或目标服务器账号。

连接失败后自动重试等待 30 分钟；后台历史同步也遵守这一等待时间，避免每 5 分钟绕过限制。手动刷新或重新启动应用可立即重连，成功连接后恢复正常采样频率。离线时仍保留最后一份快照供查看。

## 通过跳板机使用两组密码

Linux 1.26.0-linux.3 支持一台跳板机与一台目标服务器分别使用密码。两组密码可以不同，不需要预先建立本地隧道。

1. 添加或编辑**目标服务器**，填写目标机可从跳板机访问的地址、SSH 端口、用户名及目标机密码。
2. 在“跳板机 ProxyJump”填写 `jumpuser@jump.example.com:21022`，并勾选“跳板机使用独立密码”。
3. 填写“跳板机密码”。需要下次启动自动连接时，可选择“保存跳板机密码到系统安全存储”；否则仅在当前应用会话中保存。
4. 保存并连接。首次连接时分别核对跳板机与目标服务器的指纹；未知或变化的指纹不会自动获得信任。

跳板机必须允许 SSH TCP 转发，并能访问目标地址。独立密码模式支持显式的单跳 `用户名@主机[:端口]`（含 IPv6）；暂不支持多跳、SSH Config 别名、MFA/动态口令。目标机仍可使用密码或指定私钥。未启用独立密码时，原有 OpenSSH ProxyJump 配置继续生效。

编辑时密码留空会沿用仍可读取的原密码；更换跳板地址或账号后必须输入新密码。取消保存会移除系统安全存储中的跳板机密码，当前会话仍可使用。两个密码不会写入配置、SQLite 或交互日志。卸载应用不会删除配置；删除服务器或关闭独立跳板机密码会清理相应凭据。

## 两级密码本地验证

`cargo build --features integration-probe --bin racktop-probe --manifest-path src-tauri/Cargo.toml` 构建专用测试程序；此测试入口不包含在正常安装包中。

- 在独立 Python 环境安装 Paramiko 后，运行 `python scripts/test-password-jump.py /path/to/racktop-probe /tmp/racktop-ssh-test`。测试使用仅监听本机的模拟 SSH 服务、不同密码和专用 known_hosts，不访问公司服务器。
- 运行 `dbus-run-session -- python3 scripts/test-password-keyring.py /path/to/racktop-probe /tmp/racktop-keyring-test` 验证隔离 Secret Service 下的持久化、重启、取消保存和删除。需要 `gnome-keyring-daemon` 与 `gdbus`。

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

产物位于 `src-tauri/target/release/bundle/deb/`，并附 SHA-256 文件。Tauri 会自动合并 `src-tauri/tauri.linux.conf.json`。普通本地构建不需要私钥；发布流程另外为 `.deb` 签名，签名不使用上游密钥。

`.github/workflows/build.yml` 同时提供 Ubuntu 22.04 构建、测试和启动烟雾检查。推送已合并到 `main` 的 `v*-linux.*` 标签时自动构建、签名并发布 Linux；手动运行默认只构建 Linux，不推进更新通道。Windows/macOS 用户使用上游官方安装包。

## 验证范围

实际执行的检查及结果记录在 [版本信息](VERSION_INFOS.md) 的 Linux 版本条目：Ubuntu 22.04.5 x86_64 上已检查单元测试、生产构建、软件包完整性、动态库依赖、原生启动与 Secret Service 持久化；此前的 linux.1 包已完成系统安装，linux.2 的逐项结果以该版本记录为准。真实 GPU 服务器的 SSH、资源监控、任务启动和文件同步需要使用自己的测试服务器进一步验证；打包成功不能替代这些功能验证。尚未验证其他发行版、ARM、Wayland 与不同桌面环境的兼容性。

参考：[Tauri Linux 开发依赖](https://v2.tauri.app/start/prerequisites/#linux)、[Tauri Debian 打包](https://v2.tauri.app/distribute/debian/)、[keyring 3.6.3 后端说明](https://docs.rs/keyring/3.6.3/keyring/)。
