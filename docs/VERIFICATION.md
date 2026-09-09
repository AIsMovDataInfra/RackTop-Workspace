# RackTop 2.0.0 验证记录

本页记录独立分发仓库 [RackTop-Workspace](https://github.com/AIsMovDataInfra/RackTop-Workspace) 的本轮实际验证，已发布安装包对应的源码提交为 [`673fd35`](https://github.com/AIsMovDataInfra/RackTop-Workspace/commit/673fd35323d1fbe0a4fad291cc205aa42d49afb6)。旧版本记录保留在[版本信息](VERSION_INFOS.md)。

## 当前状态

| 项目 | 已验证结果 |
| --- | --- |
| 在线团队工作台 | 2026-09-09 08:23（UTC+8）已部署 2.0.0，公网 HTTPS 和原管理员登录通过。 |
| 本地自动化 | 桌面 322 项、网页 91 项、后端全套 132 项及额外安全回归 4 项通过；桌面与网页生产构建通过。 |
| Linux Rust | 全套 160 项通过、3 项既有外部环境测试忽略；姓名兼容后另运行团队模块 14 项通过。 |
| 标签 CI | [工作流 34294527671](https://github.com/AIsMovDataInfra/RackTop-Workspace/actions/runs/34294527671) 的 Linux、Apple Silicon、Intel Mac 及最终发布全部成功。 |
| 公开安装包及更新清单 | 9 个公开附件匿名下载均为 HTTP 200，摘要一致；Linux 与两种 Mac 共3个更新签名通过，两个更新清单位于同一提交。 |
| 本机安装 | Linux 用户目录已安装 2.0.0，启动入口已更新，原数据库、配置与权限保持；未重启原有运行进程。 |

## 公开附件与更新签名

[v2.0.0 Release](https://github.com/AIsMovDataInfra/RackTop-Workspace/releases/tag/v2.0.0) 已于2026-09-09完成发布。以下9个附件均已匿名下载，HTTP 200，SHA-256与GitHub附件摘要一致；`SHA256SUMS`中的8个被校验文件全部匹配。

| 文件名 | SHA-256 |
| --- | --- |
| [LICENSE](https://github.com/AIsMovDataInfra/RackTop-Workspace/releases/download/v2.0.0/LICENSE) | `3972dc9744f6499f0f9b2dbf76696f2ae7ad8af9b23dde66d6af86c9dfb36986` |
| [NOTICE.md](https://github.com/AIsMovDataInfra/RackTop-Workspace/releases/download/v2.0.0/NOTICE.md) | `df41af7d9908083c2b26686640dbb9d9d788ddbf7ef9098c5fa56e0e29a6fbff` |
| [RackTop_2.0.0_linux-amd64.deb](https://github.com/AIsMovDataInfra/RackTop-Workspace/releases/download/v2.0.0/RackTop_2.0.0_linux-amd64.deb) | `095e6bd0b30ec52ec660170a50a07d81930d8455ae734983ae224c41578161dc` |
| [RackTop_2.0.0_macos-arm64-unsigned.app.tar.gz](https://github.com/AIsMovDataInfra/RackTop-Workspace/releases/download/v2.0.0/RackTop_2.0.0_macos-arm64-unsigned.app.tar.gz) | `d2f76325b2ff758632b54dedfa6ceac0705b72670dea5d491c89998dd11f00ab` |
| [RackTop_2.0.0_macos-arm64-unsigned.dmg](https://github.com/AIsMovDataInfra/RackTop-Workspace/releases/download/v2.0.0/RackTop_2.0.0_macos-arm64-unsigned.dmg) | `73d93a3a0054e9efc81f6cabffcfac8e8022953488f09a17b1cc5c93f364abf4` |
| [RackTop_2.0.0_macos-x64-unsigned.app.tar.gz](https://github.com/AIsMovDataInfra/RackTop-Workspace/releases/download/v2.0.0/RackTop_2.0.0_macos-x64-unsigned.app.tar.gz) | `db9784bddc2aac0d1649a1482f09b9961251583fb845c369d7097b19796b6c8c` |
| [RackTop_2.0.0_macos-x64-unsigned.dmg](https://github.com/AIsMovDataInfra/RackTop-Workspace/releases/download/v2.0.0/RackTop_2.0.0_macos-x64-unsigned.dmg) | `8800370e35d7fe50b5bbd89690d9d4cd15aeaf7c493ad71abac284fde067d229` |
| [RackTop_2.0.0_source.tar.gz](https://github.com/AIsMovDataInfra/RackTop-Workspace/releases/download/v2.0.0/RackTop_2.0.0_source.tar.gz) | `b4c9d4c569524a36809e4720a8750aedd732bd449bc446e49d41839e2a28f2b9` |
| [SHA256SUMS](https://github.com/AIsMovDataInfra/RackTop-Workspace/releases/download/v2.0.0/SHA256SUMS) | `1d297a6a7384319d97134d9f98d8f6344eb1cf5544793020b1b80a86c550deab` |

Linux常规安装选择 `.deb`，Mac常规安装选择本机架构的 `.dmg`；`.app.tar.gz`供更新器使用。Deb包版本为2.0.0、架构为amd64，包内校验表、ELF架构、许可证和NOTICE均通过。Mac归档的版本、架构、应用标识、许可证和NOTICE通过。源码包内414个文件逐项匹配v2.0.0标签，提交标记一致。

新仓库的 [linux-amd64.json](https://github.com/AIsMovDataInfra/RackTop-Workspace/blob/3818abecf79230e86d141bbe7ffaf021e3ac7c62/linux-amd64.json) 与 [macos.json](https://github.com/AIsMovDataInfra/RackTop-Workspace/blob/3818abecf79230e86d141bbe7ffaf021e3ac7c62/macos.json) 同在 updater 提交 `3818abe`，版本均为2.0.0。公开Linux包和两份Mac更新归档的签名已用新仓库专用公钥复验通过。旧仓库与旧更新清单不变；首次迁移仍需手动安装新包。

## 原生CI与本机安装

Linux CI通过桌面322项、Rust160项、中继27项、签名下载器9项及真实中继重连检查，并在隔离资料目录完成至少15秒原生启动检查。

Apple Silicon与Intel分别完成DMG挂载、应用架构和代码签名验证、DMG与更新归档内容一致性检查、更新签名验证。在各自原生runner的隔离资料目录中，应用持续运行至少8秒并创建独立数据库。两张原生窗口截图已逐张查看，均显示RackTop v2.0.0、SSH配置和团队工作台入口，前端完整，无白屏或可见文字裁剪。截图和原生报告均绑定到上表公开包摘要；这属于启动与外观检查。

本机Linux已从公开且验证通过的Deb安装到用户目录，应用菜单和用户启动入口已切换至2.0.0，动态库检查通过。升级前备份原资料；安装后原数据库与配置摘要、表计数和文件权限保持。系统级dpkg仍保留 `1.26.0-linux.8`，本次用户目录安装未替换系统包。原有应用进程和共享会话未重启，方便时退出并重新打开RackTop才会使用新版本；未将本次安装描述为已在原用户资料下完整启动操作。

## 生产上线与原资料

[在线入口](https://136.0.110.161) 已部署上述提交。升级前完成数据库一致性备份；加法迁移后，17 张旧表的所有原字段摘要一致，自增计数器保持，新增周报、设备申请和工作台审计三张表。原账号身份、公司、会话及已有业务资料保留，未根据名称猜测旧资源公司。

公网 TLS 校验、`/api/health`、静态页面及入口 JavaScript/CSS 摘要检查通过，部署资产与本地构建一致。未登录访问资源、预约、设备、成员目录、周报和申请 API 均返回 401，不公开业务记录。

原管理员已实际登录新网页，原有 2 位成员及 6 张资源卡仍可见，周报模块能打开且原有空记录保持。该检查没有修改真实成员公司、资源、设备、周报或申请；登录本身创建了正常浏览器会话。

## 浏览器操作

本地浏览器使用独立合成数据验证：

- 超管代成员提交周报，选择同公司评审人；指定评审人读取锁定正文并手工填写 92 分。作者与异公司成员不出现在可用评审选项中。
- 普通成员提交设备申请后只看到提交确认；超管批准并登记关联设备领取，设备台账立即显示申请人和使用中状态。
- 头像保存、设备照片缩略图、中英文深浅主题及大号文字正常；390×844 手机尺寸下周报详情可滚动且关闭入口可见。
- 桌面预览取消全部通知类别后显示关闭，重新打开仍为关闭；SSH 导出清空选择会禁用复制/保存，仅选择一台 A100 时导出一项。
- 团队工作台菜单位置、方向键聚焦与 Escape 关闭正常；预约页内容与标题对齐。两个 Vite 预览分开缓存后可同时重新加载并显示标题和照片。

这些桌面操作发生在浏览器预览中。关闭通知期间异步采集和操作系统授权的竞态、设置持久化等由自动化测试覆盖。

## 保留的验证边界

公开附件、签名、原生CI启动和Linux用户目录安装已通过；真实用户的完整操作与自动更新替换仍是独立验证项目。Mac两架构只有本轮CI启动及截图检查，未执行真人原生交互。

Mac 包采用 ad-hoc 签名，未经过 Apple Developer ID 签名或 Apple 公证。真实用户设备的首次放行、钥匙串授权、完整 SSH/共享/更新交互、最低 macOS 11 兼容性、真实 A100 作业、实体手机拍照扫码和纸质标签打印仍需在对应设备验证。合成周报不构成真实员工绩效或考勤结论。
