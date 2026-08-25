# Minibase 故障排查

故障排查遵循“先只读诊断、再备份、最后显式修复”。不要通过删除 `.minibase/`、修改 migration、跳过
哈希校验或直接编辑状态文件来让错误暂时消失。

## 1. 最小诊断顺序

```powershell
.\minibase-embedded-windows-x64.exe version --json
.\minibase-embedded-windows-x64.exe status --project C:\apps\my-project --json
.\minibase-embedded-windows-x64.exe doctor --project C:\apps\my-project --json
```

如果服务仍运行，再请求 `/health/live` 和 `/health/ready`。保存命令退出码、Doctor
JSON、错误发生时间、 edition/engine、`release-manifest.json`
和相关日志。提交诊断材料前删除项目路径中的个人信息；不要上传 Secrets、JWT、数据库 URL、S3
凭据、`.minibase/secrets.json` 或完整用户数据。

## 2. 服务无法启动

- `version --json` 失败：确认 EXE 未被拦截或混用，并重新校验发行 SHA-256。
- 端口占用：Doctor 会报告 API 或 managed PostgreSQL 端口；停止冲突进程或显式更换端口，不要随机开放
  新的公网监听。
- Runtime 校验失败：按错误给出的精确版本化缓存目录删除并重新启动，让 Minibase 从已签名发行资源重新
  释放；不要只替换单个 DLL 或 `postgres.exe`。
- 数据格式或数据库主版本不兼容：停止服务并按[升级与回滚](./UPGRADING.md)处理。
- Function 依赖缺失：在允许访问锁定依赖源的环境运行
  `minibase functions cache --project <path>`，随后重新运行 Doctor。

## 3. live 正常但 ready 返回 503

`/health/ready` 会分别报告数据库、Migration、Storage 和 Functions。按失败组件处理：

- database：检查磁盘、数据目录权限、外部 `MINIBASE_DATABASE_URL` 可达性或 managed Runtime；不要在
  服务运行时复制数据库目录。
- migrations：运行 `minibase migration check --project <path> --engine <engine> --json`，核对原始
  SQL 与已记录 SHA-256。
- storage：先运行 `minibase storage check --project <path> --json`，只生成报告。
- functions：检查入口路径、`deno.json`、`deno.lock`、依赖缓存和启动日志。

依赖故障时 `stop` 仍依据 liveness 工作，不需要先让 ready 恢复。

## 4. Migration 中断或失败

事务型 migration 在数据库回滚后会以相同、未修改的 SQL 安全重试。显式 `-- minibase:no-transaction` 的
migration 可能已经产生部分副作用，Minibase 会阻止自动重放。

先人工核对数据库，再执行：

```powershell
.\minibase-server-windows-x64.exe migration recover `
  --project C:\apps\my-project --engine postgres `
  --migration-version 20260801000000 --force --json
```

若原 migration 文件或 SHA-256 已变化，恢复会拒绝。不要编辑旧 migration 来适配当前数据库；创建新的
补偿 migration，并保留失败记录。

## 5. Storage 不一致

先生成报告：

```powershell
.\minibase-embedded-windows-x64.exe storage check --project C:\apps\my-project --json
```

只有在保存当前备份并审阅报告后才运行：

```powershell
.\minibase-embedded-windows-x64.exe storage repair `
  --project C:\apps\my-project --force --json
```

本地修复会处理缺失、孤立、临时对象和大小不一致。S3 后端可执行 check/repair，但真实服务双实现验收尚未
完成。停止项目后，S3 reset 会在 `.minibase/backups/reset-*` 中保存数据库物理目录、全部远端原始 key
及正文；删除前清单变化会直接中止，部分删除或 migrations/seed 重建失败会自动恢复数据库和远端对象并
校验大小与 SHA-256。自动回滚失败时不要再次 reset 或删除该 backup，应保存 CLI 错误和 manifest 后人工
恢复。服务、reset、逻辑恢复和 repair 都会获取 root bucket 条件 ownership；如果启动提示另一个 writer
持锁，先检查所有使用该 endpoint/root bucket 的部署。只有确认它们全部停止后才可执行：

```powershell
.\minibase-embedded-windows-x64.exe storage unlock `
  --project C:\apps\my-project --force --json
```

不要用该命令处理仍在运行的远端实例；它会使旧实例的后续写入失败并允许新实例接管。当前 metadata-only
upgrade 不访问远端对象。声明会写 Storage 的升级会先持有 ownership、生成并复核远端整体快照；失败时
自动恢复。若错误提示远程回滚不完整，保留给出的 `upgrade-*` 备份目录，不要 reset、删除 ownership 或
手工继续升级，先按 manifest 中的 backend key、大小和 SHA-256 核对远端对象。

## 6. Edge Function 失败或超时

按函数查看轮换日志：

```powershell
.\minibase-embedded-windows-x64.exe functions logs `
  --project C:\apps\my-project --function hello --tail 200 --json
```

常见原因包括 TypeScript/import graph 错误、锁文件未缓存、JWT 校验、出站 allowlist、DNS/TLS、请求体
上限和执行超时。超时或 `Deno.exit` 会回收命中的 Function 进程并在后续并发请求中补充 PID；另一个
进程可继续服务，但这不是不可信代码的单请求操作系统沙箱。

不要把 Service Role Key、OpenAI Key 或完整 Authorization Header 加入调试日志。需要重现出站问题时，
优先使用受控测试 endpoint，并核对代理和 `NO_PROXY`。

## 7. Auth 与 Token 问题

- 确认客户端时钟、Token 发行时间和 `kid`。
- 使用 `minibase auth keys list --project <path> --json` 只查看元数据。
- 密钥轮换前后保留旧验证密钥，确认旧 Session 已过预期窗口后再删除。
- 外部 `MINIBASE_AUTH_JWT_SECRET` 模式不支持内部 ES256 keyring 管理命令。

详细流程见[Auth 密钥](./AUTH_KEYS.md)和[Auth 安全](./AUTH_SECURITY.md)。

## 8. 备份或恢复失败

- 验证输入目录、manifest、对象大小和 SHA-256；不要手工修正 manifest。
- 没有 `--force` 时，非空目标会拒绝覆盖；使用 `--force` 前保存目标的独立安全备份。
- 同名 S3 对象会在任何数据库导入或对象写入前拒绝。
- 补偿回滚失败会要求运行一致性检查，不能把部分恢复报告为成功。

跨引擎恢复步骤见[发行版选择](./EDITIONS.md)。

## 9. 磁盘、权限与损坏

ENOSPC、只读目录或 ACL 拒绝应先由运维层恢复容量/权限，再重新运行 Doctor。数据控制文件损坏时 Doctor
只做只读结构诊断，不会自动启动、reset 或修改数据库。保留原目录的逐文件副本，在副本上调查；不要对
唯一副本执行破坏性修复。

## 10. 安全地提交问题

最小问题包应包含：Minibase 版本、commit/manifest、edition、engine、操作系统、精确命令（移除
Secret）、 退出码、Doctor JSON、ready 组件结果和经脱敏的相关日志。若问题涉及性能，再附固定 runner
原始报告和 硬件指纹；开发机单次耗时不能证明回退。
