# RackTop 2.1.1 验证记录

本页对应统一版本 **2.1.1**，基于已交付的2.1.0，发布源码为 [PR #5](https://github.com/AIsMovDataInfra/RackTop-Workspace/pull/5) 的合并提交 [`7fdecfa`](https://github.com/AIsMovDataInfra/RackTop-Workspace/commit/7fdecfa432078537f5268bec53e872d9edb89eca)。Linux amd64、Mac Apple Silicon和Mac Intel使用同一版本与Release。本页只记录2.1.1实际证据，[2.1.0验证记录](VERIFICATION_2_1.md)原样保留。

## 验收摘要

| 项目 | 结果 |
| --- | --- |
| 功能与自动化 | 团队后端140/140、团队网页119/119、桌面322/322通过；Linux Rust 160项通过，3项既有外部环境测试忽略；两套生产构建通过。 |
| GitHub CI与Release | [工作流34320295755](https://github.com/AIsMovDataInfra/RackTop-Workspace/actions/runs/34320295755)成功；v2.1.1作为Pre-release发布，9个附件、GitHub digest、SHA256、423份标签源码及三平台更新签名全部通过。 |
| 生产升级 | 已切换至 `/opt/racktop-team/releases/2.1.1-superadmin-7fdecfa`；升级前一致性备份存在且保持私有，20张表、schema对象、内容摘要和自增计数器不变，无schema迁移或历史重写。 |
| 公网与生产浏览器 | TLS和15项只读GET通过，业务接口匿名访问返回401，静态摘要匹配构建；原超管会话下的成员、周报、统计、设置和设备申请界面规则通过。 |
| 本机Linux安装 | 已从核验Deb安装到用户目录2.1.1并更新启动器；系统dpkg仍为1.26.0-linux.8，3个数据库与5个配置文件备份且安装前后不变，7个旧二进制不变。 |
| Mac边界 | 两架构在原生CI完成挂载、签名、更新归档一致性、8秒启动和截图审阅；包为ad-hoc签名、未Apple公证，未在实体Mac执行真人完整交互。 |

## 本版本规则

- 超级管理员固定为跨公司管理身份，没有公司归属，成员页、设置页和桌面资料均不提供或显示可编辑公司字段；历史数据库中曾保存的超管公司值仍原样保留，但不进入身份或权限判断。
- 超级管理员无需且不能以自己为作者写周报；服务端拒绝此类写入。超管仍可为已分配公司的普通成员代写、指定评审人和评分。
- 周报统计的应报、提交、缺报、任务、完成度和评分均排除超级管理员；历史超管周报也不进入统计。普通成员及普通历史作者继续按原规则处理。
- 超级管理员不提交自己的设备申请，仍可查看、批准或拒绝成员申请并登记领取。

这些变化不修改普通成员的公司、周报、预约、设备或申请资料，也不把旧超管数据删除或改写。

## 自动化与本地界面

合并前后使用同一源码完成团队后端140项、团队网页119项、桌面322项和Linux Rust测试；Rust有3项依赖既有外部环境的测试按原约定忽略。桌面与团队网页两套TypeScript/Vite生产构建通过。

隔离临时数据库中的本地浏览器检查覆盖超管成员行无公司操作、代写作者只含普通成员、统计成员选择与汇总排除超管、设置显示跨公司身份，以及中英文、深浅色和大字布局。所有写入只发生在合成临时资料中，没有更改生产数据。

## 公开附件与更新签名

[v2.1.1 Release](https://github.com/AIsMovDataInfra/RackTop-Workspace/releases/tag/v2.1.1)于2026-09-09作为**测试版（Pre-release）**发布，不标记为Latest。[标签工作流](https://github.com/AIsMovDataInfra/RackTop-Workspace/actions/runs/34320295755)的Linux、Apple Silicon、Intel和统一发布任务均成功，运行提交与标签均为 `7fdecfa432078537f5268bec53e872d9edb89eca`。

下列9个附件均已匿名下载（HTTP 200）；下载SHA256与GitHub digest一致，`SHA256SUMS`逐项覆盖并匹配其余8个文件。源码归档的423个文件与标签精确一致，提交标记、LICENSE和NOTICE亦匹配。普通安装选择Deb或对应DMG，`.app.tar.gz`是Mac更新归档。

| 文件 | 字节数 | SHA256 |
| --- | ---: | --- |
| [RackTop_2.1.1_linux-amd64.deb](https://github.com/AIsMovDataInfra/RackTop-Workspace/releases/download/v2.1.1/RackTop_2.1.1_linux-amd64.deb) | 11,709,944 | `11c6567f57a7810b524538bd655159f255252a4648855dcdb07110c1bb4696b8` |
| [RackTop_2.1.1_macos-arm64-unsigned.dmg](https://github.com/AIsMovDataInfra/RackTop-Workspace/releases/download/v2.1.1/RackTop_2.1.1_macos-arm64-unsigned.dmg) | 9,419,600 | `4c30e5fb750cfbc60096251a6e9d71d0bdab433b0307acd2e1882316eb04a209` |
| [RackTop_2.1.1_macos-arm64-unsigned.app.tar.gz](https://github.com/AIsMovDataInfra/RackTop-Workspace/releases/download/v2.1.1/RackTop_2.1.1_macos-arm64-unsigned.app.tar.gz) | 9,325,207 | `daa6601f5009aa7675d334ed67ca43b6b2dde52518f2ed8edc43466cdb0b16df` |
| [RackTop_2.1.1_macos-x64-unsigned.dmg](https://github.com/AIsMovDataInfra/RackTop-Workspace/releases/download/v2.1.1/RackTop_2.1.1_macos-x64-unsigned.dmg) | 10,042,840 | `fe32eb1afca88861bb18fbc19e24205035c2fe1433bde9a996a2618651d67934` |
| [RackTop_2.1.1_macos-x64-unsigned.app.tar.gz](https://github.com/AIsMovDataInfra/RackTop-Workspace/releases/download/v2.1.1/RackTop_2.1.1_macos-x64-unsigned.app.tar.gz) | 9,951,912 | `6452b6c51ed71c020f84028fb2ad0285c1b2a18f87df099c313c861fc65d4928` |
| [RackTop_2.1.1_source.tar.gz](https://github.com/AIsMovDataInfra/RackTop-Workspace/releases/download/v2.1.1/RackTop_2.1.1_source.tar.gz) | 9,533,798 | `73bdcf763ceecd7a0d395c40c08455093ef2c06c834624b454c17dba4ef8601f` |
| [LICENSE](https://github.com/AIsMovDataInfra/RackTop-Workspace/releases/download/v2.1.1/LICENSE) | 35,149 | `3972dc9744f6499f0f9b2dbf76696f2ae7ad8af9b23dde66d6af86c9dfb36986` |
| [NOTICE.md](https://github.com/AIsMovDataInfra/RackTop-Workspace/releases/download/v2.1.1/NOTICE.md) | 2,703 | `df41af7d9908083c2b26686640dbb9d9d788ddbf7ef9098c5fa56e0e29a6fbff` |
| [SHA256SUMS](https://github.com/AIsMovDataInfra/RackTop-Workspace/releases/download/v2.1.1/SHA256SUMS) | 770 | `bb133a5a0c94034d966f24e2650b23ba5dfd3e5378bb667303b0881aec5268ee` |

[Linux更新清单](https://github.com/AIsMovDataInfra/RackTop-Workspace/blob/42b9e3a51dc4534483a3d83078ea517e29f77ad0/linux-amd64.json)和[Mac更新清单](https://github.com/AIsMovDataInfra/RackTop-Workspace/blob/42b9e3a51dc4534483a3d83078ea517e29f77ad0/macos.json)位于同一updater提交 `42b9e3a51dc4534483a3d83078ea517e29f77ad0`，版本均为2.1.1。`linux-x86_64-deb`、`darwin-aarch64`和`darwin-x86_64`三个内嵌签名均用对应仓库公钥复验通过。此结论覆盖下载与签名，不代替用户设备执行自动更新。

## 三平台原生检查

Linux CI通过桌面322项、Rust160项、中继27项、签名下载器9项和真实中继重连检查。Deb元数据为 `Package: rack-top`、`Version: 2.1.1`、`Architecture: amd64`；7份包内MD5、ELF架构、LICENSE与NOTICE检查通过。隔离用户资料下原生进程至少存活15秒，按预定超时结束。

Mac两架构分别在原生runner核验DMG挂载、原生架构、代码签名、更新签名，以及DMG和更新归档中的应用一致性；各自使用隔离资料启动至少8秒并创建独立数据库。两张1432×932截图均已逐张审阅，可见2.1.1原生窗口和团队工作台入口，没有白屏、可见错误或明显布局问题。

两种Mac包均为 **ad-hoc签名**，没有Apple Developer ID签名，也**未经过Apple公证**。上述证据是CI原生启动与截图审阅，没有在实体Mac上执行真人完整交互、Gatekeeper首次放行、钥匙串、真实SSH/共享或自动更新替换。

## 生产部署与数据保持

[在线工作台](https://136.0.110.161)已于 **2026-09-09 15:03:20（UTC+8）** 从2.1.0切换到 `/opt/racktop-team/releases/2.1.1-superadmin-7fdecfa`，版本标记和源码提交均为2.1.1 / `7fdecfa432078537f5268bec53e872d9edb89eca`。`racktop-team.service`、`racktop-relay.service`与`nginx.service`切换后均为active，服务配置保持不变。

切换前通过SQLite backup API创建一致性备份：`/var/lib/racktop-team/backups/workspace-deploy-20260909T070319Z-30886/before.sqlite`。备份目录为root:root、0700，数据库与报告为0600。升级前、初始化后及隔离探测后均检查全部20张表、59个schema对象、列、索引、触发器、视图、行数、逻辑内容摘要、`sqlite_sequence`和数据库pragma，结果完全一致。旧超管公司、周报、设备申请和审计记录原样保留；本版**没有schema迁移或历史数据重写**。

公网TLS证书校验和15项只读GET通过：首页、设备、周报、申请和成员页面可达，业务接口匿名访问均返回401，HTML及两份静态资源摘要与部署构建一致。检查没有使用凭据、没有创建或修改业务记录。

生产浏览器使用既有记住登录的超管会话完成只读验收：超管身份显示“跨公司管理，无需分配公司”，成员行没有公司、删除或重置操作；代写作者只包含普通成员；统计筛选与表格不含超管，显示应报1、已提交1；设置没有可编辑公司字段；设备申请页只有成员申请管理区，没有超管个人申请表单。浏览器没有保存或提交任何表单，也未在公开记录中保存真实周报正文或设备申请内容。

## 本机Linux安装

已使用上表核验的公开Deb及固定SHA256，将2.1.1安装到 `/home/yan/.local/share/racktop/versions/2.1.1`。用户启动器 `/home/yan/.local/bin/racktop`与桌面入口均解析到新版本，动态库可解析，应用标识仍为 `com.racktop.desktop`。包内RackTop二进制SHA256为 `32059b5699288d0a6c4d2a37c6cec44b50c128a8888fe914298b1672e02a8708`。

安装前将3个SQLite数据库和5个非数据库配置文件备份到私有目录 `/home/yan/.local/share/racktop-install-backups/before-workspace-2.1.1-20260909T070622Z-256783`；备份目录为0700、文件为0600。安装前后数据库摘要、表行数、配置文件摘要和权限均不变。系统dpkg包仍为 `1.26.0-linux.8`，7个既有版本二进制的摘要和权限全部保持。

安装前后均没有活动RackTop主进程，因此没有进程被停止、重启或替换，也没有正在运行的共享会话可供保留检查。安装过程没有启动真实用户资料或另做隔离smoke；用户下次启动将使用2.1.1，原生启动证据来自上面的发行CI。

## 验证边界

- 生产检查全部为只读，没有更改真实成员公司、周报、评分、设备或申请；统计中的现有结果不是对员工新增的考勤或绩效结论。
- 历史超管公司、周报和申请保留在数据库中；它们只在新身份投影、权限判断及统计中被忽略。
- Linux本机安装验证覆盖公开包、依赖、启动入口、备份和资料保持，没有执行真实SSH、GPU监控、共享或自动更新交互。
- Mac仍需在实体设备验证Gatekeeper、钥匙串、完整SSH/共享、自动更新和真人交互；实体手机拍照、扫码及纸质资产标签也需在对应设备现场验证。
