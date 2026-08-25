# Doctor 诊断

`minibase doctor` 在不修改 Supabase migrations、Functions 或 seed 的前提下检查项目能否安全启动。
默认输出稳定的人类可读报告；`--json` 输出单行机器可读对象。退出码为 0 表示没有 error，2 表示至少存在
一个 error。warning 会保留修复建议，但不会单独令命令失败。

Doctor 覆盖：

- `supabase/`、可选 migrations/functions 结构，以及 `.minibase` 数据目录可写性；
- API 监听端口和 managed PostgreSQL 端口冲突；
- 运行中服务的 live/ready 状态，或停止状态下的 PGlite、managed/external PostgreSQL 实际探活；
- 本地 Storage 写删探针、S3-compatible ListObjectsV2 探针，以及停止状态下的本地对象/元数据一致性；
- migrations 对当前 engine 的 Extension、复制和事务兼容性；
- migration 执行日志中的中断/失败状态；事务型中断给出安全重试建议，非事务型中断要求显式
  `migration recover --migration-version <version> --force`；
- Functions 入口、`deno.lock`，以及使用项目 Deno 缓存进行的离线依赖与 TypeScript 检查；
- Secret 文件类型、所有者、权限、占位值、弱值和重复值；
- PostgreSQL Extension 可用性。
- 停止状态下以只读文件检查验证数据库目录、`PG_VERSION` 和 `global/pg_control` 的基本结构；发现损坏时
  不启动数据库、不 reset、不删除或覆盖数据，而是要求保留现场并从已验证备份恢复。

人类可读输出示例：

```text
Minibase doctor: FAILED
Engine: pglite
[ERROR] server.port: 127.0.0.1:54321 is unavailable
  Fix: Choose another --port value or stop the process using the API port.
```

每个 warning/error 都包含 `fix`。诊断不会把数据库 URL、密码、Auth signing secret、Function Secret、
S3 凭据或后端响应正文写入报告。运行中的项目只读取健康与 capabilities 接口，不会另开同一数据目录；
离线数据库探针会在结束后关闭引擎。 若只读结构检查已经发现可能的数据损坏，Doctor
会跳过所有需要打开该数据库的探针，报告中的 `database.integrity.corrupt`
同时给出具体文件和非破坏性恢复建议。
