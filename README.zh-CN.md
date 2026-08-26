# Minibase

<p align="center">
  <img src="./assets/minibase-logo.png" alt="Minibase logo" width="220">
</p>

[English](./README.md) | [简体中文](./README.zh-CN.md)

**在不携带整套 Supabase 本地栈的前提下，用几分钟把已有 Supabase 项目部署到自己的服务器。**

Minibase 是一个紧凑的 Supabase-compatible 部署运行时。它直接读取已有项目中的
`supabase/migrations`、`supabase/seed.sql`、`supabase/functions` 和
`supabase/config.toml`，通过一个发行包提供常用的 Database、Auth、REST、Storage 与 Edge Functions
API。应用继续使用 `supabase-js`；正常迁移工作只应包括修改服务地址和密钥，以及处理 `doctor`
找出的、数量有限且有明确记录的项目不兼容项。

Minibase 不是 Supabase 全量服务的重新实现或重新打包。Realtime、Studio、Analytics、完整
PostgREST/GoTrue 行为、OAuth/MFA/SAML 以及任意 PostgreSQL Extension 不在当前范围内。它要解决的
问题，是用尽量小的迁移面和尽量简单的运维方式，自托管 Supabase 最常用的后端主链路。

## 目录

- [项目概览](#项目概览)
- [快速开始](#快速开始)
- [Minibase 提供什么](#minibase-提供什么)
- [选择 Edition](#选择-edition)
- [迁移现有项目](#迁移现有项目)
- [配置与运维](#配置与运维)
- [真实项目验收](#真实项目验收)
- [性能报告](#性能报告)
- [兼容边界](#兼容边界)
- [从源码开发](#从源码开发)
- [文档索引](#文档索引)
- [许可证](#许可证)

## 项目概览

- 直接复用已有 Supabase 项目，不改写 migration、seed 或 Function 源码；
- 保留普通 `supabase-js` 的 Auth、REST、Storage 与 Functions 请求路径；
- Embedded 内置 PGlite，Server 内置或连接外部 PostgreSQL 18.4；
- 生产运行不依赖 Docker、Node.js、Supabase CLI 或单独安装 Deno；
- 启动前检查已知 SQL、Extension、Function、配置和双引擎不兼容项；
- 生成状态只写入 `.minibase/`，与 `supabase/` 源码树隔离。

## 快速开始

从至少包含 `supabase/config.toml` 的项目根目录开始。Migration、`seed.sql` 与 Functions 均可缺省：

```text
your-project/
  supabase/
    config.toml
    migrations/
    seed.sql
    functions/
```

下面四种方式都会先运行 `doctor`，再以前台进程启动 Minibase。默认地址为
`http://127.0.0.1:54321`，就绪检查为 `GET /health/ready`。

### EXE：Embedded / PGlite

把 `minibase-embedded-windows-x64.exe` 放入项目目录后运行：

```powershell
.\minibase-embedded-windows-x64.exe doctor --project . --engine pglite
.\minibase-embedded-windows-x64.exe start --project . --engine pglite
```

这是部署面最小的方式：PGlite 和 Function Runtime 均已包含，不需要数据库服务。

### EXE：Server / PostgreSQL

把 `minibase-server-windows-x64.exe` 放入项目目录后运行：

```powershell
.\minibase-server-windows-x64.exe doctor --project . --engine postgres
.\minibase-server-windows-x64.exe start --project . --engine postgres
```

Server EXE 会释放并管理内置 PostgreSQL 18.4 Runtime。若要连接已有 PostgreSQL，启动前设置
`MINIBASE_DATABASE_URL`。Linux 和 macOS 参数相同，只需换成对应发行文件名，并先执行
`chmod 755 <binary>`。

### 源码：Embedded / PGlite

安装仓库固定的 Deno 版本，克隆本仓库，并让 `--project` 指向 Supabase 项目：

```powershell
deno run -A src/main.ts doctor --project C:\apps\your-project --engine pglite
deno run -A src/main.ts start --project C:\apps\your-project --engine pglite
```

### 源码：Server / PostgreSQL

源码模式不内嵌发行版数据库包，可直接连接一个准备好的 PostgreSQL 数据库：

```powershell
$env:MINIBASE_DATABASE_URL = "postgres://minibase:password@127.0.0.1:5432/minibase"
deno run -A src/main.ts doctor --project C:\apps\your-project --engine postgres
deno run -A src/main.ts start --project C:\apps\your-project --engine postgres
```

也可以把 `MINIBASE_POSTGRES_RUNTIME_DIR` 指向已审计的 PostgreSQL 18.4 Runtime 根目录，并省略
`MINIBASE_DATABASE_URL`，由源码模式管理该本地 Runtime。

在另一个终端确认就绪，并检查或停止运行时：

```powershell
Invoke-WebRequest http://127.0.0.1:54321/health/ready
.\minibase-embedded-windows-x64.exe status --project . --engine pglite --json
.\minibase-embedded-windows-x64.exe stop --project . --engine pglite
```

源码模式把最后两条命令中的 EXE 替换为 `deno run -A src/main.ts`。公网地址、密钥、冒烟测试与生产部署
设置见[迁移现有项目](#迁移现有项目)。

应用继续通过同一套 Supabase 客户端 API 连接。用于本地开发时，client key 只需是非空客户端标识；用户
登录后，`supabase-js` 会携带 Minibase access token 完成 RLS 查询和受保护 Function 调用：

```ts
import { createClient } from "@supabase/supabase-js";

const supabase = createClient("http://127.0.0.1:54321", "minibase-local", {
  auth: { persistSession: false },
});

const { data, error } = await supabase.auth.signInWithPassword({
  email: "alice@example.com",
  password: "correct horse battery staple",
});
if (error) throw error;
console.log(data.user);
```

## Minibase 提供什么

| 模块             | 当前能力                                                                                         |
| ---------------- | ------------------------------------------------------------------------------------------------ |
| Migration / Seed | 按时间戳执行 SQL、SHA-256 历史、事务失败恢复、首次启动执行 `seed.sql`                            |
| Database         | 常见 PostgreSQL SQL、JSONB、PL/pgSQL trigger、外键、policy、`auth.uid()`、`auth.role()` 与 RLS   |
| Auth             | 注册、密码/匿名登录、用户、session、refresh、更新、退出、基础 Admin 与 JWKS                      |
| REST             | 常见增删改查、upsert、过滤、关系、计数、range/order、schema header 与 RLS                        |
| Storage          | 本地或 S3-compatible 对象、bucket、上传/下载/删除/列表、signed/public URL、流式处理与修复        |
| Edge Functions   | `Deno.serve`、默认 Fetch export、Deno 配置/lockfile、JWT、CORS、worker、日志、出站策略与 OpenAPI |
| Operations       | `doctor`、双引擎 migration 检查、健康检查、结构化日志、备份恢复、升级、修复与密钥轮换            |

请求继续使用熟悉的 Supabase 路径：

| 路径                              | 能力                                     |
| --------------------------------- | ---------------------------------------- |
| `/auth/v1/*`                      | Auth 与 session API                      |
| `/rest/v1/*`                      | REST、PostgreSQL 查询与 RLS              |
| `/storage/v1/*`                   | Storage API                              |
| `/functions/v1/<name>`            | Edge Functions                           |
| `/functions/v1/docs`              | 自动生成的 Function 文档与 Try it 控制台 |
| `/functions/v1/docs/openapi.json` | 自动生成的 OpenAPI 3.0.3 规格            |
| `/health/live`、`/health/ready`   | 存活与流量就绪状态                       |

Function 响应支持普通 JSON 和 OpenAI-compatible SSE 流；Storage 默认使用本地文件，也可切换为
S3-compatible Storage 后端。

所有上层 API 只有一套实现，两个 Edition 只替换数据库适配器：

```mermaid
flowchart LR
  App["应用 / supabase-js"] --> API["Minibase API gateway"]
  Project["现有 supabase/ 项目"] --> Migrate["Migration 与 seed runner"]
  Project --> Functions["Deno Function workers"]
  API --> Auth["Auth"]
  API --> REST["REST 与 RLS"]
  API --> Storage["Storage"]
  API --> Functions
  Auth --> DB["DatabaseEngine"]
  REST --> DB
  Storage --> DB
  Migrate --> DB
  DB --> PGlite["Embedded: PGlite"]
  DB --> Postgres["Server: PostgreSQL 18.4 或外部 PostgreSQL"]
  Storage --> Objects["本地文件或 S3-compatible Storage"]
```

运行数据隔离在 `.minibase/` 中；Minibase 不会把生成状态写进 `supabase/` 源码目录。

## 选择 Edition

| 维度              | Embedded                                          | Server                                                   |
| ----------------- | ------------------------------------------------- | -------------------------------------------------------- |
| 数据库            | 内置 PGlite                                       | 内置 PostgreSQL 18.4 或外部 PostgreSQL                   |
| 适合场景          | 评估、本地开发、桌面应用、个人服务、NAS、中低并发 | 普通服务器、团队服务、持续并发写入、原生 PostgreSQL 运维 |
| 写入并发          | 一个 PGlite Worker 保护事务                       | PostgreSQL 连接池与后端并行执行                          |
| PostgreSQL TCP    | 不提供                                            | 托管数据库默认只监听回环地址；外部数据库由管理员维护     |
| Extension         | 仅限固定 PGlite 发行版已验证能力                  | 取决于内置或外部 PostgreSQL 的实际安装                   |
| 应用 API/项目布局 | 相同                                              | 相同                                                     |

追求最小部署时先用 Embedded；普通多用户服务、较高写并发、PostgreSQL 工具/TCP、逻辑复制或特定
Extension 则使用 Server。PGlite 与 PostgreSQL 物理数据目录不能互换，切换 Edition 需要逻辑备份和
恢复。详见 [Edition 选择](./docs/EDITIONS.md)。

## 迁移现有项目

### 1. 保留 Supabase 项目布局

```text
your-project/
  supabase/
    config.toml
    migrations/
    seed.sql
    functions/
```

Migration、seed 和 Functions 均可单独缺省；Minibase 不会通过转换步骤改写它们。

### 2. 放入发行版

从发行包选择 `minibase-embedded-<platform>` 或 `minibase-server-<platform>`。两个 Edition 都包含
Deno，Server 还包含已审计的 PostgreSQL Runtime。生产运行不要求 Docker、Node.js、Supabase CLI
或另外安装 Deno。在 Linux/macOS 上先授予执行权限：

Windows x64 发行文件名为 `minibase-embedded-windows-x64.exe` 和 `minibase-server-windows-x64.exe`。

```sh
chmod 755 ./minibase-server-linux-x64
```

### 3. 写入数据前检查兼容性

```sh
./minibase-server-linux-x64 doctor --project .
./minibase-server-linux-x64 migration check --project .
```

`doctor` 检查项目布局、配置、migration、Function 入口和依赖、数据库能力、Storage 与已知不兼容项；
`migration check` 在隔离的 PGlite 和 PostgreSQL 数据库中实际执行 migration。退出码 `0` 表示允许
启动，退出码 `2` 表示存在必须检查的兼容或安全问题。

### 4. 配置服务地址与密钥

Supabase-compatible 配置继续放在 `supabase/config.toml`；Minibase 专属配置放进 `minibase.toml`，
密钥放进受保护的 Secret 文件或环境变量。

```toml
format_version = 1

[server]
host = "0.0.0.0"
port = 54321
public_url = "https://api.example.com"

[server.cors]
allowed_origins = ["https://app.example.com"]

[database]
engine = "postgres"
```

把应用的 Supabase URL 改为 `public_url`，并提供 Minibase client key。原有 Function 仍然读取
`SUPABASE_URL`、`SUPABASE_ANON_KEY` 和 `SUPABASE_SERVICE_ROLE_KEY`；Minibase 会依据 Function 策略
注入当前值。不要提交 `.minibase/secrets.json`、数据库凭据或 service-role key。

### 5. 启动并验收

```sh
./minibase-server-linux-x64 start --project .
./minibase-server-linux-x64 status --project . --json
curl --fail http://127.0.0.1:54321/health/ready
```

进入 ready 后还要运行应用的真实冒烟链路，不能只看健康检查。该中型项目的验收路径是：注册 -> 登录 ->
调用 `create_workflow` -> 查回写入行 -> 验证 RLS 拒绝。

客户端代码保持普通 Supabase 写法：

```ts
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  "https://api.example.com",
  process.env.SUPABASE_ANON_KEY!,
);

const { data, error } = await supabase.functions.invoke("create_workflow", {
  body: { name: "First workflow", icon: "workflow", workflow: {} },
});
if (error) throw error;
```

公开部署时，应由 Minibase 或可信反向代理终止 TLS，设置准确的 `public_url`，限制 CORS 和可信代理，
保护 Secret 文件，配置 Function 出站策略，并演练备份恢复。详见
[生产部署](./docs/DEPLOYMENT.md)与[安全模型](./docs/SECURITY.zh-CN.md)。

## 配置与运维

配置优先级依次为 CLI 参数、环境变量、Secret 文件、`minibase.toml`、`supabase/config.toml`、默认值。
最小本地配置如下：

```toml
format_version = 1

[server]
host = "127.0.0.1"
port = 54321
public_url = "http://127.0.0.1:54321"

[database]
engine = "pglite"

[storage]
driver = "local"

[functions.network]
outbound = "allow"
allow_supabase_url = true
block_private_networks = false
```

Storage 可使用项目内的 `.minibase/storage/`，也可切换到 S3-compatible 后端。Function 出站支持
`allow`、`allowlist` 和 `deny`；公开部署通常应采用 allowlist，并设置
`block_private_networks = true`。

| 命令                                       | 用途                                                 |
| ------------------------------------------ | ---------------------------------------------------- |
| `start` / `stop` / `status`                | 控制并检查运行时                                     |
| `doctor`                                   | 在启动前检查项目、数据库、Storage 与 Function 兼容性 |
| `migration check`                          | 在隔离的 PGlite/PostgreSQL 数据库中执行 migration    |
| `backup export` / `backup restore`         | 逻辑数据库备份，可选包含 Storage                     |
| `reset --force` / `upgrade`                | 先做安全备份，再重建或升级数据格式                   |
| `functions cache` / `functions logs`       | 准备依赖并查看持久 Function 日志                     |
| `storage check` / `storage repair --force` | 检查或修复元数据/对象一致性                          |
| `auth keys list/rotate/activate/remove`    | 在不输出私钥的前提下维护 ES256 签名密钥              |
| `version --json`                           | 输出稳定、机器可读的构建和 Runtime 身份              |

破坏性命令要求服务已停止、目标已校验，并在需要时显式提供 `--force`。托管数据库默认只监听回环地址。

## 真实项目验收

2026-08-26 的严格验收使用一个已经完成、基于 Supabase 的中型项目隔离副本，不是为测试定制的 demo；
原始项目目录未被修改。

| 验收输入            |                                              实测值 |
| ------------------- | --------------------------------------------------: |
| 源码/配置基线       |                                          279 个文件 |
| SQL migration       |                                               18 个 |
| Edge Function 目录  |                   73 个（`config.toml` 注册 71 个） |
| Public schema       |            10 张表、16 条 policy、7 张启用 RLS 的表 |
| 安装到 ready        |                        **68,694.41 ms / 1.145 min** |
| 验收后源码/配置变更 |                              **0 个修改、0 个删除** |
| Readiness           | Database、migrations、Storage、Functions 全部 ready |

计时从把 Minibase Embedded 可执行文件复制进干净的项目副本开始，到 `GET /health/ready` 返回 HTTP 200
结束。源码完整性检查对 `supabase/**`、`.env`、`deno.lock`、README 和项目配置逐一比较
SHA-256。运行状态与自动生成的 Auth 密钥只写入 `.minibase/`，实验结束后已删除。

| 工作流             | 结果                      | 验证内容                                      |
| ------------------ | ------------------------- | --------------------------------------------- |
| 邮箱注册、密码登录 | PASS                      | HTTP 200，用户身份一致                        |
| CRUD               | PASS（service-role 路径） | insert/select/update/delete = 201/200/200/204 |
| RLS 隔离           | PASS                      | 未获得表授权的 authenticated 访问返回 403     |
| Storage            | PASS（service-role 路径） | bucket、上传、下载及内容校验                  |
| `wf_echo`          | PASS                      | GET/POST 均为 200，响应内容一致               |
| `create_workflow`  | PASS                      | Function 返回成功，并从数据库查回写入行       |

两次 authenticated 直接请求返回 403，是因为该中型项目没有妥善设计授权：表 grant 及其对应的
RLS/Storage Policy 未允许 authenticated 直接写入。这是该项目自身明确记录的 Policy 缺陷，不是
Minibase 兼容失败。预期的 service-role Function 路径成功，RLS 同时阻止了越权读取。本轮并不声称 71 个
Function 和全部第三方服务都已逐一运行。

测试主机为 Windows 11、Intel Core Ultra 7 265K（20 logical CPU）、32 GiB RAM、Deno 2.9.2。结果相对
15 分钟门槛有充分余量，但它仍然只代表一台机器；实际服务器上线前仍应运行 `doctor`、全新启动和
应用自身的冒烟工作流。

## 性能报告

这里使用两组互补数据。固定机器基准用同一个小型兼容项目比较启动和资源；真实项目基准则在三个后端上
运行该中型项目完全相同的代表性写入 Function 与 JSON 请求。两组数据回答不同问题，不能混为一个排名。

### 本地从零到 ready

固定测试机为 Windows 11、Intel Core Ultra 7 265K、20 logical CPU、32 GiB RAM。Minibase 报告采用 20
次正式采样、5 次预热、并发 1/10/50/100 各 100 个请求，并每 500 ms 采集一次进程树 RSS。Supabase
报告使用 Supabase CLI 2.110.0、Docker Desktop 4.43.2 / Engine 28.3.2、PostgreSQL
17.6.1.143、相同业务负载和运行中容器 working set。

| 本地后端                          | 全新项目冷启动 | 保留数据热启动 |               空闲应用内存 | 运行形态                                          |
| --------------------------------- | -------------: | -------------: | -------------------------: | ------------------------------------------------- |
| Minibase Embedded / PGlite        |    **3.177 s** |    **0.872 s** |              291.6 MiB RSS | 一个 Minibase 进程及 Function workers             |
| Minibase Server / PostgreSQL 18.4 |    **5.895 s** |    **0.959 s** |        74.9 MiB 进程树 RSS | Minibase 与托管 PostgreSQL                        |
| Supabase 本地栈                   |   **31.012 s** |   **23.569 s** | 467.5 MiB 容器 working set | DB/Auth/REST/Storage/Functions/网关等 Docker 服务 |

Server 冷启动包含第一次 `initdb`，其中初始化为 4.326 秒。Supabase 对比主动排除了 Realtime、
Studio、Analytics/日志、imgproxy、邮件界面、postgres-meta、Vector 和 Supavisor，因此表格比较的是
Minibase 实际覆盖的服务，不代表 Supabase 全部能力。Docker 容器 working set 与原生进程树 RSS
不是完全相同的记账方式，且数据未包含 Docker Desktop 共享 VM 的额外开销。

在这组受控负载中，Minibase/PGlite 的热启动耗时比相同范围的 Supabase 本地栈低 96.3%，测得的空闲
应用内存低 37.6%。但 Supabase 在小型 CRUD/RLS 请求 P95 中位数上更快（2.852 ms 对 3.726 ms），
因此这组证据支持 Minibase 的启动速度和运维体积定位，不支持“所有请求延迟都更快”的泛化结论。

原始证据：[Minibase/PGlite](./benchmarks/supabase/minibase-windows-lab-01/minibase.json)、
[Supabase 本地栈](./benchmarks/supabase/minibase-windows-lab-01/supabase.json)、
[对比结论](./benchmarks/supabase/minibase-windows-lab-01/comparison.json)，以及
[固定机器 PGlite](./benchmarks/fixed/minibase-windows-lab-01/current/pglite.json)与
[PostgreSQL](./benchmarks/fixed/minibase-windows-lab-01/current/postgres.json)原始报告。完整口径见
[性能与回归证据](./docs/PERFORMANCE.md)。

### 中型项目 `create_workflow` 负载

三行数据使用同一台主机、同一份 Function 源码、同一个 JSON body，并从客户端发起 HTTP 请求计时到
响应完成。每个后端先预热 5 次，再顺序采样 40 次，随后以并发 10 运行 5 批，共 50 个请求。请求耗时
包含 gateway、Function、Auth 校验和数据库写入，不包含首次依赖下载和服务启动。

| 后端                            |      平均值 |         P50 |          P95 |          P99 |    并发 10 吞吐 | 并发平均延迟 |
| ------------------------------- | ----------: | ----------: | -----------: | -----------: | --------------: | -----------: |
| Minibase + PGlite               |    10.95 ms |    10.81 ms |     12.07 ms |     12.76 ms |      57.5 req/s |     149.5 ms |
| Minibase + PostgreSQL           | **9.20 ms** | **8.94 ms** | **10.15 ms** | **12.32 ms** | **171.0 req/s** |  **42.2 ms** |
| Supabase 本地栈（完整项目副本） |    33.02 ms |    32.89 ms |     35.09 ms |     35.69 ms |     147.6 req/s |      61.4 ms |

PGlite 不需要外部数据库，对该工作流已经完全够用。托管 PostgreSQL 的顺序 P50 比 PGlite 低 17.3%，
并发吞吐约为 PGlite 的 2.97 倍，因此持续并发写入场景更适合 Server。若应用依赖 Minibase 未实现的
Supabase 服务，则应继续选择官方 Supabase 本地栈。

官方 Supabase 对比副本需要两项明确记录的兼容处理：它扫描全部 Function 时会从一条注释 import
继续寻找缺失的本地模块，因此补了一个占位文件；同时显式加入
`GRANT ALL ON public.workflow TO service_role`。Minibase 不需要这两项源码变更，其 bootstrap 已提供
预期的 service-role 表访问路径。上述结果只适用于这台机器和这个轻量 JSON workflow，不能外推为所有 SQL
负载或生产网络下的通用排名。

## 兼容边界

可追溯兼容目标为 Supabase CLI 2.110.0 项目布局、`supabase-js` 2.110.9，以及在双引擎验证的
`@supabase/server` 1.4.1 Context 子集。完整范围见 [Supabase 兼容性矩阵](./docs/COMPATIBILITY.md)。

当前不包含：

- Realtime 协议、broadcast 与 presence；
- Studio、Analytics、Logs Explorer 和完整 Supabase 管理面；
- 完整 PostgREST/GoTrue 等价性、OAuth provider、MFA、SAML、CAPTCHA 与托管邮件投递；
- 任意 PostgreSQL Extension；固定 PGlite 发行版尤其不提供 PostgreSQL TCP、逻辑复制、PostGIS、
  `pgcrypto` 或 `uuid-ossp`；
- 把 PGlite 物理数据目录自动转换成 PostgreSQL；
- 面向互不信任 Function tenant 的操作系统级安全沙箱。

Minibase 会报告不支持的行为，而不是静默改写 SQL 语义。依赖未列出的 Supabase/PostgreSQL 行为时，
必须先运行 `doctor` 与 `migration check`，再以项目自己的端到端冒烟测试完成迁移验收。

## 从源码开发

源码工具链固定在 `deno.json` 与 `toolchain.json` 中：

```sh
deno task fmt:check
deno task lint
deno task check
deno task test
deno task verify:baseline
```

`benchmarks/` 保存固定机器回归数据和双引擎 30 分钟 soak 证据；每个引擎均完成 1,787 个循环、16,113
次操作且零失败。Rust/WASM 原生优化受真实性能分析门禁约束，目前不是产品组成部分。

## 文档索引

- [快速开始](./docs/GETTING_STARTED.md)
- [生产部署](./docs/DEPLOYMENT.md)
- [Supabase 兼容性矩阵](./docs/COMPATIBILITY.md)
- [性能测试方法与证据](./docs/PERFORMANCE.md)
- [Embedded 与 Server](./docs/EDITIONS.md)
- [安全模型](./docs/SECURITY.zh-CN.md)
- [故障排查](./docs/TROUBLESHOOTING.md)
- [升级指南](./docs/UPGRADING.md)
- [版本与支持策略](./docs/VERSIONS.md)

## 许可证

Minibase 使用 [Apache License 2.0](./LICENSE) 开源。发行包会保留 Deno、PGlite、PostgreSQL、
OpenSSL、ICU 及其他第三方组件适用的许可证与声明。
