# SQL 安全边界

本审计覆盖 `src/` 中全部数据库 `query` / `exec` 调用。Minibase 的“参数化 SQL”约束指：所有来自 HTTP、
Auth、Storage、配置、环境变量、备份行数据等运行时数据值必须通过驱动参数传递，不能拼接进 SQL 文本。

PostgreSQL
不支持把表名、列名或关键字作为普通参数绑定，因此动态标识符和有限语法片段采用以下独立边界：

- 标识符统一经过 `quoteSqlIdentifier`，双引号会转义为两个双引号，NUL 字节直接拒绝。
- REST 暴露的 schema、table、column、alias 还必须先符合保守标识符语法；filter operator、order
  direction、 null ordering 和 conflict 行为只允许代码内枚举值。
- `limit`、`offset`、filter、insert、update、Auth、Storage metadata、JWT claims 和数据库角色均使用
  `$n` 参数；角色通过 `set_config('role', $n, true)` 设置，不拼接 `SET ROLE`。
- Storage upsert 在两条完整静态 SQL 语句间选择，不把请求值或自由 SQL 片段插入语句。

## 调用分类

- Auth、Storage、健康检查、迁移历史、Secret/清理元数据：静态 SQL 加绑定参数。
- REST：query builder 只生成已引用标识符、枚举语法和参数占位符；用户值不进入 `sql` 字符串。
- Logical Backup：catalog 查询使用参数；导出/恢复的表和列标识符统一引用。恢复前会核对 migration
  hash、 目标 schema/column 合同和数据文件 hash/行数/字节数；JSONL 行通过参数传给
  `jsonb_populate_record`。
- Database adapter / PGlite Worker：只透传上层已经分离的 SQL 与参数，不重新拼接。
- System bootstrap：执行编译进源码的静态 DDL。
- `supabase/migrations/*.sql` 与 `supabase/seed.sql`：这是用户项目提供、需要原样兼容 PostgreSQL
  的完整 SQL 脚本，不能改写为单语句参数。它们只通过 `exec` 的可信脚本边界执行，不与
  API、配置或环境输入拼接； migration/seed hash 分别用于不可变性和幂等记录。

除静态控制/DDL、系统 bootstrap 和上述原样项目脚本外，应用代码不得向 `exec` 传值。未来新增无法绑定的
动态标识符或语法片段时，必须复用集中引用/枚举函数，增加恶意输入回归，并更新本审计。

## 验证证据

- `deno task sql:check`（并入 `deno task check`）枚举允许使用 `exec` 的可信边界，扫描带插值的 SQL
  template，只允许 REST builder 与备份引用路径，并拒绝重新出现字面量 `LIMIT` / `OFFSET` 或动态
  `SET ROLE`。新增边界会使固定检查失败，直到代码和审计理由同时更新。
- REST 回归验证引号、注释、分号、反斜杠、逗号和 Unicode 值只出现在参数数组中；分页值同样不出现在 SQL
  文本。
- PGlite 与 PostgreSQL 18.4 共用 SQL safety fixture：带双引号、括号、分号、`create table`
  和注释的恶意 标识符被创建为单一引用对象；恶意行值通过参数往返；注入标记表始终不存在。
- 两个引擎共用 request-context fixture，验证 anon、authenticated、service_role 参数化切换、RLS、失败
  回滚和事务结束后的角色/claims 清理。
