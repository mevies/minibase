# 升级与回滚

Minibase 的可执行文件版本、项目数据格式、PGlite 版本和 PostgreSQL Runtime 版本彼此独立记录。新版
Minibase 遇到旧项目数据格式时不会静默修改数据，也不会直接启动；先停止服务并执行：

```powershell
minibase upgrade --project . --json
```

升级命令会先完成以下预检：

- `project.json` 中记录的 engine 必须与本次选择一致；
- 本地数据库的 `.minibase/data/.../PG_VERSION`，或外部 PostgreSQL 的
  `server_version_num`，必须是当前 版本支持的 PostgreSQL 主版本；
- Minibase 必须已经停止；
- 升级计划声明为会写入的数据库、Storage 和 Secret 必须有可验证回滚；只读资源会在 manifest 中明确
  标记，不能被未来写入步骤静默复用。

需要改变项目数据格式时，Minibase 会先在 `.minibase/backups/upgrade-*` 创建物理备份。备份包含数据库
目录、本地 Storage、Minibase 管理的 Auth secrets 和原始 `project.json`，逐文件记录大小与 SHA-256。
只有备份完整落盘后才会写入新格式状态。升级任一步失败时会从这份已验证备份恢复原路径，并保留备份目录供
人工复核。Unix 备份目录/文件使用 `0700`/`0600`；Windows 备份树关闭继承，只允许当前账户和 SYSTEM
访问，并让相同限制继承到数据库、Storage 与 Secret 子项。

当前 format v1 到 v2 的升级只写入本地 `project.json`，对数据库、Storage 和 Secret 均为只读。
`manifest.json` 会记录三类资源的 `effects: "read-only"`。因此外部 PostgreSQL 可以执行这一条明确的
metadata-only 升级：Minibase 用只读查询验证实际 `server_version_num`，备份本地 state、Local Storage
和 Secret，不为外部数据库伪造物理备份条目；故障注入验证 state
自动回滚且外部数据库行保持不变。未来任何会写数据库的格式升级都必须先提供事务或可验证快照，否则外部
PostgreSQL 路径会失败关闭。

S3-compatible Storage 也可以执行当前 metadata-only upgrade。升级备份不会伪造本地 Storage 条目，
升级过程不会列出、读取或写入远端对象；不可达 S3 endpoint 的黑盒测试验证该边界。upgrade plan
只有明确把 Storage effect 声明为 `write`，才会先获取 root bucket 条件 ownership，把 ownership
控制对象 之外的全部远端原始 key 流式保存到本地升级备份，并记录 backend key、大小、MIME 与
SHA-256。本地备份
完成后还会重新列出、读取和校验整份快照；清单或正文变化会在调用写入步骤前中止，并只回滚已经写入的本地
state。写入步骤开始后任一步失败都会删除当前远端对象、从快照逐对象恢复并再次校验；恢复不完整时错误会
要求保留升级备份目录。其他数据库/集群的 writer 持锁时，升级在创建备份或写入对象前失败。

这条通用回滚路径已经用成功写入、故障后完整恢复、快照竞态和恢复失败注入验证；当前 v1→v2 计划仍声明
`read-only`，所以不会仅因新增能力而访问 S3。AWS S3 与 Cloudflare R2 的真实云厂商认证属于可选后续
验证，不替代部署方针对目标服务的非生产演练。生产维护仍建议先用 `backup export --include-storage`
创建离机逻辑备份；崩溃遗留 ownership 只能在确认所有 writer 停止后用 `storage unlock --force` 释放。

如果项目已经是当前格式，`minibase upgrade` 仍会验证数据库主版本，但不会创建无意义备份。高于当前
Minibase 支持的数据格式会被拒绝，必须使用兼容的更新版本打开。

升级备份是独立目录，`manifest.json` 中的 `sourcePath` 指向 `.minibase` 下的原始位置。自动回滚失败时
不要执行 reset 或删除该目录；保留当前数据和升级备份，先核对 manifest 中的逐文件大小与 SHA-256，再
使用匹配旧格式的 Minibase 版本恢复。任何自动恢复不完整的错误都会直接给出应保留的备份路径。
