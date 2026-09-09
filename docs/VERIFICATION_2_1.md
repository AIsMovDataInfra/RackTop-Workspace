# RackTop 2.1.0 验证记录

本页对应统一版本 **2.1.0**，基于已交付的2.0.0和仓库基线 `8d706e2`，发布源码为 [`b7e2f2d`](https://github.com/AIsMovDataInfra/RackTop-Workspace/commit/b7e2f2d67003569c4772f7121ac31aeaf855047d)。本轮仍提供Linux amd64、Mac Apple Silicon和Intel安装包；Mac双架构是已有分发范围。本页只记录本轮实际证据，[2.0.0验证记录](VERIFICATION.md)原样保留。

## 当前进展

| 项目 | 状态 |
| --- | --- |
| 品牌与头像定向网页测试 | 5个文件29项通过，覆盖统一品牌、24头像、回退、选择禁用、保存后重新打开及现有登录/成员流程。 |
| 头像与账号定向后端测试 | 4个文件49项通过，覆盖24项白名单、旧数据库迁移、字段/会话保持和重启后头像投影。 |
| 类型检查与构建 | 网页TypeScript检查、桌面生产构建与团队网页生产构建通过。 |
| 团队后端与网页全套 | 后端139/139、网页113/113通过。 |
| 桌面自动化 | 322/322通过。 |
| 浏览器流程 | 品牌、24头像持久保存、公司空状态、跨年周窗口、统计操作、手机尺寸和普通成员权限均已验证。 |
| 生产升级 | 2026-09-09 12:01:40（UTC+8）部署成功；一致性备份、20张旧表数据保全、公网TLS/15项GET检查及生产只读浏览器检查通过，无需回滚。 |
| 三平台CI、Release及更新清单 | 标签工作流成功；9个公开附件、423个源码文件、两份清单内的三个平台签名均通过核验。 |
| 本机安装及原生交互 | 已安装2.1.0至Linux用户目录并保留原资料/权限；旧进程未重启。三平台CI隔离原生启动通过，两张Mac截图已逐张审阅；完整用户设备交互不在本次范围。 |

## 已完成的本机浏览器检查

以下均使用本地预览与合成测试资料：

- 中文桌面尺寸的浅色/深色，以及390×844英文深色大字布局已检查。24种彩图可选；选择卫星并保存，离开页面后重新打开设置仍保持选择。
- 使用浏览器日期控件选择跨年周日2027-01-03，报告周归到2026-12-28至2027-01-03，下周计划显示2027-01-04至01-10。合成周报已完成保存草稿及提交操作。
- 统计界面核对过4位应报、1位已评分、3位缺报，平均完成度80%、平均人工评分92的合成数据场景；这不是对真实员工的评价。
- C公司即使设备数为0仍可筛选，空状态明确；在该筛选下打开新增设备表单，公司预选C公司。

普通成员浏览器仅显示自己的周报，不显示统计入口；设备公司固定为所属A公司，只返回该公司两台合成设备。390×844英文深色大字统计页的网格溢出已修复：日期和筛选框保持在页面内，统计表独立横滚并可打开报告，详情日期标题正常换行。上述检查不等于物理手机相机/触摸操作，也没有执行Mac真人原生交互。

## 生产升级与公网检查

[在线工作台](https://136.0.110.161)已于 **2026-09-09 12:01:40（UTC+8）** 升级到2.1.0，部署源码为 `b7e2f2d`。部署包来自该合并提交；网页构建来源与发布源码的Git树一致。切换服务前，在服务器Node.js 24.20.0和独立临时测试库中运行后端全套，139/139通过。

一致性备份后的迁移核对20张旧表的旧列摘要及计数器，全部保持一致；仅新增默认NULL的 `account_users.avatar_choice`，没有重建账号表或新增业务表。旧账号、会话、公司、照片、预约、周报日期/内容/评分和审计资料保持。服务配置未改变，团队服务、原共享中继与Nginx继续运行，未触发回滚。

公网证书校验和15项匿名GET检查通过：网页入口及健康检查可达，含周报统计在内的业务接口均拒绝匿名访问（401）。HTML、CSS和JavaScript三份构建资产的SHA256与部署前记录一致。这些检查没有创建或修改生产业务资料。

生产浏览器只读检查确认原超级管理员会话仍有效，RackTop主品牌、四家公司筛选（包含零设备公司）、待分配设备列表、周报统计页及设置中的24种头像正常载入。检查没有更改实际成员公司、头像、周报或设备内容；公开记录不包含真实员工资料或业务数值。公开桌面包与本机安装的独立验收结果如下。

## 公开附件与更新签名

[v2.1.0 Release](https://github.com/AIsMovDataInfra/RackTop-Workspace/releases/tag/v2.1.0)已于2026-09-09作为**测试版（Pre-release）**发布，不标记为Latest。公开页面已核对标题、五条更新及正文九个下载链接。Linux、Apple Silicon和Intel来自同一标签；[标签工作流](https://github.com/AIsMovDataInfra/RackTop-Workspace/actions/runs/34309165167)的三平台构建与统一发布均成功。

下列九个附件均已实际匿名下载（HTTP 200），字节数、GitHub digest与本机SHA256一致；`SHA256SUMS`覆盖其余八个文件并逐一匹配。源码归档的423个文件与发布标签精确一致，提交标记、LICENSE和NOTICE亦匹配。普通安装选择Deb或对应DMG，`.app.tar.gz`为Mac更新归档。

| 文件 | 字节数 | SHA256 |
| --- | ---: | --- |
| [RackTop_2.1.0_linux-amd64.deb](https://github.com/AIsMovDataInfra/RackTop-Workspace/releases/download/v2.1.0/RackTop_2.1.0_linux-amd64.deb) | 11,710,122 | `a2efe8090409dc930621fcda635fe9111de688a4f0bcf4eb59e912447f6a10b2` |
| [RackTop_2.1.0_macos-arm64-unsigned.dmg](https://github.com/AIsMovDataInfra/RackTop-Workspace/releases/download/v2.1.0/RackTop_2.1.0_macos-arm64-unsigned.dmg) | 9,419,333 | `796e9f7c12023e70749e05bb165841b5effbbfef94cd71e9f3ea61585c9aa121` |
| [RackTop_2.1.0_macos-arm64-unsigned.app.tar.gz](https://github.com/AIsMovDataInfra/RackTop-Workspace/releases/download/v2.1.0/RackTop_2.1.0_macos-arm64-unsigned.app.tar.gz) | 9,325,064 | `90ceba052ff7bdcfbecc4c672b966812858c0e0df3c743694d3579ad3c5065c0` |
| [RackTop_2.1.0_macos-x64-unsigned.dmg](https://github.com/AIsMovDataInfra/RackTop-Workspace/releases/download/v2.1.0/RackTop_2.1.0_macos-x64-unsigned.dmg) | 10,042,445 | `06e3da18dda80f4375cc63c8d740035a347ab8ed91c531f5f3b44047ace40f4a` |
| [RackTop_2.1.0_macos-x64-unsigned.app.tar.gz](https://github.com/AIsMovDataInfra/RackTop-Workspace/releases/download/v2.1.0/RackTop_2.1.0_macos-x64-unsigned.app.tar.gz) | 9,951,505 | `af5906829d9ef1271d7caa38865b3b7fbbf05733d0e747da7813125ef084c275` |
| [RackTop_2.1.0_source.tar.gz](https://github.com/AIsMovDataInfra/RackTop-Workspace/releases/download/v2.1.0/RackTop_2.1.0_source.tar.gz) | 9,526,148 | `65144adc7eaee3c3715df8698d0f8f1fd259347e983fae9942aa0180564e1799` |
| [LICENSE](https://github.com/AIsMovDataInfra/RackTop-Workspace/releases/download/v2.1.0/LICENSE) | 35,149 | `3972dc9744f6499f0f9b2dbf76696f2ae7ad8af9b23dde66d6af86c9dfb36986` |
| [NOTICE.md](https://github.com/AIsMovDataInfra/RackTop-Workspace/releases/download/v2.1.0/NOTICE.md) | 2,703 | `df41af7d9908083c2b26686640dbb9d9d788ddbf7ef9098c5fa56e0e29a6fbff` |
| [SHA256SUMS](https://github.com/AIsMovDataInfra/RackTop-Workspace/releases/download/v2.1.0/SHA256SUMS) | 770 | `992df3c51815aea80611aa9c33e218a6b04a716f99a6270d95b4af078a734fef` |

[Linux更新清单](https://github.com/AIsMovDataInfra/RackTop-Workspace/blob/5decbee0094c79e69b2f7ac44daff8f7c2d4748e/linux-amd64.json)与[Mac更新清单](https://github.com/AIsMovDataInfra/RackTop-Workspace/blob/5decbee0094c79e69b2f7ac44daff8f7c2d4748e/macos.json)位于同一updater提交 `5decbee0094c79e69b2f7ac44daff8f7c2d4748e`，均为2.1.0。`linux-x86_64-deb`、`darwin-aarch64`、`darwin-x86_64`的URL指向上述已验证文件，三个内嵌签名均已用对应仓库公钥复验通过。此结论验证下载与签名，不代替用户设备实际执行自动更新。

## 三平台原生检查

Linux CI通过桌面322项、Rust160项、中继27项、签名下载器9项及真实中继重连检查。Deb元数据版本为2.1.0、架构为amd64；7份包内MD5、ELF架构、LICENSE与NOTICE检查通过。隔离用户资料下原生启动至少15秒，按预定超时结束。

Mac两架构分别在原生runner验证DMG挂载、架构、代码签名、更新签名，以及DMG和更新归档中的应用一致性；各自使用隔离资料启动至少8秒并创建独立数据库。两张正式CI截图与已查看的预览截图摘要相同，逐张视觉审阅可见2.1.0原生窗口和团队工作台入口，没有白屏或可见错误。这是CI原生启动和截图审阅，**没有执行真人Mac交互**；两种包仍为ad-hoc签名且未Apple公证。

## 本机Linux安装

已将上表核验过的公开Deb安装至本机用户目录中的2.1.0版本目录，用户启动器和应用菜单均指向新入口，动态库依赖可解析。安装前完成备份，安装后原数据库、配置及权限保持一致，应用标识仍为 `com.racktop.desktop`。

系统级dpkg包仍为 `1.26.0-linux.8`，本次用户目录安装没有替换系统包。没有停止、启动或重启原RackTop进程，既有共享会话继续运行；用户方便时退出并重新打开即可使用2.1.0。本机安装检查没有另起隔离启动或操作真实用户资料；原生启动证据来自上面的CI检查。

## 功能与数据边界

- 品牌统一为大字RackTop与小字“AIsMov · 团队工作台”；彩色头像为24种本地SVG，原7个ID保持兼容，没有第三方图像请求。
- 头像数据库采用新增 `avatar_choice` 的加法迁移，保留旧 `avatar` 列及原值；新头像不触发账号表重建。保存旧ID时同步旧列，保存新ID时保留旧头像作回退；公开接口仍只返回 `avatar`。
- 四家公司始终出现在超管设备筛选中，零设备不会隐藏公司；显示数量不是创建权限或修改公司归属的指令。普通成员仍只访问自己公司。
- 新周报可任选日期并归入北京时间周一至周日，明确显示本周与下周窗口；旧报告日期不被迁移或改写。
- 周报统计只供超管查看，按报告与账号资料计算提交、任务完成度及已有人工评分；缺报/草稿/未评分不自动记零，也不生成逾期、自动考勤或绩效结论。

Mac仍为ad-hoc签名且未经过Apple公证。真实设备上的完整SSH/共享/更新操作、实体手机拍照扫码与纸质打印，应在各自设备验证；测试周报和示例设备不能当作真实员工绩效或资产变更。
