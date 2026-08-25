# Supabase 兼容性矩阵

本页描述 Minibase 已声明并由自动化契约约束的兼容范围。“部分支持”表示常用路径已验证，但不能视为对应
Supabase 服务的完整替代。未列出的行为默认不承诺兼容，应先运行 `minibase doctor` 和双引擎
`minibase migration check`。

## 已验证版本和项目布局

- Supabase CLI 2.110.0：在 Windows x64 上实际运行 `init`、`migration new` 和
  `functions new`，验证日期 2026-08-05；下载归档 SHA-256 记录在 `toolchain.json`。
- supabase-js 2.110.9：用于 Auth、REST、Storage 和 Functions 的官方客户端合同测试。
- `@supabase/server` 1.4.1：用于真实 Context 合同；作为 Supabase Function 模板兼容目标固定，不属于
  Minibase 的开发或运行环境版本。
- 项目布局标识：`supabase-cli-2.110.0`。

已识别的标准路径：

| 内容          | Supabase CLI 2.110.0 布局                | Minibase 当前行为                                    |
| ------------- | ---------------------------------------- | ---------------------------------------------------- |
| 项目配置      | `supabase/config.toml`                   | 读取已支持字段；其他字段不会被假装实现               |
| Migration     | `supabase/migrations/*.sql`              | 按 14 位版本号顺序执行并记录 hash                    |
| Seed          | `supabase/seed.sql`                      | migrations 完成后执行一次                            |
| Function 目录 | `supabase/functions/<name>`              | 自动发现默认入口或按函数配置的入口                   |
| Function 入口 | `supabase/functions/<name>/index.ts`     | 默认入口；也支持安全边界内的自定义 `entrypoint`      |
| Function 配置 | `supabase/functions/<name>/deno.json`    | 用于依赖缓存、离线检查、运行时和热重载               |
| Function TOML | `verify_jwt`、`entrypoint`、`import_map` | 三者均兼容；本地路径必须位于 `supabase/functions` 内 |

Supabase CLI 2.110.0 `functions new` 生成的入口和 `deno.json` 已按原始字节固定为 fixture；入口
SHA-256 为 `08f5278934563a684fe2b3b929cb412e849f24f539deb0bf64c6e85bd586e6c9`。真实
`@supabase/functions-js` / `@supabase/server` 依赖运行探针返回 200 和
`{"message":"Hello Functions!"}`。受控自动化固定验证默认导出包装、Function 级配置、缓存、离线检查及
热重载，默认测试不依赖公网 Registry。真实包合同在 PGlite 与 PostgreSQL 18.4 上验证
`auth: "user"`、`authMode`、用户声明、`auth.getUser()`、`ctx.supabase` 用户 RLS、
`ctx.supabaseAdmin` 跨用户 REST/Storage、`auth: "none"` 及 Admin Function-to-Function invoke。
当前只配置 `default` Publishable/Secret Key；`secret:automations` 等命名 Key 明确返回 401。错误 JWT
不会降级到 `none`，外部 HS256 Token 也不会通过公开对称 JWK 获得验证能力。同一 fixture 已在隔离
Function Worker 以及 Windows x64 Embedded/Server 编译产物中通过。

## 模块矩阵

下表由 `fixtures/supabase-basic/compatibility.json` 的机器可读条目约束，`deno task docs:check`
会阻止文档与测试版本或状态漂移。`fixtures/supabase-basic/compatibility-evidence.json` 进一步把每个
Engine/Supabase Server 的 supported/unsupported capability，以及五个模块在 Embedded/Server 上的
状态，映射到具体测试或发行 smoke task；`deno task compatibility:evidence:check` 会拒绝缺失 claim、
不存在的测试/task、重命名后的测试和已失效的源码断言标记。该门禁已进入默认 `deno task check`。

| 模块             | 总体     | Embedded | Server   | 已验证范围与边界                                                                              |
| ---------------- | -------- | -------- | -------- | --------------------------------------------------------------------------------------------- |
| Migration / Seed | 支持     | 部分支持 | 支持     | 按时间戳顺序执行 SQL migration 和 seed.sql；PGlite 受 Extension 与复制能力限制。              |
| Auth             | 部分支持 | 部分支持 | 部分支持 | 支持邮箱密码、匿名用户、Session、Refresh Token、用户更新和基础 Admin；不含 OAuth、MFA、SAML。 |
| REST             | 部分支持 | 部分支持 | 部分支持 | 支持常用 CRUD、过滤、分页、关系选择、upsert、精确计数和 RLS；不是完整 PostgREST。             |
| Storage          | 部分支持 | 部分支持 | 部分支持 | 本地与 S3-compatible 后端支持常用 supabase-js API；真实云厂商认证属于可选后续验证。           |
| Edge Functions   | 部分支持 | 部分支持 | 部分支持 | 支持 Deno.serve、CLI 默认导出、真实 Context 双引擎子集、远程入站和受控出站 fetch。            |

## 详细边界

### Migration 与数据库

两个引擎共用 migration runner、hash 校验、seed 历史和 RLS 请求上下文。常见 PostgreSQL SQL、JSONB、
PL/pgSQL Trigger、外键和 Policy 已验证。Embedded 不支持 `pgcrypto`、`uuid-ossp`、PostGIS、逻辑复制和
任意动态 Extension；Server 的 managed PostgreSQL 只声明逻辑复制“可配置”，能力端点和 doctor 会要求
部署方显式核对 `wal_level`、复制权限与网络拓扑，不把默认配置冒充为已经启用。其他 Extension 支持范围
取决于随附 Runtime 或外部 PostgreSQL 的实际安装。Minibase 不会把不支持的 SQL 静默改写成另一种语义。

项目数据格式 v1→v2 对数据库、Storage 和 Secret 均为只读。外部 PostgreSQL 路径会查询实际
`server_version_num`、在 manifest 中记录只读 effects，并只备份可恢复的本地 state/Storage/Secret；
故障测试确认外部数据库行不变。未来会写数据库的升级在没有事务或可验证快照时仍明确拒绝。

### Auth

已验证 `signUp`、`signInWithPassword`、`signInAnonymously`、Access Token、Refresh Token
轮换、`getUser`、 `updateUser`、`signOut` 及基础 `auth.admin` 用户读写删除。Token 会驱动
`auth.uid()`、`auth.role()` 和 RLS。 OAuth Provider、Magic Link/OTP 邮件、MFA、SAML 和完整 GoTrue
配置不在 MVP 范围。密码策略、敏感更新重新认证、Auth 入口限流和审计保留边界见
[`AUTH_SECURITY.md`](./AUTH_SECURITY.md)。

### REST

已验证 insert/select/update/delete/upsert、single/maybeSingle、range/limit/order、精确
count、常用比较与 集合过滤、列别名、单列外键关系选择及 Schema Header。RPC、完整 PostgREST
嵌套语法、所有 Operator、 数据库变更订阅和 GraphQL 不在当前承诺范围。

### Storage

本地后端已验证 bucket 创建、upload、download、remove、list、Signed URL、Public URL、文件大小和 MIME
限制、流式写入、RLS 及崩溃恢复。S3-compatible 后端保持相同客户端 API，并已通过受控 SigV4、流式传输、
CopyObject、补偿、ownership 和故障注入测试；AWS S3、Cloudflare R2、MinIO 的真实云厂商认证作为可选
后续验证，不阻塞当前自托管发行。逻辑备份可流式包含 Local 或 S3 对象正文并跨后端恢复，远程 commit
失败具有数据库与已提交对象补偿。S3 reset 会把数据库 物理目录、ownership 控制对象之外的全部原始
backend key、对象正文、大小、MIME 与 SHA-256 保存到本地 backup；删除前验证清单，部分删除或
migrations/seed 失败时自动恢复并逐对象复核。运行服务、reset、逻辑 恢复和 repair 都使用 root bucket
条件 ownership；不同数据库/集群的第二个 writer 被拒绝，ETag 被替换后 旧实例写入和 readiness
失败关闭。崩溃锁只能在确认所有 writer 停止后用 `storage unlock --force` 释放。 当前 format v1→v2
metadata-only upgrade 不访问远端对象并已支持；未来 Storage-mutating upgrade 会先持有 root
ownership、流式保存并二次复核
全部远端对象，失败时从本地快照逐对象恢复与校验。受控协议测试已覆盖成功、失败恢复、快照竞态与回滚不完整
报告。图片转换、Analytics Bucket 和 Vector Bucket 不在 MVP 范围。

如部署方需要真实云厂商认证，可选验收使用两个独立、空且仅供本次测试的 root bucket。固定 runner
分别执行：

```powershell
deno task s3:real:probe --provider aws-s3 --output .evidence/local/aws-s3.json
deno task s3:real:probe --provider cloudflare-r2 --output .evidence/local/cloudflare-r2.json
deno task s3:evidence:promote --aws .evidence/local/aws-s3.json `
  --r2 .evidence/local/cloudflare-r2.json --output-dir evidence/s3/<runner-id>
```

probe 只接受官方 HTTPS endpoint，要求 clean commit 和稳定 runner id，并验证 CopyObject、覆盖补偿、
16 MiB 分块流、条件 ownership 冲突/handoff、列表及最终数据/临时对象清理。已释放的 ownership
控制对象会保留并由下一轮条件替换，避免无条件删除与新 writer 竞态。报告只记录
provider、region、bucket SHA-256、工具链和行为结果，不记录 endpoint 中的账户 ID、bucket 名、Access
Key、Secret 或 Session Token。`s3:evidence:check` 会重算成对报告的 SHA-256，并拒绝不同
commit、runner、工具链或缺失检查项。 `.github/workflows/real-s3.yml` 仅允许手动触发，并要求受保护的
`real-s3-evidence` environment。没有真实 AWS S3 与 Cloudflare R2 报告时，发布门禁不会伪造认证结论，
但也不会把可选云端证据作为本地自托管发行的阻塞条件。

### Edge Functions

已验证远程 HTTP/HTTPS 入站、CORS、JWT、`SUPABASE_URL`、Anon/Publishable Key、可选 Service
Role/Secret Key、自定义 Secret、热重载、依赖缓存、日志和 `fetch` 出站。入口既可调用
`Deno.serve`，也可默认导出 Fetch 函数或 `{ fetch(...) {} }` 对象。函数级 `deno.json`、`deno.lock`、
TOML `entrypoint` / `import_map` 会统一用于缓存、离线类型检查和 Worker 运行。普通 HTTP、
OpenAI-compatible JSON 与
SSE、allow/allowlist/deny、重定向和可选私网阻断均有受控测试。当前限制包括：

同一函数默认使用最多 2 个按需启动的 Deno 进程，并以 least-active 方式调度；可通过
`[functions.runtime] workers_per_function` 或 `MINIBASE_FUNCTIONS_WORKERS_PER_FUNCTION` 在 1–16
范围内覆盖。进程级超时或崩溃只摘除命中的 PID，另一个进程的在途请求继续完成。后续请求会补充新
PID；多进程仍共享每函数总并发预算，热重载仅在整池空闲时切换。

热重载使用固定 Function Deno Runtime 的模块图跟踪入口、全部本地 `file:` 依赖、实际 Deno 配置、
import map 和 lockfile。位于 `supabase/` 内但不在目标函数或 `_shared` 目录中的共享模块也在依赖图内。
修改这些模块会重新执行离线 TypeScript 检查并重建整个函数池。类型错误会拒绝新 Worker，修复后加载
新版本。

模块图中的本地依赖若逃逸 `supabase/` 与 Minibase 缓存根目录，会在执行用户代码前明确拒绝。当前不会
缓存成功的类型检查结果；未来若增加缓存，必须复用同一完整依赖图作为失效依据。

Functions 网关会按已验证的调用角色，把 Minibase 客户端标识规范化为 Worker 内部固定的 Publishable 或
Secret Key，从而兼容 `@supabase/server` 的精确 API Key 校验；关闭 Service Role Key 注入时不会通过
请求头重新泄漏该高权限 Key。

- Minibase 当前只注入名为 `default` 的 Publishable/Secret Key；自定义命名 Key 和通配命名 Key 尚不
  支持；
- `@supabase/server` 中依赖 Minibase 尚未实现的 Supabase 服务或高级 Auth 能力的 Context
  操作不承诺兼容；
- 本地可信模式不是未经验证代码的操作系统级多租户沙箱；
- 一个 Deno 进程仍可并发承载多个请求；强制回收不会影响其他进程，但严格的单请求进程隔离不属于当前
  本地可信 MVP。

## 明确不包含

Realtime、Studio、完整 PostgREST/GoTrue、任意 PostgreSQL Extension、PGlite TCP、PGlite 多节点、自动
PostgreSQL 数据目录转换及未经验证的多租户强隔离不属于当前 MVP。

版本升级必须同时更新 `toolchain.json`、机器可读 fixture、自动化证据映射、本页和相应双引擎合同测试。
开始使用见 [五分钟指南](./GETTING_STARTED.md)，发行版差异与迁移见[选择指南](./EDITIONS.md)。
