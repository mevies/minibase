# Minibase 生产部署指南

Minibase 当前面向单机、自托管和可信代码场景。本指南描述 Windows x64 与 Linux x64 的 Embedded/Server
发行版生产部署边界；它不把本地 Function Runtime 声明为不可信多租户沙箱，也不把未运行的真实云厂商 S3
认证写成已完成结论。

## 1. 选择发行版与目录

- Embedded 使用 Windows 的 `minibase-embedded-windows-x64.exe` 或 Linux 的
  `minibase-embedded-linux-x64` 和 PGlite，适合单机、中低并发和不需要数据库 TCP 的场景。
- Server 使用 Windows 的 `minibase-server-windows-x64.exe` 或 Linux 的
  `minibase-server-linux-x64`，默认释放并运行固定 PostgreSQL 18.4 Runtime，也可通过
  `MINIBASE_DATABASE_URL` 连接外部 PostgreSQL。
- 可执行文件、项目源码、`.minibase/` 数据和备份应位于受控的本地磁盘；不要把正在运行的数据目录放在
  会进行按需下载、双向同步或非原子重命名的网络盘/云盘中。
- 服务账户必须对项目根目录和 `.minibase/` 拥有读写权限，但不应获得无关用户目录或系统目录权限。
  `.minibase/secrets.json`、外部 Secrets 文件和备份只授予服务账户与管理员访问。

两个版本的详细选择和逻辑迁移流程见[发行版选择](./EDITIONS.md)，数据格式升级见
[升级与回滚](./UPGRADING.md)。

## 2. 发布文件验真

每次部署必须把以下文件作为一个不可拆分的发行集合保存：

- 对应 edition 和平台的可执行文件；
- `<artifact>.sha256`；
- `release-manifest.json`；
- `THIRD_PARTY_LICENSES.txt`。

先校验 SHA-256，再运行：

```powershell
.\minibase-embedded-windows-x64.exe version --json
```

Linux x64 使用：

```sh
chmod 755 ./minibase-embedded-linux-x64 # 或 ./minibase-server-linux-x64
./minibase-embedded-linux-x64 version --json
```

`release-manifest.json` 记录源码提交、版本、产物体积和 SHA-256、Deno Runtime、可选 PostgreSQL
Runtime
及许可证文件哈希。集中说明见[第三方许可证索引](./THIRD_PARTY_LICENSES.md)。不要从其他发行目录混用
EXE、manifest 或许可证文件。

## 3. 启动前预检

在与正式服务相同的账户和环境变量下运行：

```powershell
.\minibase-embedded-windows-x64.exe doctor --project C:\apps\my-project --json
```

只有退出码为 `0` 时才继续。Doctor 会检查项目布局、数据目录、端口、Migration、Function 入口和离线
依赖缓存、数据库、Storage、Secrets 与已知兼容边界。部署前还应离线创建逻辑备份：

```powershell
.\minibase-embedded-windows-x64.exe backup export `
  --project C:\apps\my-project --engine pglite `
  --output C:\backups\my-project\pre-deploy --include-storage
```

Server 将 `--engine` 改为 `postgres`。备份目录必须位于项目数据目录之外，并进入独立的保留、加密和恢复
演练流程。

## 4. 监听、TLS 与反向代理

默认只监听 `127.0.0.1`。推荐让 Minibase 保持回环监听，由同机反向代理终止公网 TLS。只有明确需要
直接监听网卡时才设置 `MINIBASE_HOST`，并同时设置：

- `MINIBASE_PUBLIC_URL`：客户端实际访问的 HTTPS Origin；
- `MINIBASE_CORS_ALLOWED_ORIGINS`：精确允许的浏览器 Origin；
- `MINIBASE_TRUSTED_PROXIES`：仅填写实际反向代理 IP 或 CIDR；
- `MINIBASE_TLS_CERT_FILE` 与 `MINIBASE_TLS_KEY_FILE`：选择直接 TLS 时必须成对配置。

不要使用通配 CORS 代替来源清单，不要把客户端可控的转发头视为可信。请求体、超时和并发上限见
[请求保护](./REQUEST_PROTECTION.md)。托管 PostgreSQL 仍只监听本机；开放 API 地址不会自动开放数据库
端口。

## 5. Secrets 与出站访问

数据库 URL、S3 凭据和 Auth 外部 Secret 应放入受限环境变量或独立 Secrets 文件，不要提交到项目仓库。
Function 的根 `.env` 与 `supabase/functions/.env` 属于用户代码输入，也必须按 Secret 文件保护。

公开 Function 应设置 `inject_service_role_key = false`。生产环境应按函数使用 allowlist 或 deny
出站策略，必要时开启私网阻断；默认 allow 只适合可信的现有 Supabase Function。Auth
密钥轮换与权限要求见 [Auth 密钥](./AUTH_KEYS.md)、[Auth 安全](./AUTH_SECURITY.md)和
[安全模型与威胁边界](./SECURITY.md)。

## 6. 进程生命周期与健康检查

Minibase 是前台进程；使用能保留 stdout/stderr、传递正常终止信号并设置有界重启策略的服务管理器运行。
不要通过无条件循环掩盖持续启动失败。启动后依次检查：

```text
GET /health/live
GET /health/ready
```

只有 `/health/ready` 返回 `200` 才接入流量；`503` 表示数据库、Migration、Storage 或 Functions
至少一项未就绪。关闭优先使用
`minibase stop --project <path>`，并等待进程退出后再做离线备份、恢复、升级或 Storage
修复。探针契约见[健康检查](./HEALTH.md)。

## 7. 日志、监控与容量

- 收集控制台结构化日志以及 `.minibase/logs/`，但不要把日志目录放进公开静态文件服务。
- 为进程退出、ready 变为 503、磁盘空间、备份失败、认证限流和持续 5xx 建立告警。
- 设置日志轮换和保留量，见[日志](./LOGGING.md)。
- Embedded 的数据库事务由单个 PGlite Worker 串行保护；高并发或需要数据库连接时选择 Server。
- Functions 每函数默认最多 2 个 Deno 进程；提高 `workers_per_function` 会增加首次扩容耗时和内存。
- 容量规划应使用已提交的固定 runner 基线和自身工作负载复测，不能把一次开发机耗时或尚未完成的
  Supabase Docker 对比当作容量承诺，口径见[性能](./PERFORMANCE.md)。

Server 启动时会通过独立的 `minibase-ownership` PostgreSQL 控制连接获取当前数据库的 session advisory
lock。同一个 PostgreSQL 数据库同一时间只允许一个 Minibase writer；第二个实例会在 Migration 和
Storage 恢复开始前拒绝启动。控制连接不占用 `database.pool_min` / `database.pool_max`
的业务连接额度，因此实际数据库连接预算应在业务池之外额外预留 1 个连接。

控制会话或 advisory lock 的丢失一旦被心跳检测，原实例会失败关闭数据库操作且不会自动重新获取；健康
检查会变为未就绪，必须排查连接中断并重启实例。

S3-compatible 后端还会在 root bucket 中维护内部 `.minibase/ownership-v1.json`。首次 writer 使用
`If-None-Match: *` 创建控制对象，后续心跳、正常释放和接管已释放对象全部使用当前 ETag 的 `If-Match`。
因此连接不同数据库或不同 PostgreSQL 集群、但共享同一 root bucket 的 Minibase 也只能有一个 writer。
控制对象不会出现在用户对象 list、逻辑备份、reset 快照或一致性修复中。条件更新失败后原实例的 S3
写入返回 503，Storage readiness 也变为失败；它不会自动重新获取 ownership。

崩溃遗留的 `active` 控制对象不会按时间自动抢占，以免暂停的旧进程在租约过期后恢复写入。只有确认所有
使用该 root bucket 的 Minibase writer 都已停止后，才可执行：

```powershell
.\minibase-server-windows-x64.exe storage unlock `
  --project C:\apps\my-project --force --json
```

误用 `storage unlock --force` 会主动破坏另一实例的 ownership；该命令属于人工 fencing 恢复边界。

可选的真实 AWS S3/R2 兼容性证据必须使用专用空 bucket，不能指向生产数据或与其他 Minibase
项目共享。手动 workflow 在任何远端写入前执行完整仓库门禁；probe 发现可见对象或活动 ownership
时会在业务对象变更前 失败。成功运行只创建随机前缀对象和 ownership
控制对象，并在报告落盘前完成数据/临时对象删除、handoff 和可见对象清空复核；最终保留 `released`
ownership 控制记录，由下一轮以 ETag 条件替换，禁止无条件删除 可能已被新 writer
接管的控制对象。Access Key/Secret 仅通过受保护的 GitHub environment Secret
或当前进程环境提供，报告和 artifact 不包含这些值。原始报告验证后使用 `deno task s3:evidence:promote`
进入 `evidence/s3/<runner-id>`，默认 `deno task check` 会重新验证配对
provider、commit、runner、工具链、校验和及全部行为检查。

这项云厂商认证不是当前本地自托管发行的前置条件；未提供凭据时不得伪造报告，部署方应先在非生产 bucket
自行验证目标 S3-compatible 服务，再迁移实际数据。

## 8. 备份、升级与恢复演练

生产计划至少包括：定期逻辑备份、周期性 `--include-storage`、离机副本、保留策略和实际恢复演练。升级
前停止服务，运行 Doctor，保存备份，再运行受支持的 `upgrade` 流程。不要手工修改
`.minibase/project.json`、数据库目录或备份 manifest。

S3 reset 必须在项目停止的维护窗口执行，并会先获取相同的 root bucket ownership。它会把数据库物理目录
和除 ownership 控制对象外的全部原始 key 流式保存到本地 reset backup，记录对象大小、MIME 与 SHA-256，
删除前再次核对清单；部分删除或 migrations/seed 重建失败时会自动恢复并逐对象验证。其他数据库或集群的
writer 持锁时 reset 会在远端删除前失败。manifest 明确声明数据库、Storage 和 Secret 均为只读的 format
v1→v2 metadata-only upgrade 可用于 S3，且不会访问远端对象。未来 Storage 写入步骤会在 root ownership
下流式生成并二次复核整体远端快照，失败时逐对象恢复；回滚不完整会保留升级备份并失败关闭。 外部
PostgreSQL 的未来数据库写入步骤没有事务或快照时仍会拒绝。这些边界不能通过删除状态文件绕过。
故障处理见 [故障排查](./TROUBLESHOOTING.md)。

## 9. 上线检查表

- [ ] 发行 SHA-256、manifest 和许可证文件一致。
- [ ] 使用正式服务账户执行 Doctor 且退出码为 0。
- [ ] 已创建并恢复验证当前版本的备份。
- [ ] 仅开放必要的 API 监听，TLS、CORS 和可信代理为精确配置。
- [ ] Secrets 不在仓库、命令行历史、日志或可下载目录中。
- [ ] `/health/live` 与 `/health/ready` 已接入不同语义的探针。
- [ ] 日志、磁盘、备份、ready 和 5xx 告警已经启用。
- [ ] 已阅读[兼容性矩阵](./COMPATIBILITY.md)中的实验性与不支持能力。
- [ ] 已按[安全模型与威胁边界](./SECURITY.md)确认可信代码、CSRF、SSRF、Service Role 和多实例边界。
