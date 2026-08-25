# Minibase 安全模型与威胁边界

[English](./SECURITY.md) | [简体中文](./SECURITY.zh-CN.md)

Minibase 面向单机、自托管和可信 Supabase 项目代码。当前安全目标是保护同一项目的数据、身份、Secret、
Storage 和运行时边界，抵抗不可信远程请求、恶意输入、伪造代理头、常见凭据泄漏、路径穿越、SQL 注入与
受限范围内的 SSRF。它不是不可信多租户 Function 平台，也不把项目 migration、seed 或 Function 当作
敌对代码。

## 1. 安全前提

以下主体属于可信计算基：

- 运行 Minibase 的主机、操作系统、服务账户和管理员；
- 项目的 `supabase/migrations`、`supabase/seed.sql`、`supabase/functions` 与显式配置；
- 配置的 TLS 终止代理、外部 PostgreSQL、S3-compatible 服务和 Secret 管理系统；
- 官方发行集合中的 EXE、`release-manifest.json`、SHA-256 文件和许可证清单。

以下输入必须视为不可信：

- 远程客户端的 URL、Header、JWT、JSON、multipart、流式正文和断开行为；
- 未经验证的 `Forwarded`、`X-Forwarded-*`、Origin 和客户端 IP；
- Auth 用户可写字段、REST 标识符/Filter、Storage bucket/object 名和用户 metadata；
- S3、外部 PostgreSQL、代理和外部 HTTP API 返回的错误正文；
- Function 访问的 DNS 结果、重定向目标和远程响应。

若多个互不信任的租户可以修改 Function、migration、seed、项目 `.env` 或 `minibase.toml`，当前模型不再
成立。此类场景需要独立操作系统身份、容器/虚拟机、每请求执行单元或等价的强隔离。

## 2. 需要保护的资产

- PGlite/PostgreSQL 数据、RLS 身份上下文和 migration 历史；
- 本地或 S3 Storage 正文、metadata、恢复 journal 和一致性状态；
- Auth 私钥、旧 HS256 Secret、Service Role Token、Refresh Token 和 Session；
- 外部 PostgreSQL URL、S3 凭据、Function Secrets 与代理凭据；
- 逻辑/物理备份、运行日志、诊断报告和升级状态；
- 版本化 Deno/PostgreSQL Runtime 缓存和最终发行产物。

## 3. 信任边界

```text
远程客户端
    |
TLS / 反向代理（可选且必须显式信任）
    |
Minibase 单一 HTTP listener
    |-- Auth / REST / Storage / Functions 网关
    |-- DatabaseEngine -> PGlite Worker 或 PostgreSQL
    |-- ObjectStore -> 本地文件系统或 S3-compatible 服务
    `-- FunctionManager -> 受限 Deno 子进程 -> 外部 HTTP(S)

管理员 / CI
    `-- CLI、项目目录、Secret、备份、发行 manifest 和 Runtime 缓存
```

所有带身份的数据库请求在请求级事务中设置 Role 与 JWT claims，结束时回滚或提交并清理上下文。REST
不会经内部 HTTP 或 PostgREST 子进程转发。Function 子进程与主进程分离，但同一 Function 进程仍可复用
处理多个可信请求；这不是严格的单请求沙箱。

## 4. 默认安全配置

| 边界              | 默认值            | 含义                                               |
| ----------------- | ----------------- | -------------------------------------------------- |
| API 监听          | `127.0.0.1:54321` | 默认不直接暴露局域网或公网                         |
| CORS Origin       | 空列表            | 浏览器预检默认返回 403；非浏览器请求仍需正常鉴权   |
| 可信代理          | 空列表            | 未受信任对端不能用转发头覆盖客户端 IP、协议或 Host |
| 请求体            | 64 MiB            | 声明和流式正文都受限                               |
| 请求超时          | 60 秒             | 超时会取消正文、Function 代理和可取消数据库工作    |
| 全局并发          | 256               | 响应完成前占用槽位，超过时返回 503                 |
| Auth 密码         | 12–256 字符       | 新密码拒绝控制字符并应用统一策略                   |
| Auth recent-auth  | 300 秒            | 修改邮箱或密码需要最近一次密码登录                 |
| Auth 限流         | 每进程启用        | 注册、密码、Refresh 和用户更新使用有界 IP/身份桶   |
| Function 进程     | 每函数 2 个       | 有界池、超时和崩溃回收；不是租户隔离边界           |
| Function 出站     | `allow`           | 为兼容现有 Supabase Function；生产部署应显式收紧   |
| Function 私网阻断 | `false`           | 生产环境应按拓扑评估后启用                         |
| Service Role 注入 | 默认启用          | 公开或无需管理权限的 Function 应显式关闭           |
| Storage           | 本地文件系统      | 默认不依赖 S3，路径限制在配置根目录内              |

默认值兼顾本地迁移兼容性，不等于所有生产拓扑的最小权限配置。上线前应按
[生产部署指南](./DEPLOYMENT.md)完成收紧。

## 5. 网络暴露、代理与客户端身份

- 默认回环监听；公网部署应优先由同机反向代理终止 TLS。
- `server.trusted_proxies` / `MINIBASE_TRUSTED_PROXIES` 只配置实际代理 IP 或 CIDR。Minibase 从右向左
  穿过可信代理链，选择第一个不可信地址；格式错误的协议、Host、端口或地址会失败关闭。
- 不在可信代理列表中的连接不能通过 `Forwarded` 或 `X-Forwarded-*` 伪造客户端 IP。限流和审计只使用
  规范化后的地址。
- 直接对外监听时必须配置 HTTPS、精确 Public URL、精确 CORS Origin 和入口层连接/带宽限制。
- 托管 PostgreSQL 默认只监听本机，PGlite 不暴露 PostgreSQL TCP。

## 6. CORS 与 CSRF

Minibase Auth、REST、Storage 和 Functions 使用显式 `Authorization: Bearer ...` 与 `apikey` Header，
服务端不创建认证 Cookie。因此浏览器不会自动附带 Minibase Session，常见 Cookie 型 CSRF 不在当前认证
协议中。CORS 默认没有允许的 Origin；允许列表只控制浏览器跨 Origin 调用，不是服务端授权机制。

必须遵守以下边界：

- 不要把 `*` 当作生产 Origin 清单；只允许实际前端 Origin。
- 不要因为请求通过 CORS 就跳过 JWT、RLS、Service Role 或 Storage Policy 检查。
- 如果反向代理或上层应用把 Token 转换成 Cookie，必须由该层增加 `SameSite`、`Secure`、`HttpOnly`、
  Origin/Referer 验证和 CSRF Token；Minibase 不为外部引入的 Cookie 会话提供隐式 CSRF 防护。
- 非浏览器客户端不受 CORS 约束，必须始终依赖鉴权、RLS、限流和请求边界。

## 7. Auth、授权与 Service Role

- 默认生成 ES256 keyring，公开 JWKS 只包含公钥；旧 HS256 Token 可按迁移策略继续验证。
- 密码、敏感字段、recent-auth、Session 撤销、Refresh 轮换和审计边界见
  [Auth 安全策略](./AUTH_SECURITY.md)与[Auth 密钥](./AUTH_KEYS.md)。
- 普通数据库请求只允许 `anon`、`authenticated` 或 `service_role`，并在事务内设置 Role 与 claims。
- `service_role` 会绕过 RLS，必须视为主密钥。公开 Function 应设置：

```toml
[functions.public-api]
inject_service_role_key = false
```

- Function 网关只根据已验证的调用身份规范化内部 Publishable/Secret Key；伪造 JWT 不会降级成更高
  权限身份。
- Auth 和 Function 限流器是单进程、有界内存实现，重启后重置，也不会跨多个 Minibase 实例协调。公网
  部署仍需反向代理、WAF 或网关级全局限流。

## 8. SQL、RLS 与输入处理

- REST、Auth、Storage 和系统查询对运行时值使用绑定参数；动态标识符通过统一引用函数处理，有限语法
  片段来自代码枚举。
- `deno task sql:check` 审计动态 SQL 边界；恶意标识符、Filter 和值在双引擎 fixture 中验证。
- migration 与 seed 是可信项目脚本，会原样执行。Minibase 不会静默重写不支持的 SQL；不兼容能力在
  执行前报告或明确失败。
- 每个身份请求使用事务级 Role/JWT 上下文；失败请求回滚，连接或 PGlite 队列不能把身份泄漏给后续请求。
- 请求体大小、复杂 Select、结果量、multipart 流和超时都必须保持有界，详见
  [请求入口保护](./REQUEST_PROTECTION.md)。

## 9. Storage 与文件系统

- bucket/name 会经过字符、空段、反斜杠、`..`、NUL 和解析后根目录关系检查；本地对象不能逃逸 Storage
  根目录。
- Storage metadata 仍通过数据库 RLS/Policy 授权；公开 bucket、Signed URL 和 Service Role 是显式
  例外，不因使用本地文件系统而跳过授权。
- 上传正文流式写入临时对象，数据库提交失败会补偿，崩溃恢复 journal 会在启动时回滚或完成切换。
- bucket 大小和 MIME 限制、全局请求体限制和磁盘空间错误共同约束上传。
- S3 endpoint 和响应属于外部信任边界。错误正文、凭据和签名不能进入客户端响应或普通日志。当前真实 AWS
  S3/R2/MinIO 双实现验收尚未完成。连接到同一个 PostgreSQL 数据库的第二个 Minibase writer 会被
  ownership advisory lock 拒绝；共享同一 S3 root bucket 的不同数据库/集群则通过内部控制对象的
  `If-None-Match` 获取和 `If-Match` 心跳/释放互斥。后端缺少 ETag 或不遵守 412 条件语义时失败关闭。

## 10. Edge Functions、SSRF 与 Secret 外泄

Function Runtime 使用独立 Deno 子进程、清空宿主环境，并仅注入 Minibase 内建变量、项目 Function
Secrets 和必要的系统/TLS/代理变量。读权限限制在 `supabase/`、版本化 cache 和显式证书路径；网络权限
根据项目与函数级策略求交集。

生产环境应从最小权限配置开始：

```toml
[functions.network]
outbound = "allowlist"
allowed_hosts = ["api.openai.com:443"]
allow_supabase_url = true
block_private_networks = true
```

也可用 `outbound = "deny"` 完全关闭外部网络。函数级策略只能保持或进一步收紧项目策略。私网阻断会检查
已知云元数据主机、IP/CIDR、DNS A/AAAA 结果和重定向目标；保留请求正文的 307/308 私网重定向会失败
关闭。代理环境仍需要单独限制代理可达范围。

残余风险必须明确：

- 默认 `functions.network.outbound = "allow"` 与 `block_private_networks = false`
  是兼容性默认值；不适合 未审计 Function。
- SSRF 强化覆盖标准 `fetch` 的 HTTP(S) 路径，不等同于操作系统级网络沙箱，也不承诺覆盖未来 Node
  兼容层、原始 Socket、FFI 或新增协议。
- 同一 Function 进程可以服务多个可信请求；超时和崩溃只回收命中的进程，不提供严格的每请求内存隔离。
- Function 可以主动把它获得的 Secret 发往允许的远端。日志脱敏只能减少意外记录，不能约束恶意可信
  代码；最小 Secret 注入和最小出站 allowlist 才是主要控制。

## 11. Secret、日志与诊断

- Minibase 管理的 Auth Secret 文件拒绝符号链接和非普通文件；Unix 收紧为 `0600`，Windows 仅保留当前
  账户与 SYSTEM 的 Full Control。
- 外部 Secret 文件有 1 MiB 上限并限制可导入变量。Kubernetes 风格符号链接由部署方负责目标权限与
  原子轮换，Doctor 会报告风险但不会擅自修改用户文件。
- 日志记录 method、模块、status、request id 和耗时，不记录 URL 查询、Header 或正文；已加载的数据库
  URL、Auth、Function 与 S3 Secret 进入统一脱敏集合。
- Doctor 不输出 Secret 值，并为弱值、占位值、权限、所有者和链接风险给出修复建议。
- 脱敏不是数据防泄漏边界。不要把 `.minibase/`、备份或日志放入公开下载目录，也不要把原始诊断包上传
  到公共工单。

## 12. 供应链、发行与 Runtime 完整性

- 部署前验证 EXE SHA-256 与 `release-manifest.json`，并将同 edition
  的许可证文件作为不可拆分发行集合。
- Deno 与 PostgreSQL Runtime 使用版本化缓存和逐文件/目录 manifest；缺失、篡改、额外文件、额外目录
  或符号链接会拒绝启动。
- PostgreSQL 18.4 Linux x64 Runtime 的六个直接包与 37 个传递/许可证包在构建前固定 HTTPS URL、大小和
  SHA-256。除 glibc 边界外，动态依赖和许可证必须解析到固定 package root 内，不允许从构建宿主补齐。
- 依赖版本、发布日期和非 latest 半年策略由 `deno task versions:check` 审计。
- Function 远程依赖必须进入 lockfile 和离线 cache；生产启动不应依赖临时公网解析结果。

## 13. 备份、升级与恢复

- 离线逻辑备份默认不包含项目 Secret；包含 Storage 时正文、大小和 SHA-256 都会验证。
- 本地物理备份和升级副本继承受限权限，升级失败会恢复状态、数据库、本地 Storage 和 Minibase 管理的
  Secret。
- 外部 PostgreSQL 只允许 manifest 明确为数据库/Storage/Secret 全部只读的 format v1→v2 metadata-only
  升级；实际主版本通过只读查询验证，失败时恢复本地 state，外部数据库不被写入。未来数据库写入步骤没有
  事务或可验证快照时会拒绝。
- S3 Storage 可执行当前 manifest 明确为 `read-only` 的 metadata-only upgrade；该路径不列出、读取或
  写入远端对象。声明 `storage: "write"` 的 upgrade plan 必须先持有 root ownership、把所有非控制对象
  流式保存到本地备份并二次复核；写入失败会逐对象恢复和校验，回滚不完整则保留备份并失败关闭。不得手工
  修改 manifest 或 effects 来绕过实际升级步骤与恢复边界。
- S3 reset 只允许在项目停止的维护窗口执行，并在快照前获取 root bucket ownership。删除远端对象前会把
  ownership 控制对象以外的全部原始 backend key 和正文流式保存到本地受限权限 backup，记录大小、MIME
  与 SHA-256，并再次验证远端清单；部分删除或数据库重建失败时会恢复全部 key、逐对象校验并恢复数据库
  物理目录。其他 Minibase writer 持锁时 reset 在远端变更前失败。
- 备份必须加密、离机保存并实际演练恢复；仅成功生成备份不等于可恢复。

## 14. 已知未完成边界

- 未提供不可信多租户或严格单请求 Function 沙箱。
- 未提供跨多个 Minibase 实例的 Auth/Function 分布式限流。
- AWS S3、Cloudflare R2、MinIO 的真实云厂商认证属于可选后续验证；没有凭据时不得把受控协议测试写成
  厂商认证结果。
- S3 reset 的本地整体快照和自动回滚已通过受控协议故障注入。共享 bucket 的 Minibase writer 已有条件
  ownership，但管理员误用 `storage unlock --force` 仍可破坏该边界；命令执行前必须从部署层确认所有
  writer 已停止。当前 metadata-only upgrade 不访问远端对象；通用 Storage
  写入升级快照已在受控协议服务验证。外部 PostgreSQL
  的只读升级同样不代表未来数据库写入已有事务或快照能力。
- 固定 benchmark runner 与 30 分钟双引擎长期稳定性门禁已有仓库证据；Supabase Docker 同机对比尚未
  完成。
- Linux x64 Embedded/Server 已在 WSL2 Ubuntu 24.04.2 上完成原生发行 smoke；macOS arm64/x64
  仍未在真实目标机验证。

这些限制必须保留在兼容矩阵、发布说明和部署评审中，不能通过配置或文档措辞静默弱化。

## 15. 上线安全检查

- [ ] 使用正式服务账户验证发行 SHA-256、manifest、Runtime 缓存和 Doctor。
- [ ] 默认回环监听；公网入口具有 TLS、精确 CORS、精确 trusted proxies 和全局限流。
- [ ] 不需要管理权限的 Function 已设置 `inject_service_role_key = false`。
- [ ] `functions.network.outbound`、allowlist 和 `block_private_networks` 已逐函数评审。
- [ ] Secret、`.minibase/`、日志和备份没有进入仓库、公共目录或宽权限共享盘。
- [ ] Auth 密钥轮换、备份恢复、事件日志保留和撤销流程已经演练。
- [ ] S3、外部 PostgreSQL、多实例和自定义代理没有超出本文件的已验证边界。

发现疑似泄漏时，先停止暴露入口，保留经脱敏的日志和 manifest，轮换受影响的 Auth/S3/数据库/Function
Secret，撤销 Session/Refresh Token，检查数据库与 Storage 一致性，再从已验证备份恢复。不要在完成证据
保全前运行 reset、repair 或手工删除 Runtime/数据目录。
