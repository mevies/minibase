# Embedded 与 Server 发行版选择

Minibase 只有一个代码库和一套 HTTP/Auth/REST/Storage/Functions/Migration
实现。两个发行版的主要差异是 数据库适配器和打包资源，不是两条长期分叉的产品线。

| 维度             | Embedded                                                          | Server                                                            |
| ---------------- | ----------------------------------------------------------------- | ----------------------------------------------------------------- |
| Windows x64 文件 | `minibase-embedded-windows-x64.exe`                               | `minibase-server-windows-x64.exe`                                 |
| Linux x64 文件   | `minibase-embedded-linux-x64`                                     | `minibase-server-linux-x64`                                       |
| 数据库           | 内置 PGlite                                                       | 内置托管 PostgreSQL 18.4，或连接外部 PostgreSQL                   |
| 推荐场景         | 本地开发、桌面应用、个人服务、NAS、中低并发                       | 团队服务、高并发、完整 PostgreSQL 连接与运维                      |
| 并发模型         | 单个 PGlite Worker 串行保护数据库事务；HTTP 和 Functions 仍可并发 | 连接池并行访问原生 PostgreSQL，适合更高并发                       |
| Extension        | 仅限发行版内已验证的 PGlite 能力                                  | 可使用 Runtime 已包含或外部 PostgreSQL 已安装的 Extension         |
| 数据库连接       | 不暴露 PostgreSQL TCP；应用使用 Supabase-compatible HTTP API      | 托管数据库默认仅本机访问；外部 PostgreSQL 可由管理员独立管理      |
| 逻辑复制         | 不支持                                                            | 原生 PostgreSQL 可支持，取决于部署配置                            |
| 部署             | 一个可执行文件和项目目录；默认无外部服务                          | 一个可执行文件可释放版本化 PostgreSQL Runtime；也可配置外部数据库 |
| 默认 Storage     | 本地文件系统                                                      | 本地文件系统                                                      |
| 可选 Storage     | S3-compatible                                                     | S3-compatible                                                     |

## 推荐规则

优先选择 Embedded。它是本地开发、桌面软件、单机工具、个人部署和无需数据库直连场景的默认选项，
部署面最小，移动项目时只需同时保留项目源码和 `.minibase/` 数据。

出现以下任一条件时选择 Server：

- 需要较高的并发写入或稳定的多连接吞吐；
- 需要 PostgreSQL TCP 客户端、数据库管理工具或外部连接池；
- migration 依赖 PGlite 未提供的 Extension；
- 需要原生 PostgreSQL 的逻辑复制、运维工具或既有托管数据库；
- 团队希望把数据库生命周期与应用进程分开管理。

Server EXE 默认使用随产物分发的 PostgreSQL 18.4 Runtime。若配置 `MINIBASE_DATABASE_URL`，则连接外部
PostgreSQL；Minibase 不会因 API 监听公网地址而自动公开托管数据库端口。

## 启动命令

Embedded：

```powershell
.\minibase-embedded-windows-x64.exe start --project . --engine pglite
```

Server（内置托管 PostgreSQL）：

```powershell
.\minibase-server-windows-x64.exe start --project . --engine postgres
```

Linux x64 使用相同参数，只替换可执行文件名并先赋予执行权限：

```sh
chmod 755 ./minibase-server-linux-x64
./minibase-server-linux-x64 start --project . --engine postgres
```

同一项目不能把已有 PGlite 数据目录直接当作 PostgreSQL 数据目录打开。切换引擎必须使用逻辑备份迁移，
并建议先复制项目源码到一个没有 `.minibase/` 的新目标目录。

## 从 Embedded 升级到 Server

以下流程保留 Auth、业务表、RLS 所需数据、序列、Storage
元数据和可选的本地对象内容。源服务和目标服务在 离线导出/恢复期间都必须停止。

1. 停止 Embedded，并导出逻辑备份：

```powershell
.\minibase-embedded-windows-x64.exe stop --project .
.\minibase-embedded-windows-x64.exe backup export --project . --engine pglite `
  --output .minibase\backups\to-server --include-storage
```

2. 将项目源码复制到新的 Server 项目目录，不复制旧的
   `.minibase/`。为避免相对路径歧义，记下上一步备份的 绝对路径。

3. 在新目录恢复到 PostgreSQL：

```powershell
.\minibase-server-windows-x64.exe doctor --project . --engine postgres
.\minibase-server-windows-x64.exe backup restore --project . --engine postgres `
  --input C:\absolute\path\to\source\.minibase\backups\to-server
```

若目标已经初始化且确认要覆盖，追加 `--force`。Minibase 会先创建安全备份；没有 `--force`
时不会静默覆盖 已有数据。

`--include-storage` 会从当前配置的 Local 或 S3-compatible 后端流式导出对象正文；恢复时写入目标项目
当前配置的后端，因此可以执行 Local→S3、S3→Local 或 S3→S3 迁移。S3 目标必须使用空项目和不存在的
同名对象；当前 `--force` 安全重置与自动 upgrade 仍只支持可完整物理备份的本地 Storage，不会以逻辑
备份可用为由静默覆盖远程对象。

4. 启动并验证：

```powershell
.\minibase-server-windows-x64.exe start --project . --engine postgres
.\minibase-server-windows-x64.exe status --project . --json
```

迁移完成后至少验证已有用户登录、RLS 查询、Function 调用和 Storage 下载。保留原 Embedded 项目和逻辑
备份，直到 Server 验收完成。

能力差异和未兼容项见[兼容性矩阵](./COMPATIBILITY.md)，性能测量口径见[性能指南](./PERFORMANCE.md)，
正式运行前检查[生产部署](./DEPLOYMENT.md)与[第三方许可证索引](./THIRD_PARTY_LICENSES.md)。
