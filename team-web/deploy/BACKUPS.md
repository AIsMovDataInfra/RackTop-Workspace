# 资产数据持久化与备份

资产信息、设备编号、照片和修改记录通过中央 API 写入云服务器的 `/var/lib/racktop-team/team.sqlite`，与账号、预约、周报及申请共用数据库。数据库位于版本目录之外，部署、重启或关闭浏览器不会清空它。写入采用 SQLite WAL、`synchronous=FULL` 和事务；照片以 JPEG BLOB 保存，备份不需要另找图片目录。

## 自动快照

配套 systemd 定时器每 15 分钟运行一次在线备份，不停止网页服务。`scripts/team-backup-rotate.mjs` 复用 SQLite backup API，包含已经提交到 WAL 的数据。每个快照目录包含 `snapshot.sqlite` 和不含业务正文的 `manifest.json`。

快照先在私有临时目录中生成，经过 SHA-256、完整性、外键及全部表内容检查，再独立复制并重新打开验证恢复，最后发布完整目录。资产照片 BLOB、历史与编号表均纳入检查。失败不会替换旧快照，定时任务返回失败并记录到 systemd journal。

备份保留以下集合的并集，重合的快照只保存一次：

- 最新 96 份快照，正常运行时约覆盖 24 小时；
- 最近 30 个有备份的 UTC 日期，每天最新一份；
- 最近 12 个有备份的 UTC 月份，每月最新一份。

历史副本从启用后逐步积累。只清理本工具识别且验证成功的自动快照；手动备份和未知文件不清理。发现异常快照时停止本轮清理，避免连带删除恢复点。备份目录必须监控可用空间，检查失败日志后处理问题，不能把定时器已启用等同于永远备份成功。

正常持续运行时，最新恢复点通常不超过约 15 分钟；备份耗时、调度延迟、停机或任务失败会扩大这个窗口。定时快照不承诺故障时零数据损失。

## 安装

将运维工具安装到独立于网页 release 的稳定目录，避免后续切换旧版本时让备份任务失效。以下命令在服务器仓库或解包后的部署包目录执行：

```bash
install -d -m 0755 -o root -g root /opt/racktop-team/backup-tools
install -m 0644 -o root -g root scripts/team-backup.mjs scripts/team-backup-rotate.mjs /opt/racktop-team/backup-tools/
install -d -m 0700 -o root -g root /var/backups/racktop-team /var/backups/racktop-team/automatic
install -m 0644 team-web/deploy/racktop-team-backup.service team-web/deploy/racktop-team-backup.timer /etc/systemd/system/
systemctl daemon-reload
systemctl start racktop-team-backup.service
systemctl enable --now racktop-team-backup.timer
```

备份由 root 管理，目录 0700、文件 0600，放在网页进程不可写的 `/var/backups/racktop-team/automatic`。数据库仍由 `racktop-team` 所有。工具只需要本地文件权限，不增加公网下载接口，也不把数据库、凭据或备份提交到代码仓库。

部署前的手动备份另存 `/var/backups/racktop-team/manual`，并在受限目录保存服务环境文件、systemd 配置和源码 release 标识。不要把 `service.env` 或其他秘密放入公开验证报告。

## 检查与恢复

```bash
systemctl list-timers racktop-team-backup.timer --all
systemctl status racktop-team-backup.service --no-pager
journalctl -u racktop-team-backup.service --since today --no-pager
/opt/racktop-team/node/bin/node /opt/racktop-team/backup-tools/team-backup-rotate.mjs --verify /var/backups/racktop-team/automatic/选定的快照目录
```

恢复时遵循以下顺序：

1. 选择故障或误操作之前的快照，先执行 `--verify`，再把数据库复制到新的受限临时目录，通过对应版本服务和资产读取检查。必须使用副本演练，不修改备份原件。
2. 明确恢复时间点及可能回退的正常写入。禁止仅因为网页部署失败就用旧库覆盖新业务数据；网页代码回滚通常不需要数据库回滚。
3. 停止 `racktop-team-backup.timer`，等待或停止正在运行的备份服务，再停止 `racktop-team.service`。
4. 先保存当前数据库和对应 `-wal`、`-shm` 文件作为故障现场。将它们移出原位置，避免旧 WAL 混入恢复库；不要直接删除唯一现场。
5. 把验证后的 `snapshot.sqlite` 安装为 `/var/lib/racktop-team/team.sqlite`，设置所有者 `racktop-team:racktop-team` 和权限 0600。确认恢复目录没有旧 WAL/SHM；配置沿用受限环境文件。
6. 启动团队服务，检查 `/api/health`、账号权限、资产数量、编号、历史和照片。确认通过后重新启用备份定时器，手动运行一次新快照并检查结果。保留故障现场和恢复用原快照。

## 独立位置的备份

同一云服务器上的数据库和快照仍可能同时因磁盘损坏、主机丢失而不可用。自动快照不能替代异机副本。需要将完整已验证快照（数据库和清单）复制到用户指定的独立私有云存储或第二台服务器，并验证目标文件及实际恢复。推荐独立凭据、限制删除权限，按存储服务支持情况使用版本保留或不可变备份。

用户电脑可作为临时独立副本，但电脑离线、休眠或关闭时不能持续同步。未指定目标、未完成连接及恢复校验前，状态必须写为“异机备份尚未配置”，不能声称具备异地容灾。当前实际部署和演练结果见 [验证记录](../../docs/VERIFICATION_2_3_1.md)。
