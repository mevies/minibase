# 健康检查

Minibase 提供两个无认证的健康接口，供本机 CLI、进程管理器、反向代理和容器编排系统使用。响应不包含
数据库错误、文件路径、对象名、Function 名称、连接信息或 Secret。

## 存活检查

`GET /health/live` 只表示 Minibase HTTP 进程仍能处理请求。它返回 HTTP 200，并包含稳定字段：

```json
{
  "status": "live",
  "version": "1.0.0",
  "engine": "pglite"
}
```

进程存活不代表所有依赖可用。CLI 的 stop、reset、离线备份/恢复、Storage 一致性修复和 Auth
签名密钥变更使用存活检查阻止并发离线写入，不能因为就绪失败而把仍在运行的进程当作已停止。

## 就绪检查

`GET /health/ready` 并行执行有界、无业务数据副作用的探针：

- Database：执行数据库引擎自身的探活查询。
- Migrations：读取当前项目 migration 文件，确认每个版本已记录且 SHA-256 与
  `supabase_migrations.schema_migrations` 一致，并确认持久化执行日志中没有残留的 `running` 或
  `failed` attempt。
- Storage：本地后端在 `.minibase-internal/health` 创建并删除随机探针文件；S3-compatible 后端先用当前
  ETag 条件刷新 root bucket ownership，再执行最长 2 秒、`max-keys=1` 的 ListObjectsV2 请求并验证响应
  结构。ownership 被替换或无法刷新时返回未就绪，旧实例不再接受 Storage 写入。
- Functions：确认 Function Manager 已完成依赖准备、尚未关闭，且已准备的 Function 入口集合仍完整。
  探针不会启动 Function Worker。

全部通过时返回 HTTP 200：

```json
{
  "status": "ready",
  "version": "1.0.0",
  "engine": "pglite",
  "checks": {
    "database": { "ready": true },
    "migrations": { "ready": true },
    "storage": { "ready": true, "driver": "local" },
    "functions": { "ready": true }
  }
}
```

任一必要组件失败时返回 HTTP 503、`status: "not_ready"`，并只把对应 `ready` 设为 `false`。 `version`
与 `engine` 在成功和失败响应中始终存在。调用方应根据 HTTP 状态和 `checks` 判断流量是否可以进入，
不要把 503 解释为进程已经退出。
