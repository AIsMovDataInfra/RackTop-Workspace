# Linux 客户端（实验版）

**版本范围：本文说明 2.8.0 待交付源码。2.8.0 尚未发布安装包、部署上线或完成正式验收；当前公开下载仍为 2.7.3 测试版（Pre-release）。以下新功能须在相应桌面与网页交付后使用，历史验收不代表本轮结果。**

RackTop 当前分发为 **2.7.3 测试版（Pre-release）**，面向 Ubuntu 20.04 / 22.04 的 Intel / AMD 64 位图形桌面。推荐从[统一下载页](https://136.0.110.161/downloads/)安装，也可使用 [v2.7.3 GitHub Release](https://github.com/AIsMovDataInfra/RackTop-Workspace/releases/tag/v2.7.3)。Linux 与 Mac Apple Silicon、Intel 共用版本、标签和 Release；项目保留 Tongzh-SEU 原作者署名、完整历史及 GPL-3.0。

## 安装与启动

Ubuntu 20.04 / 22.04 推荐用普通用户在终端运行统一安装器；不要在整条命令前加 `sudo`：

```bash
curl --proto '=https' --proto-redir '=https' -fL https://136.0.110.161/downloads/install-racktop.sh -o install-racktop.sh && bash install-racktop.sh
```

缺少 `curl` 或 `python3` 时，先运行 `sudo apt install curl python3`。安装器核验下载包；Ubuntu 20.04 初装选择含运行时的 Flatpak 套件，22.04 初装选择 DEB；已有 Flatpak 沿用原用户级或系统级范围。补齐系统组件时才提示管理员认证，无需源码、Cargo 或 WebKit 开发包。

Ubuntu 22.04 手动安装可下载 [2.7.3 DEB 云端包](https://136.0.110.161/downloads/RackTop_2.7.3_linux-amd64.deb)或 [GitHub 备用包](https://github.com/AIsMovDataInfra/RackTop-Workspace/releases/download/v2.7.3/RackTop_2.7.3_linux-amd64.deb)，退出旧程序，在下载目录执行：

```bash
sudo apt install ./RackTop_2.7.3_linux-amd64.deb
racktop
```

也可从应用菜单启动。DEB 需要图形桌面及 WebKitGTK 4.1 运行组件，APT 会补齐依赖；只面向 amd64，不适用于 ARM。已有 Flatpak 请使用统一入口继续原格式。源码、许可证、NOTICE 和 SHA256SUMS 链接见[下载说明](DOWNLOADS.md)。

## Ubuntu 20.04 兼容包

Ubuntu 20.04 桌面请使用 Flatpak，不能直接安装面向 22.04 的 `.deb`：Tauri 2 使用 WebKitGTK 4.1，而 20.04 标准软件源提供的是 WebKitGTK 4.0；此前 2.2.2 兼容诊断还确认，22.04 构建的 RackTop 要求 `GLIBC_2.34`，高于 20.04 的 glibc 2.31。不能通过强制安装、改包依赖、为 4.0 建立 4.1 软链接或混入 22.04 软件源解决。这里说的是运行客户端的桌面系统；被 SSH 管理的服务器不需要安装 WebKitGTK。

当前 2.7.3 的 Flatpak 包沿用 GNOME 50 运行时提供 glibc、GTK 和 WebKitGTK 4.1，源码仍为 Tauri 2；Ubuntu 22.04 的 DEB 通道继续保留。兼容包与运行时均为 x86_64，需要图形桌面和 Flatpak。首次安装使用包含运行时的完整套件。

兼容方案首次在 2.2.2 开发版中实现；技术诊断、当时的真实实测与限制保留在 [2.2.2 历史验证记录](VERIFICATION_2_2_2.md)。该记录只证明旧版当时的结果，不代表 2.7.3 或待交付 2.8.0 的平台、升级验收。

此前在 Ubuntu 20.04 的 Flatpak 1.6.5 上实测可运行 GNOME 50，但在线读取 Flathub 索引遇到 10 MiB 大小上限。因此首次安装使用含运行时的 [2.7.3 离线套件](https://136.0.110.161/downloads/RackTop_2.7.3_linux-amd64-flatpak-offline.tar.gz)（[GitHub 备用](https://github.com/AIsMovDataInfra/RackTop-Workspace/releases/download/v2.7.3/RackTop_2.7.3_linux-amd64-flatpak-offline.tar.gz)），不依赖在线解析运行时。以下手动步骤进行用户级安装；已有系统级 RackTop 应使用上方统一安装器：

```bash
sudo apt update
sudo apt install flatpak xdg-desktop-portal xdg-desktop-portal-gtk
tar -xzf RackTop_2.7.3_linux-amd64-flatpak-offline.tar.gz
cd RackTop_2.7.3_flatpak_offline
bash install.sh
flatpak run com.racktop.desktop
```

新套件进入 `RackTop_2.7.3_flatpak_offline` 后运行 `bash install.sh`；旧 2.2.2 简易套件内才使用 `install-racktop.sh`。运行套件内脚本时不要加 `sudo`。

套件包含 RackTop、GNOME 50 和 Mesa 图形运行时，体积较大。安装脚本先验证套件中的 SHA-256，再以用户级方式仅安装本地文件，不查询在线仓库。已有对应运行时会保留，避免用套件降级更新过的运行时。闭源 NVIDIA 硬件加速需要另外安装与驱动匹配的 Flatpak 扩展；扩展不可用时可尝试 `flatpak run --env=LIBGL_ALWAYS_SOFTWARE=1 com.racktop.desktop`。

已有 Flatpak 推荐使用统一安装器升级；旧 2.2.2 先完成一次引导，2.5.0 起可在应用内下载签名更新。维护者若已核验包的版本与摘要，也可在确认原安装为用户级后手动安装较小的应用包：

```bash
flatpak install --user --bundle --no-deps --no-related --or-update ./RackTop_2.7.3_linux-amd64.flatpak
```

Ubuntu 20.04 的 Flatpak 1.6 对重复安装完全相同的小应用包会提示“already installed”，表示无需更新；离线套件安装器会按提交编号自动跳过这个情况。安装不同提交的新版包会原位更新并保留 Flatpak 应用资料。

安装脚本只补齐缺失的运行时，不更新已有运行时。更新 GNOME/Mesa 时，应下载较新的套件，核对其发布日期及 `RUNTIME-COMMITS.txt`，然后在解压目录执行下列替换命令。这会使用套件中的版本，可能回退已经更新过的运行时；已有版本可用 `flatpak info --user --show-commit ID//分支` 查看。

```bash
sha256sum --check SHA256SUMS
flatpak install --user --bundle --no-deps --no-related --or-update org.gnome.Platform_50_x86_64.flatpak
flatpak install --user --bundle --no-deps --no-related --or-update org.freedesktop.Platform.GL.default_25.08_x86_64.flatpak
flatpak install --user --bundle --no-deps --no-related --or-update org.freedesktop.Platform.GL.default_25.08-extra_x86_64.flatpak
```

RackTop 不通过 Flathub 应用仓库发布。2.5.0 的 Flatpak 应用内更新会核验签名与部署 commit，只下载 `.flatpak` 应用包并复用运行时，保留原安装范围；不会使用 DEB 更新。旧 2.2.2 只提示改用 Flatpak 包，因此需要先手动引导升级一次。

兼容包包含 `ssh`、`ssh-keygen`、`ssh-keyscan`，支持应用内终端、SSH Agent、密码助手及 ProxyJump；宿主机独有的 ProxyCommand 程序不会自动进入沙箱，使用这类配置时需检查该程序是否在沙箱中可用。SSH 快速配置窗口通过宿主机 `x-terminal-emulator` 打开，宿主机需安装 OpenSSH 客户端和图形终端。

本机项目同步及私钥引用需要访问用户选择的路径，因此兼容包允许访问宿主机普通文件系统、SSH Agent 和 Secret Service，并允许调用宿主机终端。此权限范围接近原 `.deb` 客户端，不把 Flatpak 包宣称为对本机文件严格隔离的应用。系统保留路径仍由运行时管理；托盘及钥匙串可用性取决于桌面环境。

Flatpak 的应用数据默认位于 `~/.var/app/com.racktop.desktop/data/com.racktop.desktop`，与原 `.deb` 的 `~/.local/share/com.racktop.desktop` 分开。不会自动覆盖或搬迁旧资料；若需要迁移，应先退出两种客户端并备份，再复制应用数据和配置，检查本机私钥路径后重新连接。不要同时对同一份数据库运行两个客户端。

维护者在已安装 `flatpak-builder` 和 GNOME 50 Platform / SDK 的环境中构建：

```bash
flatpak install --user flathub org.gnome.Platform//50 org.gnome.Sdk//50
bash scripts/package-flatpak.sh /absolute/path/RackTop_2.7.3_linux-amd64.deb /absolute/path/output
bash scripts/package-flatpak-runtime.sh /absolute/path/output/RackTop_2.7.3_linux-amd64.flatpak /absolute/path/output
```

参考：[Tauri 的 Linux 运行环境限制](https://v2.tauri.app/distribute/appimage/)、[Tauri Flatpak 分发](https://v2.tauri.app/distribute/flatpak/)、[Flatpak 运行时与沙箱](https://docs.flatpak.org/en/latest/basic-concepts.html)。

## 本机集成

- Linux 使用系统窗口标题栏，支持窗口管理器提供的移动、缩放、最小化和关闭。
- 服务器密码通过 Secret Service 存入系统钥匙串。Ubuntu GNOME 通常由 GNOME Keyring 提供此服务；其他桌面需配置兼容服务。服务不可用或钥匙串未解锁时，保存密码可能报错；可使用 SSH Agent/密钥或仅会话密码。
- 外部 SSH 快速配置终端沿用 `x-terminal-emulator`。Ubuntu 上需安装一个提供此命令的终端程序；应用内 SSH 终端由原有 PTY 实现提供。
- 托盘可见性取决于桌面的 AppIndicator 支持。窗口内仍可使用主要功能。
- DEB 安装支持专用密钥签名的 Debian 包一键更新；2.5.0 Flatpak 使用其独立应用包更新路径。点击左上角 RackTop → 检查更新 → 更新到指定版本，下载和校验后由系统请求管理员授权，完成后重新启动。原作者主页和官方仓库入口继续保留。
- 应用数据通常位于 `${XDG_DATA_HOME:-$HOME/.local/share}/com.racktop.desktop`。卸载软件包不会自动删除用户数据。

## 一键更新与首次升级

从旧 `1.30.0-linux.12` 或其他旧维护版迁入当前 **2.7.3**，需要先从新仓库手动安装一次对应格式：Ubuntu 22.04 使用新 DEB；Ubuntu 20.04 使用 Flatpak。旧仓库及旧更新清单保持原状，不会自动将旧客户端引导到新仓库。旧 2.2.2 Flatpak 使用统一安装器进行一次引导升级，随后可用新版应用内更新；无需先卸载。

新版本保留 `com.racktop.desktop` 标识；同格式升级继续使用原服务器、项目、密钥引用和本机历史。DEB 与 Flatpak 的资料目录不同，不自动迁移，切换格式前应退出客户端并备份。

安装新分发后，启动和每 24 小时检查新仓库更新，也可点击左上角手动检查。选择“更新到 v…”后先下载、验证新仓库的专用签名、包名、版本和架构，再通过系统授权窗口安装；拒绝降级。安装取消、网络或授权失败可重试或手动下载。系统安装需要 `pkexec`、APT 和可用的桌面授权代理，系统管理员密码与服务器 SSH 密码无关。

维护者在**新仓库** GitHub Actions Secret 配置 `LINUX_UPDATER_PRIVATE_KEY`，与 `src-tauri/linux-updater.pub` 匹配；Linux 与 Mac 当前共用这套 RackTop-Workspace 更新包签名密钥。Apple Developer ID 代码签名与公证属于另一套独立配置。不要复用旧仓库私钥或修改旧 feed，也不把密钥放入 Git、安装包或附件。统一发布流程确认 Linux / Mac 全部附件可下载且摘要一致后，才同时推进新仓库 `updater` 分支的 `linux-amd64.json` 和 `macos.json`；不能在包尚未就绪时先发清单。

签名工具与本地下载测试：

```bash
# TAURI_SIGNING_PRIVATE_KEY_PATH 指向受保护的私钥文件；不要将内容写进命令或日志。
python3 scripts/sign-linux-update.py src-tauri/target/release/bundle/deb/RackTop_2.7.3_linux-amd64.deb
cargo build --release --locked --features integration-probe --bin racktop-probe --manifest-path src-tauri/Cargo.toml
python3 scripts/test-linux-update.py src-tauri/target/release/racktop-probe src-tauri/target/release/bundle/deb/RackTop_2.7.3_linux-amd64.deb
```

## 分享 SSH 连接与失败重试

侧栏 **“SSH 配置”** 统一提供导入与导出。选择“导出配置”后勾选需要分享的服务器，预览只包含所选连接；可以全选或清空，空选择不能保存或复制。桌面版保存到本机下载目录并显示完整路径。接收者从“SSH 配置”→“导入配置”→“选择配置文件”预览并导入，仍可读取本机 `~/.ssh/config`，重复连接自动跳过。

共享文件只包含名称、主机、端口、用户名和 ProxyJump；不包含密码、私钥内容、本机私钥路径、标签及历史数据。密码认证的接收者需编辑导入的服务器，选择密码并自行输入目标与跳板密码。别名跳板从已知本机连接中解析为明确地址；未勾选跳板机不会单独导出 Host 块，但所选连接所需的 ProxyJump 地址仍会包含在配置中。无法解析时提示先补齐地址。共享文件不能替代 VPN、跳板机网络权限或目标服务器账号。

连接失败后自动重试等待 30 分钟；后台历史同步也遵守这一等待时间，避免每 5 分钟绕过限制。手动刷新或重新启动应用可立即重连，成功连接后恢复正常采样频率。离线时仍保留最后一份快照供查看。

## 2.2.0 资源共享

同一邀请码在到期前可供多台设备依次加入，每台设备使用自己的设备密钥和成员授权。成功加入不会从分享者界面删除当前邀请码；撤销任一成员时会轮换邀请码，使旧码立即失效，同时保留其他已授权成员。成员在线时，分享者可看到该连接的公网出口 IP；离线后不再显示。NAT、VPN、代理或公司统一出口可能让多台设备显示相同地址，IP 不作为身份或授权依据。完整步骤与安全边界见[资源共享说明](SHARING.md)。

共享资源及其他桌面页面的原生下拉菜单在 2.2.0 统一校正纵向布局，相关桌面自动化回归已通过。Linux Deb 已通过包结构、签名下载器和隔离资料原生启动检查，并已在本机安装到用户目录。

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

桌面侧栏的 **团队工作台** 位于「密钥管理」与「日志」之间，2.8.0 源码中悬停或键盘焦点可展开服务器资源、资产设备管理（Asset management）、算力预约、办公设备申请（Office equipment requests）；点击主按钮打开网页首页。原「团队预约」页面继续提供本机资源同步，说明与打开网页按钮放在同一组。成员可属于多个组织，并在网页或桌面切换当前组织；超级管理员保持跨组织管理。服务器目录由管理员维护，本机个人连接的 GPU 上传与组织目录分别管理。

单台服务器「配置 → 服务器通知」可选打开、部分或关闭。部分模式取消最后一类后自动关闭，每次选择立即保存；关闭后，采集中或等待系统通知授权的提醒也会再次核对开关。预约条件仍会正常更新，但该服务器不再弹出相应提醒。保存失败会回到最后成功保存的设置并提示，不把尚未保存的开关状态当作永久生效。

网页使用方法见[工作台指南](WORKSPACE.md)与[资产设备管理](EQUIPMENT.md)。现行 2.7.3 桌面支持管理员设置的共享 SSH 密码，私钥仍在本机配置；2.8.0 的新增 GPU 占用摘要需要新版桌面和服务共同交付，不能据此声称 2.7.3 已具备该能力。

2.8.0 管理员桌面使用本机已有 SSH 连接和最近采样，约每 30 秒向中央 API 上传获授权组织服务器的 GPU 占用摘要。关闭本地历史记录后仍可同步实时占用：摘要保留在内存中，不为此额外持久化完整 Snapshot。网页按 GPU/CPU 分类，再保留原集群名称分组；每卡摘要含利用率、已用显存和 Linux 系统用户名，不上传完整进程命令行或环境。这里的系统用户不是预约人；有占用但无法识别用户名时显示匿名用户。超过约 90 秒没有有效采样时网页显示未知并隐藏旧用户，桌面退出、休眠或失去连接都会中断更新。

显示“被占用”时仍可预约未来时段；预约不会自动停止现有任务。CPU 手工资源仅提供整机预约，不能从空 GPU 清单自动登记 CPU。本轮尚未登记生产 CPU 资源，也未完成全体 CPU 服务器实时监控；表单中的阿里云 ECS 仅为名称示例，不代表已有对应资源或观测状态。

周报入口已从 2.8.0 源码移除，周报 API 在原权限校验后返回 `410 REPORTS_REMOVED`，历史资料保留。旧桌面菜单或书签仍可能访问 `/reports`；对应新网页显示移除说明并提供返回资源看板入口。

## 验证范围

当前公开 2.7.3 的实际检查范围以[版本信息](VERSION_INFOS.md)对应条目及其 Release 为准；2.8.0 尚未正式验收或发布。以下旧版验收段原文保留，不能代替这两个版本的验证。

### 历史 2.2.0 验证记录

2.2.0 已作为测试版发布。[标签工作流](https://github.com/AIsMovDataInfra/RackTop-Workspace/actions/runs/34340934877) 完成 Linux amd64、Mac Apple Silicon、Mac Intel 三平台原生构建与统一发布。Linux 通过桌面 325 项、Rust 172 项、中继 30 项、签名下载器 9 项检查，以及真实中继 TLS 帧重连和至少 15 秒的隔离资料原生启动。9 个公开附件均匹配 GitHub digest，`SHA256SUMS` 覆盖并匹配其余 8 个附件；标签源码对应关系与三个平台更新签名也已通过，详见[2.2.0 验证记录](VERIFICATION_2_2.md)。

生产共享中继 `0.3.0` 已部署。本机已将核验过的 2.2.0 Deb 安装到用户目录，用户启动器和应用菜单已指向 2.2.0；3 个数据库与 5 个配置文件已备份且安装前后内容和权限保持一致，系统级 dpkg 仍为 `1.26.0-linux.8`。

### 上一版 2.1.1 验证记录

2.1.1的[标签工作流](https://github.com/AIsMovDataInfra/RackTop-Workspace/actions/runs/34320295755)三平台构建与发布成功。Linux通过桌面322项、Rust160项、中继27项、签名下载器9项、真实中继重连及至少15秒隔离原生启动。公开Deb的版本/amd64架构、7份包内MD5、许可证与来源说明均核验通过；9个公开附件和三个更新签名通过，完整文件名及SHA256见[2.1.1校验表](VERIFICATION_2_1_1.md#公开附件与更新签名)。

本机已将核验过的2.1.1 Deb安装至用户目录，启动器和应用菜单指向新版本，3个数据库与5个配置文件已一致性备份且安装前后摘要、行数和权限保持；7个既有版本二进制未改。系统级dpkg仍为 `1.26.0-linux.8`。安装前后均无活动RackTop主进程，因此没有停止或重启进程；用户下次启动使用2.1.1。详情见[本机Linux安装记录](VERIFICATION_2_1_1.md#本机linux安装)。

### 上一版 2.1.0 验证记录

2.1.0的[标签工作流](https://github.com/AIsMovDataInfra/RackTop-Workspace/actions/runs/34309165167)三平台构建与发布成功。Linux通过桌面322项、Rust160项、中继27项、签名下载器9项、真实中继重连及至少15秒隔离原生启动。公开Deb的版本/amd64架构、7份包内MD5、许可证与来源说明均核验通过；9个公开附件和三个更新签名通过，完整文件名及SHA256见[2.1.0校验表](VERIFICATION_2_1.md#公开附件与更新签名)。

本机已将核验过的2.1.0 Deb安装至用户目录，更新用户启动器及应用菜单，原数据库、配置与权限保持。系统级dpkg仍为 `1.26.0-linux.8`，未替换系统包。原有进程未停止或重启，方便时退出并重新打开后生效；本机安装没有操作真实用户会话，也没有另起隔离启动。原生启动来自CI检查，详情见[本轮安装记录](VERIFICATION_2_1.md#本机linux安装)。

### 历史 2.0.0 验证记录


2.0.0 当前已完成桌面 322 项、Linux Rust 160 项测试（3 项依赖外部环境的既有测试忽略）及桌面生产构建。网页 91 项及浏览器工作台流程已验证。[标签工作流](https://github.com/AIsMovDataInfra/RackTop-Workspace/actions/runs/34294527671)三平台构建及发布均成功；Linux另通过中继27项、签名下载器9项、真实中继重连及至少15秒隔离原生启动检查。9个公开附件的下载、摘要和全部更新签名通过。在线工作台已部署，迁移与原管理员登录通过，详见[本轮验证记录](VERIFICATION.md)。

本机已将公开Deb安装至用户目录，启动入口为2.0.0，原数据库、配置及权限保持。系统级dpkg仍是 `1.26.0-linux.8`；用户目录安装没有替换系统包。原进程与共享会话未重启，退出并重新打开后使用新版。本次未执行原用户资料下的完整交互或自动更新安装；CI启动使用隔离资料。Deb文件及完整SHA-256见[附件摘要表](VERIFICATION.md#公开附件与更新签名)。

### 历史 1.x 验证记录

`1.30.0-linux.12` 的 [标签构建与发布 34250392746](https://github.com/AIsMovDataInfra/RackTop/actions/runs/34250392746) 已完成：桌面 301、Rust 160、中继 27、文件协议 15、更新器 9 项及真实中继重连、15 秒隔离原生启动检查通过。5 个公开附件独立下载核对摘要，Deb 包与全部 389 个源码文件、Linux 更新签名通过；本机用户安装入口已更新，原有数据保留，重启后生效。账号与设备指南见 [团队账号](TEAM_ACCOUNTS.md) 与 [固定资产标签](EQUIPMENT.md)。

`1.29.0-linux.11` 的 [标签构建与发布 34199947421](https://github.com/AIsMovDataInfra/RackTop/actions/runs/34199947421) 已通过桌面测试、生产构建、Rust 测试、真实中继协议检查、Deb 签名、更新下载及隔离原生启动检查。设备网页同源浏览器流程已验收，真实用户桌面打开系统浏览器及实际更新安装仍需单独验证。

实际执行的检查及结果记录在 [版本信息](VERSION_INFOS.md) 的 Linux 版本条目：Ubuntu 22.04.5 x86_64 上已检查单元测试、生产构建、软件包完整性、动态库依赖、原生启动与 Secret Service 持久化；此前的 linux.1 包已完成系统安装，linux.2 的逐项结果以该版本记录为准。真实 GPU 服务器的 SSH、资源监控、任务启动和文件同步需要使用自己的测试服务器进一步验证；打包成功不能替代这些功能验证。尚未验证其他发行版、ARM、Wayland 与不同桌面环境的兼容性。

参考：[Tauri Linux 开发依赖](https://v2.tauri.app/start/prerequisites/#linux)、[Tauri Debian 打包](https://v2.tauri.app/distribute/debian/)、[keyring 3.6.3 后端说明](https://docs.rs/keyring/3.6.3/keyring/)。
