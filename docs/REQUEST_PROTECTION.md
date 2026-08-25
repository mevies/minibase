# 请求入口保护

Minibase 在 REST、Auth、Storage 和 Edge Functions 共用的 HTTP 入口应用请求体、处理超时和并发上限。
默认值兼顾本地开发与常见对象上传：

```toml
[server.request]
max_body_bytes = 67108864
timeout_ms = 60000
max_concurrent = 256
```

对应的环境变量是：

- `MINIBASE_REQUEST_MAX_BODY_BYTES`
- `MINIBASE_REQUEST_TIMEOUT_MS`
- `MINIBASE_REQUEST_MAX_CONCURRENT`

环境变量优先于 `minibase.toml`。请求体范围为 1 KiB–1 GiB，处理超时范围为 100 ms–1 h，并发范围为
1–100000。配置值会进入来源元数据，但不会记录请求正文。

## 外部行为

- 已知 `Content-Length` 超限时，在调用业务 handler 前返回 `413 request_too_large`。
- chunked/流式正文按实际读取字节数限制，不会为了检查大小而整段缓冲；忽略正文的路由会主动取消输入流。
- handler 超时返回 `504 request_timeout`，并中止请求正文与 Edge Function 代理。PGlite 查询通过请求
  AbortSignal 立即取消；PostgreSQL 查询按请求剩余时间设置服务器端 `statement_timeout`，避免依赖 Deno
  2.9.2 + postgres.js 3.4.9 在 Windows 上不稳定的协议级 cancel 路径。数据库取消与 Storage
  补偿清理完成前，并发槽不会提前复用。
- 达到并发上限时返回 `503 server_busy` 和 `Retry-After: 1`。并发槽保持到响应正文发送完成或被取消，
  因此长流式响应也计入上限。
- 入口生成的错误仍带 `x-request-id`，并应用与普通 API 响应相同的 CORS 策略。

该超时约束的是业务 handler 产生响应的过程。成功返回后的流式响应不会被全局入口定时器截断；Edge
Functions 仍有自身的 Worker/出站请求超时与每函数并发上限。
