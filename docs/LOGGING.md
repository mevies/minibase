# 日志

Minibase 运行时事件会写入 `.minibase/logs/minibase.jsonl`。文件内容始终是逐行 JSON，便于采集、查询和
故障诊断；控制台可以独立选择 JSON 或人类可读格式。

```toml
[logging]
format = "json" # json 或 human
max_bytes = 10485760
retention_files = 5

[logging.functions]
max_bytes = 10485760
retention_files = 5
```

对应环境变量为 `MINIBASE_LOG_FORMAT`、`MINIBASE_LOG_MAX_BYTES`、
`MINIBASE_LOG_RETENTION_FILES`，以及现有的 `MINIBASE_FUNCTION_LOG_MAX_BYTES`、
`MINIBASE_FUNCTION_LOG_RETENTION_FILES`。大小范围为 1 KiB–1 GiB，归档数量范围为 0–100；
`retention_files = 0` 表示轮换时不保留旧文件。

## 记录合同

所有记录至少包含：

- `timestamp`：UTC ISO 8601 时间；
- `level`：`info`、`warning` 或 `error`；
- `module`：例如 `server`、`database`、`auth`、`rest`、`storage` 或 `functions`；
- `event`：稳定的事件名称。

HTTP 请求记录使用 `http_request`，并包含 `requestId`、`durationMs`、`method` 和
`status`。请求日志不记录 Authorization、API
Key、Cookie、查询串、请求体、邮箱、密码、对象名或响应正文。Auth 与 Storage
只记录路由模块和上述请求元数据。

Minibase 会对已加载的数据库 URL、Auth signing secret、角色 Token、Function Secrets 和 S3
凭据再次脱敏。Functions 仍保留独立的 `.minibase/logs/functions.jsonl`，供 `minibase functions logs`
按函数查询；同一条 Function 事件也会按全局控制台格式输出并进入运行时日志。

## 轮换

活动文件达到 `max_bytes` 前会轮换为 `.1`，已有归档依次后移。超过 `retention_files` 的归档会删除。
单条记录本身超过上限时不会写入原始内容，而是写入 `runtime_log_line_truncated`
诊断，避免超长或恶意日志 绕过容量限制。
