# Linux 客户端（实验版）

RackTop 2.0.0 由独立仓库 [AIsMovDataInfra/RackTop-Workspace](https://github.com/AIsMovDataInfra/RackTop-Workspace) 分发，面向 Ubuntu 22.04 x86_64 / amd64 图形桌面。Linux 与 Mac 使用相同版本号，安装包名区分平台。本轮构建和公开下载仍在验收，以 [v2.0.0 Release](https://github.com/AIsMovDataInfra/RackTop-Workspace/releases/tag/v2.0.0) 的实际附件为准。项目源自上游及旧 AIsMov 维护版，保留 Tongzh-SEU 原作者署名、完整历史及 GPL-3.0。

## 安装与启动

从 [Linux / Mac Release](https://github.com/AIsMovDataInfra/RackTop-Workspace/releases) 下载 `.deb` 后，在其所在目录执行（将文件名替换为实际下载的文件名）：

```bash
sudo apt install ./RackTop_2.0.0_linux-amd64.deb
racktop
```

也可从桌面应用菜单启动 RackTop。安装需要图形桌面以及 WebKitGTK 4.1；Linux 服务器端仍通过原有 OpenSSH 工作流管理。此包仅面向 amd64，不适用于 ARM。

## 本机集成

- Linux 使用系统窗口标题栏，支持窗口管理器提供的移动、缩放、最小化和关闭。
- 服务器密码通过 Secret Service 存入系统钥匙串。Ubuntu GNOME 通常由 GNOME Keyring 提供此服务；其他桌面需配置兼容服务。服务不可用或钥匙串未解锁时，保存密码可能报错；可使用 SSH Agent/密钥或仅会话密码。
- 外部 SSH 快速配置终端沿用 `x-terminal-emulator`。Ubuntu 上需安装一个提供此命令的终端程序；应用内 SSH 终端由原有 PTY 实现提供。
- 托盘可见性取决于桌面的 AppIndicator 支持。窗口内仍可使用主要功能。
- 当前新分发支持专用密钥签名的 Debian 包一键更新。点击左上角 RackTop → 检查更新 → 更新到指定版本，下载和校验后由系统请求管理员授权，完成后重新启动。原作者主页和官方仓库入口继续保留。
- 应用数据通常位于 `${XDG_DATA_HOME:-$HOME/.local/share}/com.racktop.desktop`。卸载软件包不会自动删除用户数据。

## 一键更新与首次升级

从旧 `1.30.0-linux.12` 或其他旧维护版迁入 **2.0.0**，必须先下载新仓库 Deb 并手动安装一次。旧仓库及旧更新清单保持原状，不会自动将旧客户端引导到新仓库。新版本保留 `com.racktop.desktop` 标识与数据目录，服务器、项目、密钥引用和本机历史继续使用原资料；更换安装前可先备份应用数据。

安装新分发后，启动和每 24 小时检查新仓库更新，也可点击左上角手动检查。选择“更新到 v…”后先下载、验证新仓库的专用签名、包名、版本和架构，再通过系统授权窗口安装；拒绝降级。安装取消、网络或授权失败可重试或手动下载。系统安装需要 `pkexec`、APT 和可用的桌面授权代理，系统管理员密码与服务器 SSH 密码无关。

维护者在**新仓库** GitHub Actions Secret 配置 `LINUX_UPDATER_PRIVATE_KEY`，与 `src-tauri/linux-updater.pub` 匹配；Mac 使用其专用更新密钥。不要复用旧仓库私钥或修改旧 feed，也不把密钥放入 Git、安装包或附件。统一发布流程确认 Linux / Mac 全部附件可下载且摘要一致后，才同时推进新仓库 `updater` 分支的 `linux-amd64.json` 和 `macos.json`；不能在包尚未就绪时先发清单。

签名工具与本地下载测试：

```bash
# TAURI_SIGNING_PRIVATE_KEY_PATH 指向受保护的私钥文件；不要将内容写进命令或日志。
python3 scripts/sign-linux-update.py src-tauri/target/release/bundle/deb/RackTop_2.0.0_linux-amd64.deb
cargo build --release --locked --features integration-probe --bin racktop-probe --manifest-path src-tauri/Cargo.toml
python3 scripts/test-linux-update.py src-tauri/target/release/racktop-probe src-tauri/target/release/bundle/deb/RackTop_2.0.0_linux-amd64.deb
```

## 分享 SSH 连接与失败重试

侧栏 **“SSH 配置”** 统一提供导入与导出。选择“导出配置”后勾选需要分享的服务器，预览只包含所选连接；可以全选或清空，空选择不能保存或复制。桌面版保存到本机下载目录并显示完整路径。接收者从“SSH 配置”→“导入配置”→“选择配置文件”预览并导入，仍可读取本机 `~/.ssh/config`，重复连接自动跳过。

共享文件只包含名称、主机、端口、用户名和 ProxyJump；不包含密码、私钥内容、本机私钥路径、标签及历史数据。密码认证的接收者需编辑导入的服务器，选择密码并自行输入目标与跳板密码。别名跳板从已知本机连接中解析为明确地址；未勾选跳板机不会单独导出 Host 块，但所选连接所需的 ProxyJump 地址仍会包含在配置中。无法解析时提示先补齐地址。共享文件不能替代 VPN、跳板机网络权限或目标服务器账号。

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

`.github/workflows/build.yml` 在推送与源码版本一致、已合并到新仓库 `main` 的 `vX.Y.Z` 标签后，同时构建 Linux 和 Mac 两架构，包含版本一致性、测试与原生启动检查。全部产物核验后统一发布。手动运行默认只构建 Linux，不推进更新通道。Windows 继续使用上游官方安装包。

## 团队工作台与通知

桌面侧栏的 **团队工作台** 位于「密钥管理」与「日志」之间，悬停或键盘焦点即可展开设备管理、周报与绩效、算力预约、设备申请与领取；点击主按钮打开网页首页。原「团队预约」页面继续提供本机资源同步，说明与打开网页按钮放在同一组。账号公司由服务端返回并只读显示。

单台服务器「配置 → 服务器通知」可选打开、部分或关闭。部分模式取消最后一类后自动关闭，每次选择立即保存；关闭后，采集中或等待系统通知授权的提醒也会再次核对开关。预约条件仍会正常更新，但该服务器不再弹出相应提醒。保存失败会回到最后成功保存的设置并提示，不把尚未保存的开关状态当作永久生效。

网页使用方法见[工作台指南](WORKSPACE.md)与[设备管理](EQUIPMENT.md)。本轮没有 SSH 云同步，线上只保存团队业务资料。

## 验证范围

2.0.0 当前已完成桌面 322 项、Linux Rust 160 项测试（3 项依赖外部环境的既有测试忽略）及桌面生产构建。网页 91 项及浏览器工作台流程已验证；双平台 CI、公开附件下载、签名与安装迁移仍在验收，结果待补；本轮不能沿用下面历史版本的成功记录代替验证。

### 历史 1.x 验证记录

`1.30.0-linux.12` 的 [标签构建与发布 34250392746](https://github.com/AIsMovDataInfra/RackTop/actions/runs/34250392746) 已完成：桌面 301、Rust 160、中继 27、文件协议 15、更新器 9 项及真实中继重连、15 秒隔离原生启动检查通过。5 个公开附件独立下载核对摘要，Deb 包与全部 389 个源码文件、Linux 更新签名通过；本机用户安装入口已更新，原有数据保留，重启后生效。账号与设备指南见 [团队账号](TEAM_ACCOUNTS.md) 与 [固定资产标签](EQUIPMENT.md)。

`1.29.0-linux.11` 的 [标签构建与发布 34199947421](https://github.com/AIsMovDataInfra/RackTop/actions/runs/34199947421) 已通过桌面测试、生产构建、Rust 测试、真实中继协议检查、Deb 签名、更新下载及隔离原生启动检查。设备网页同源浏览器流程已验收，真实用户桌面打开系统浏览器及实际更新安装仍需单独验证。

实际执行的检查及结果记录在 [版本信息](VERSION_INFOS.md) 的 Linux 版本条目：Ubuntu 22.04.5 x86_64 上已检查单元测试、生产构建、软件包完整性、动态库依赖、原生启动与 Secret Service 持久化；此前的 linux.1 包已完成系统安装，linux.2 的逐项结果以该版本记录为准。真实 GPU 服务器的 SSH、资源监控、任务启动和文件同步需要使用自己的测试服务器进一步验证；打包成功不能替代这些功能验证。尚未验证其他发行版、ARM、Wayland 与不同桌面环境的兼容性。

参考：[Tauri Linux 开发依赖](https://v2.tauri.app/start/prerequisites/#linux)、[Tauri Debian 打包](https://v2.tauri.app/distribute/debian/)、[keyring 3.6.3 后端说明](https://docs.rs/keyring/3.6.3/keyring/)。
