# Auth 安全策略

Minibase 的基础 Auth 保持 Supabase 常用邮箱密码、匿名升级、Session 和 Refresh Token
API，同时对密码、 敏感资料更新、入口请求频率和审计数据保留提供本地可配置的安全默认值。

## 密码策略

```toml
[auth.password]
min_length = 12
max_length = 256
```

新注册、匿名账号升级、普通用户修改密码和 Admin 设置密码都使用同一策略。长度按 Unicode 字符计算，密码
不能包含控制字符。历史密码仍可用于登录；只有新写入的密码必须满足当前策略。允许范围为：

- `min_length`：6 到 128，默认 12；
- `max_length`：不小于 `min_length` 且不超过 1024，默认 256。

环境变量为 `MINIBASE_AUTH_PASSWORD_MIN_LENGTH` 和 `MINIBASE_AUTH_PASSWORD_MAX_LENGTH`。

## 邮箱和密码更新的重新认证

```toml
[auth]
reauthentication_window_seconds = 300
```

非匿名用户修改邮箱或密码时，当前 Session 必须由最近一次密码登录创建，并且 Session 创建时间仍在窗口
内。Refresh Token 轮换不会刷新这个时间；窗口过期后，客户端需要再次执行 `signInWithPassword`，再用新
Session 调用 `updateUser`。匿名账号首次升级为邮箱密码账号不要求已有密码， 但仍会记录敏感变更审计。

成功修改邮箱或密码后，当前 Session 保留，其他 Session 和 Refresh Token 被撤销。`role`、
`app_metadata`、`banned_until`、`disabled`、`ban_duration` 和 `is_anonymous` 等管理字段不能由普通
`updateUser` 修改。敏感更新写入 `user.credentials_updated`，metadata
只记录布尔结果，不记录邮箱、密码、 Token 或 Secret。

`reauthentication_window_seconds` 允许 0 到 86400；设置为 0
会关闭重新认证窗口，仅建议在受控兼容测试中 使用。对应环境变量为
`MINIBASE_AUTH_REAUTHENTICATION_WINDOW_SECONDS`。

## Auth 入口限流

```toml
[auth.rate_limit]
window_ms = 60000
signup_per_ip = 10
password_per_ip = 30
refresh_per_ip = 120
update_per_ip = 30
update_per_identity = 10
max_keys = 10000
```

注册、密码登录和 Refresh Token 轮换按规范化后的客户端 IP 分桶；用户更新同时支持 IP 和已验证用户身份
分桶。任一限制设置为 0 会关闭该维度。超过限制返回 `429`、
`error_code = "auth_rate_limit_exceeded"`、`Retry-After` 和 `X-RateLimit-*` Header，响应不包含邮箱、
密码或 Token。

限流状态保存在单个 Minibase 进程的有界内存中，重启后重置，不是跨实例的分布式限流器。非回环部署应
正确设置 `server.trusted_proxies`，由入口层清洗并规范化 Forwarded Header 后再参与 IP 分桶。

每个配置字段都有 `MINIBASE_AUTH_RATE_LIMIT_` 前缀的环境变量，例如
`MINIBASE_AUTH_RATE_LIMIT_PASSWORD_PER_IP` 和 `MINIBASE_AUTH_RATE_LIMIT_MAX_KEYS`。

## 审计日志保留

```toml
[auth.audit_log]
cleanup_enabled = true
retention_days = 90
interval_minutes = 60
batch_size = 1000
```

默认在启动时执行一次清理，随后周期执行；前一批未结束时不会重叠运行。每批仅删除截止时间之前的有限条
记录，并在发生删除时写入不含敏感字段的 `audit.cleanup` 记录。`retention_days` 范围为 1 到 3650，
`interval_minutes` 范围为 1 到 35791，`batch_size` 范围为 1 到 10000。

对应环境变量为：

- `MINIBASE_AUTH_AUDIT_LOG_CLEANUP_ENABLED`
- `MINIBASE_AUTH_AUDIT_LOG_RETENTION_DAYS`
- `MINIBASE_AUTH_AUDIT_LOG_INTERVAL_MINUTES`
- `MINIBASE_AUTH_AUDIT_LOG_BATCH_SIZE`

审计清理是数据删除操作；部署方应使保留期与备份、合规和事件响应窗口一致。
