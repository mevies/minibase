# Minibase 五分钟启动指南

CLI 默认输出稳定的人类可读格式；自动化脚本请使用 `--json`。完整契约见
[`CLI_OUTPUT.md`](./CLI_OUTPUT.md)。

本指南从一个已经存在的 Supabase 项目直接启动 Minibase。Minibase 不要求安装 Docker、Supabase
CLI、PostgreSQL 或 Deno，也不会改写项目中的 migration、seed 或 Function 源码。

## 1. 确认项目结构

项目根目录至少应包含 `supabase/config.toml`。其他目录按需存在：

```text
your-project/
  supabase/
    config.toml
    migrations/
      20260801000000_create_schema.sql
    seed.sql
    functions/
      hello/
        index.ts
```

Minibase 按文件名中的 14 位时间戳顺序执行 `supabase/migrations/*.sql`，然后执行
`supabase/seed.sql`。缺少 migration、seed 或 Functions 时按可选能力处理。

## 2. 下载并检查

下载 `minibase-embedded-windows-x64.exe`，把它放在项目根目录，然后在 PowerShell 中运行：

```powershell
.\minibase-embedded-windows-x64.exe doctor --project .
```

`doctor` 会在写入数据库前检查项目布局、migration、Function 入口、配置和已知的 PGlite
不兼容项。退出码 `0` 表示可以继续；退出码 `2` 表示存在必须处理的兼容或安全问题。

## 3. 单命令启动 Embedded

```powershell
.\minibase-embedded-windows-x64.exe start --project .
```

这是前台进程。默认监听 `127.0.0.1`，默认 API 地址来自 `supabase/config.toml` 的 `api.port`，缺省为
`http://127.0.0.1:54321`。首次启动会：

1. 创建 `.minibase/` 运行目录和 PGlite 数据库；
2. 执行尚未应用的 migration；
3. 首次执行 `seed.sql`；
4. 准备本地 Storage 和 Edge Function Worker；
5. 写入 `.minibase/runtime.json` 和 `.minibase/logs/`。

每次 migration 执行前，Minibase 会在 `minibase_meta.migration_attempts` 中持久记录版本、SHA-256、
事务策略、尝试次数和 `running`/`failed`/`applied` 状态。默认事务型 migration 若在进程被强制终止时
中断，下次启动会依靠数据库回滚后从相同、未修改的 SQL 安全重试。显式标注 `-- minibase:no-transaction`
的 migration 可能已经产生部分副作用，因此 Minibase 会阻止自动重放；先用 `doctor`
查看版本和修复建议，人工核对或撤销部分变更后再显式运行：

```powershell
.\minibase-embedded-windows-x64.exe migration recover --project . `
  --migration-version 20260801000000 --force
```

恢复命令仍要求原 migration 文件及 SHA-256 未变化，不会通过静默修改或跳过用户 SQL 来伪造成功。

另一个终端可检查状态或停止服务：

```powershell
.\minibase-embedded-windows-x64.exe status --project . --json
.\minibase-embedded-windows-x64.exe stop --project .
```

## 4. 用 supabase-js 验证 Auth、REST、Function 和 Storage

以下代码使用普通 Supabase 客户端调用 Minibase。`anonKey` 当前只需是非空客户端标识；用户登录后，
supabase-js 会自动将 Access Token 用于 RLS 和受保护的 Function。

```ts
import { createClient } from "@supabase/supabase-js";

const supabase = createClient("http://127.0.0.1:54321", "minibase-local", {
  auth: { persistSession: false },
});

const { data: signup, error: signupError } = await supabase.auth.signUp({
  email: "alice@example.com",
  password: "correct horse battery staple",
  options: { data: { display_name: "Alice" } },
});
if (signupError) throw signupError;

const { data: notes, error: notesError } = await supabase
  .from("notes")
  .insert({ owner_id: signup.user!.id, body: "hello from Minibase" })
  .select("id,body")
  .single();
if (notesError) throw notesError;

const { data: functionResult, error: functionError } = await supabase.functions.invoke("hello", {
  body: { noteId: notes.id },
});
if (functionError) throw functionError;

const { error: uploadError } = await supabase.storage.from("avatars").upload(
  `${signup.user!.id}/avatar.txt`,
  new Blob(["hello storage"], { type: "text/plain" }),
);
if (uploadError) throw uploadError;

console.log({ notes, functionResult });
```

Storage 示例假定项目 migration 已创建 `avatars` bucket，并在 `storage.objects` 上定义了相应 RLS
Policy。文件内容默认写入 `.minibase/storage/`，元数据仍保存在 PostgreSQL Schema 中。

Function 可以继续使用 Supabase 项目中广泛存在的 `Deno.serve(...)` 形式，例如：

```ts
Deno.serve(async (request) => {
  const body = await request.json();
  const upstream = await fetch("https://api.example.com/v1/process", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return new Response(upstream.body, { status: upstream.status, headers: upstream.headers });
});
```

Supabase CLI 2.110.0 `functions new` 生成的 `@supabase/server` 默认导出形式也可以原样运行。Minibase
会优先采用函数目录内的 `deno.json` 和 `deno.lock`，并读取 `supabase/config.toml` 中按函数设置的
`entrypoint`、`import_map` 和 `verify_jwt`。这些路径必须落在项目的 `supabase/functions` 安全边界内；
越界路径和符号链接逃逸会在启动前被拒绝。

为了兼容新模板，Minibase 同时注入以下 Anon Token 变量：`SUPABASE_ANON_KEY`、
`SUPABASE_PUBLISHABLE_KEY` 和 `SUPABASE_PUBLISHABLE_KEYS`。允许注入 Service Role Token 时，也会提供
`SUPABASE_SERVICE_ROLE_KEY`、`SUPABASE_SECRET_KEY` 和 `SUPABASE_SECRET_KEYS`。公开 Function
如果不需要高权限 Key，应在 `minibase.toml` 中设置 `inject_service_role_key = false`。

Functions 网关会根据已经验证的调用身份，将客户端的 `apikey` 规范化为对应的内部 Publishable 或 Secret
Key；因此上例中的本地客户端标识也能调用 `withSupabase({ auth: [...] })` 模板。关闭高权限 Key
注入后，即使调用者持有 Service Role Token，也只会向 Function 转发 Publishable Key。

远程客户端可以通过 `/functions/v1/<name>` 调用 Function；Function 内部的标准 `fetch` 也可以访问
OpenAI-compatible API 等外部 HTTP 服务。公网监听、TLS、CORS、可信代理和出站 allowlist
应在部署前显式配置。

每个函数默认按需启动最多 2 个 Deno 进程，并继续共享每函数总并发预算。需要按本机内存、CPU 或隔离
需求调整时，可在 `minibase.toml` 中设置：

```toml
[functions.runtime]
workers_per_function = 4
```

允许范围为 1–16，也可用 `MINIBASE_FUNCTIONS_WORKERS_PER_FUNCTION` 覆盖。超时或崩溃只回收命中的
进程，其他进程中的请求继续执行；设置更大的进程数会增加空闲内存和首次并发扩容成本。

## 5. 已知兼容边界

Minibase 面向常见 Supabase 调用路径，不是 Supabase 全部微服务的重打包：

- 不包含 Realtime、Studio、完整 PostgREST、OAuth、MFA、SAML 和任意 Extension；
- Embedded 不提供 PostgreSQL TCP 连接、逻辑复制或任意动态 Extension；
- Supabase CLI 2.110.0 的默认 Function 模板已经过原始 npm/JSR 依赖运行探针；更复杂的
  `@supabase/server@1.4.1` Context 已在两个数据库引擎验证用户 RLS、Admin REST/Storage、
  `auth.getUser()`、`auth: "none"` 和默认 Secret Key 函数互调，并通过隔离 Worker 与双发行版 smoke；
  自定义命名 Key 尚未支持；
- S3-compatible 后端已经通过受控协议测试；`backup export --include-storage` 与 `backup restore`
  可流式迁移 Local/S3 对象正文。停止项目后，S3 reset 会先把数据库目录和 root bucket 下的全部原始
  key（包括 `.minibase-tmp/`）流式保存到本地 reset backup，清理前复核远端清单，并在清理或数据库重建
  失败时自动恢复、重新读取和校验每个对象的大小与 SHA-256。当前只写本地 `project.json` 的
  metadata-only upgrade 也可以执行，且不会读取或写入远端对象；未来 Storage-mutating upgrade 会先
  持锁创建并复核同等级整体快照，失败时逐对象恢复。服务、reset、逻辑恢复和 repair 已通过 root bucket
  条件 ownership 拒绝跨数据库/集群的第二个 writer；崩溃遗留锁必须在确认所有 writer 停止后用
  `storage unlock --force` 释放。S3-compatible 后端已通过受控协议与故障测试；AWS S3、Cloudflare R2
  等真实云厂商认证属于可选后续验证，部署到具体服务前应先使用专用非生产 bucket 自行验证。

完整状态见[兼容性矩阵](./COMPATIBILITY.md)，版本选择见[发行版选择指南](./EDITIONS.md)，部署安全边界见
[生产部署](./DEPLOYMENT.md)、[请求保护](./REQUEST_PROTECTION.md)和[健康检查](./HEALTH.md)。更新可执行
文件后如果提示项目数据格式较旧，按[升级与回滚](./UPGRADING.md)执行离线预检、备份和升级；运行异常见
[故障排查](./TROUBLESHOOTING.md)。
