# Edge Functions 速率限制

Minibase 可以在 Edge Function Worker 启动和转发请求之前，按函数总量、客户端 IP
和已验证身份限制入口请求。 为了保持现有 Supabase 项目兼容，三种限制默认均为 `0`，即关闭。

```toml
[functions.rate_limit]
window_ms = 60000
per_ip = 120
per_function = 1000
per_identity = 240
max_keys = 10000

[functions.expensive-report.rate_limit]
window_ms = 10000
per_ip = 5
per_function = 50
per_identity = 10
```

单个函数未配置的字段继承 `[functions.rate_limit]`。显式设置为 `0`
可以为该函数关闭继承的作用域。全局配置还可以由以下环境变量覆盖：

- `MINIBASE_FUNCTIONS_RATE_LIMIT_WINDOW_MS`
- `MINIBASE_FUNCTIONS_RATE_LIMIT_PER_IP`
- `MINIBASE_FUNCTIONS_RATE_LIMIT_PER_FUNCTION`
- `MINIBASE_FUNCTIONS_RATE_LIMIT_PER_IDENTITY`
- `MINIBASE_FUNCTIONS_RATE_LIMIT_MAX_KEYS`

`window_ms` 范围为 100 ms–1 h；三种请求数上限范围为 0–1000000；`max_keys` 范围为
100–1000000。配置来源会进入 Minibase 配置元数据。

## 计数语义

- 每个函数维护独立的固定窗口。`per_function` 统计该函数的全部入口请求。
- `per_ip` 在函数内按客户端 IP 分桶。IP 来自可信代理归一化后的连接链；不可信客户端不能通过伪造
  `Forwarded` 或 `X-Forwarded-For` 绕过分桶。
- `per_identity` 在函数内按已验证 JWT 的角色和 `sub` 分桶。没有 JWT
  的请求，以及公开函数携带的无效可选 JWT，统一计入匿名身份；Service Role 等没有 `sub`
  的身份按角色分桶。Minibase 不保存原始 Token。
- 函数/IP 预算在 JWT 验证前检查，以限制无效认证流量；身份预算在 JWT
  验证后检查。达到限制的请求不会启动 Function Worker，也不会占用 Worker 并发槽。
- 计数保存在当前 Minibase 进程内，重启后清空，不在多个 Minibase
  实例之间同步。需要多副本统一配额时，应在 外部反向代理或 API Gateway 配置分布式限流。

状态表最多保留 `max_keys` 个桶。达到上限时先清理已过期桶，再淘汰最久未使用的桶，因此不会因大量 IP
或身份 造成无限内存增长。

## 超限响应

超限请求返回 HTTP 429 和稳定 JSON：

```json
{
  "code": "function_rate_limit_exceeded",
  "message": "Function ip rate limit exceeded",
  "scope": "ip"
}
```

响应包含
`Retry-After`、`X-RateLimit-Limit`、`X-RateLimit-Remaining`、`X-RateLimit-Reset`，并继续应用正常 API
的 `x-request-id` 与 CORS 策略。
