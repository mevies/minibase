# Minibase 版本策略

审计日期：2026-08-03。

## 规则

- 除 Rust 和数据库引擎外，实际使用的开发和运行环境必须是发布于最近六个月内的稳定版本。
- 除 Rust 和数据库引擎外，不直接使用审计时的 latest 版本。
- 采用已验证的次新稳定补丁版本，并在 toolchain.json 中记录发布时间和审计时 latest。
- 所有版本必须精确固定，不能使用 latest、星号或无上限版本范围。
- Rust 只有在 profiling 证明需要原生代码时才加入，可以使用最新稳定版或记录日期的 nightly。
- PGlite 和 PostgreSQL 属于数据库引擎，可以使用经过兼容测试的最新稳定版。
- Node.js 不属于 Minibase 的开发或运行依赖；Deno 直接解析所需 npm 包。
- Docker Desktop 仅用于同机 Supabase 对比测试，不属于 Minibase 的开发或运行依赖。当前沿用已验证的
  Docker Desktop 4.43.2（Engine 28.3.2、Compose
  2.38.2-desktop.1）；每次证据运行记录实际版本，但不为追逐 latest 或满足半年策略而升级。

## 当前固定版本

| 组件                     | 使用版本 | 审计时 latest | 发布时间   | 结论                 |
| ------------------------ | -------: | ------------: | ---------- | -------------------- |
| Deno                     |    2.9.2 |         2.9.4 | 2026-07-08 | 半年内，非最新版     |
| GitHub Actions Runner    |  2.335.1 |       2.336.0 | 2026-06-09 | 半年内，非最新版     |
| PGlite                   |    0.5.4 |         0.5.4 | 2026-07-02 | 数据库允许最新版     |
| supabase-js 测试         |  2.110.9 |       2.111.0 | 2026-07-27 | 半年内，非最新版     |
| Supabase Server 兼容目标 |    1.4.1 |         1.4.1 | 2026-07-22 | 上游模板测试目标     |
| Supabase CLI 布局        |  2.110.0 |       2.111.0 | 2026-07-27 | 半年内，非最新版     |
| PostgreSQL Runtime       |     18.4 |          18.4 | 2026-05-14 | 数据库允许最新版     |
| postgres.js 驱动         |    3.4.9 |         3.4.9 | 2026-04-05 | 数据库适配器固定版本 |
| @std/path                |    1.1.5 |         1.1.6 | 2026-05-26 | 半年内，非最新版     |
| smol-toml                |    1.7.0 |         1.7.1 | 2026-06-21 | 半年内，非最新版     |
| actions/checkout         |    6.1.0 |         7.0.1 | 2026-07-20 | 半年内，非最新版     |
| actions/cache            |    6.0.0 |         6.1.0 | 2026-06-23 | 半年内，非最新版     |
| actions/upload-artifact  |    7.0.0 |         7.0.1 | 2026-02-26 | 半年内，非最新版     |
| Rust                     | 暂不要求 |    允许最新版 | 不适用     | profiling 后按需引入 |

固定 runner 使用 GitHub Actions Runner 2.335.1 Windows x64 归档，SHA-256 为
`eb65c95277af42bcf3778a799c41359d224ba2a67b4de26b7cea1729b09c803d`。三个 Action 均按完整 Git commit
SHA 引用；其内置 Node.js 24 Runtime 由对应 Action 产物携带，不要求 Minibase 主机安装 Node.js。

Deno 2.9.2 Linux x64 Runtime 使用官方 `deno-x86_64-unknown-linux-gnu.zip`：资产大小为 43,926,976
bytes，更新时间为 `2026-07-08T12:48:38Z`，归档 SHA-256 为
`934d1bd5cb09eaed7f2e4a4fc58208d04a3c5c0fcde9f319d93d735265c67a4a`，解出的 `deno` SHA-256 为
`5bc8a7a4a628360b391ddeac2efac7dec9e670b33156d831bf1e899070655173`。在 GitHub 发行资产网络不可用时，
构建审计可使用同版本官方 `@deno/linux-x64-glibc@2.9.2` npm 平台包取得二进制；其 tarball 大小为
44,958,740 bytes，SHA-1 为 `a7e888d66f106215576a233bedc1062c8db8e9f9`，SHA-512/SRI 与
`toolchain.json` 一致，解出后二进制仍必须匹配上述 GitHub 官方 SHA-256。

Deno 2.9.2 macOS Runtime 同样固定到官方 GitHub 发行资产。x64 的 `deno-x86_64-apple-darwin.zip` 为
42,336,919 bytes，更新时间 `2026-07-08T13:18:58Z`，归档 SHA-256 为
`c953379e5a85a0a30e99aa51b807633e380e809a1181f53e4904d5fa73785bff`，解出的 `deno` SHA-256 为
`201651c6e72bd0df2dbe994b4f8ca0f935631e08c27290a3a92342e02ad0e865`。arm64 的
`deno-aarch64-apple-darwin.zip` 为 37,981,362 bytes，更新时间 `2026-07-08T13:07:40Z`，归档 SHA-256
为 `687ae485168ba73a4f1ee3a954eb4f077eca82f2fefd236a6a83a3889287876c`，解出的 `deno` SHA-256 为
`218ab752ae8f64f0a7822af710886488f15169fdae153a3aada4861f9635b266`。macOS 发行构建必须在对应架构
目标机上使用该精确可执行文件，不能由 Windows/Linux 交叉构建结果替代实机 smoke。

PostgreSQL 18.4 Linux x64 Runtime 在固定的 Ubuntu 24.04.4 LTS 构建环境中生成。`toolchain.json`
精确记录 PGDG 签名密钥指纹 `B97B0AFCAA1A47F044F244A07FCC7D46ACCC4CF8`，以及
`postgresql-18`、`postgresql-client-18`、`libpq5`、`libnuma1`、`liburing2`、`libxslt1.1`
六个直接输入包，以及 37 个传递/许可证包的精确版本、HTTPS 来源、文件名、字节数和 SHA-256。构建只从 这
43 个固定归档解包；除 glibc 运行边界外，`ldd` 解析到清单根目录之外的动态库会立即失败，不能再从
构建宿主的 `/usr/lib` 补齐。包名/文件名重复、清单缺项、来源主机或完整性记录异常也由
`deno task versions:check` 和负向测试拒绝。构建产物的 `release-manifest.json`
记录全部固定包名与版本， 最终许可证文件只读取固定 package root 内的 Debian
copyright；许可证符号链接若解析到该根目录之外会 失败。Runtime 保留 PGDG 的
`usr/lib/postgresql/18`、`usr/share/postgresql/18` 与受控动态库目录布局， 不依赖用户预装 PostgreSQL
或宿主 Ubuntu 包版本。

Supabase CLI 2.110.0 Windows x64 官方发行资产大小为 75,623,772 bytes，GitHub 资产更新时间为
`2026-07-27T17:00:22Z`，SHA-256 为
`b5b617c2b4810df0c23d79eacae8e0715e40ae6406ae5d9fc7706f0353ea5ed4`。CLI 只用于兼容审计和同机 Docker
基准，不属于 Minibase 开发或运行时依赖。

## 执行

运行以下命令检查本机 Deno 版本和 PGlite 锁定版本：

    deno task versions:check

版本升级必须同时更新：

- toolchain.json
- deno.json 或对应 Runtime Manifest
- 本文档
- fixtures/supabase-basic/compatibility.json（涉及 Supabase CLI 或客户端兼容审计时）
- docs/COMPATIBILITY.md（涉及对外兼容声明时）
- 双引擎兼容测试和性能基准结果
- `.github/workflows/fixed-benchmark.yml` 中固定 runner 与 Action commit SHA（涉及 CI 工具链时）
