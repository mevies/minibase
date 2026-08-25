# 匿名用户清理

Minibase 默认不自动删除匿名用户。部署方必须明确启用清理策略，避免升级时改变现有数据保留行为。

## 配置

在项目根目录的 `minibase.toml` 中配置：

```toml
[auth.anonymous_cleanup]
enabled = true
retention_hours = 720
interval_minutes = 60
batch_size = 1000
```

- `enabled` 默认 `false`。
- `retention_hours` 默认 720 小时，范围为 1 小时到 10 年。
- `interval_minutes` 默认 60 分钟，范围为 1 到 35791 分钟。
- `batch_size` 默认 1000，范围为 1 到 10000。

对应的环境变量为：

- `MINIBASE_AUTH_ANONYMOUS_CLEANUP_ENABLED`
- `MINIBASE_AUTH_ANONYMOUS_RETENTION_HOURS`
- `MINIBASE_AUTH_ANONYMOUS_CLEANUP_INTERVAL_MINUTES`
- `MINIBASE_AUTH_ANONYMOUS_CLEANUP_BATCH_SIZE`

## 行为边界

启用后，Minibase 在服务启动时执行一次清理，随后按配置周期执行。前一批仍在运行时不会启动重叠批次。

只有 `auth.users.is_anonymous = true` 且 `created_at` 早于保留期截止点的用户会被删除。
已升级为邮箱密码账号的用户不会被清理，即使其最初由匿名账号创建。 每批删除使用单个数据库事务并受
`batch_size` 限制。

删除用户会通过外键级联删除该用户的 Auth Session 和 Refresh Token。 项目 Migration 中指向
`auth.users` 或 Profile 的外键、Trigger 和 `on delete cascade` 也会照常执行，可能 同时删除业务数据。

每个非空清理批次会在 `auth.audit_log` 写入 `anonymous.cleanup`
记录，其中包含删除数量、截止时间和批量 上限。普通日志只在实际删除用户时写入结构化数量信息，不包含
Token、Secret、邮箱或用户 metadata。

启用前应根据业务恢复窗口设置保留期，并确认数据库备份策略。删除操作不可通过 Auth API 撤销。
